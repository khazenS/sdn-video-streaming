"""Ryu (OpenFlow 1.3) controller: SDN load balancer for DASH video streaming.

What it does:
  1. Discovers switch-to-switch links with LLDP (--observe-links).
  2. Learns where each host is from its first packet.
  3. Answers ARP itself (proxy ARP), so nothing is ever flooded. The network
     has loops and no STP, so flooding would cause a broadcast storm.
  4. Routes ordinary IP traffic over the shortest path (networkx).
  5. Clients only know a virtual IP (VIP). For each new client the controller
     picks a server and installs NAT rules along the path.
  6. The server selection policy is set with LB_MODE: hop | load | bw | delay | combo.

Run:
    LB_MODE=combo ryu-manager --observe-links sdn_controller.py
then in another terminal:
    sudo python3 video_topo.py
"""
import os
import sys
import time

import networkx as nx
from ryu.base import app_manager
from ryu.controller import ofp_event
from ryu.lib import hub
from ryu.controller.handler import (CONFIG_DISPATCHER, MAIN_DISPATCHER,
                                    DEAD_DISPATCHER, set_ev_cls)
from ryu.lib.packet import packet, ethernet, arp, ipv4, icmp, in_proto, ether_types
from ryu.ofproto import ofproto_v1_3
from ryu.topology import event as topo_event

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from net_config import SWITCHES, SERVERS, LINKS   # noqa: E402

HOSTS = dict({'h%d' % i: '10.0.0.%d' % i for i in range(1, 10)}, **SERVERS)

# (u, v) -> link capacity in Mbps. Links are full duplex, so both directions get a key.
CAPACITY = {}
for a, b, bw, _ in LINKS:
    CAPACITY[(a, b)] = CAPACITY[(b, a)] = bw

MONITOR_INTERVAL = 2      # seconds between port stats requests
DELAY_INTERVAL = 5        # seconds between delay measurement rounds
WEIGHTS = {'hop': 0.25, 'delay': 0.25, 'bw': 0.25, 'load': 0.25}   # combo mode
PROBE_TYPE = 0x88b5       # ethertype of our probe packets (reserved for experiments)

# The only address clients know. It has no real interface, so ARP is answered
# with a made-up MAC.
VIP = '10.0.0.100'
VIP_MAC = '00:00:00:00:00:fe'

MODE = os.environ.get('LB_MODE', 'hop')


def mac_of(ip):
    """10.0.0.11 -> 00:00:00:00:00:0b (last MAC byte = last IP octet)."""
    return '00:00:00:00:00:%02x' % int(ip.split('.')[-1])


class SDNController(app_manager.RyuApp):
    OFP_VERSIONS = [ofproto_v1_3.OFP_VERSION]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.dpid_to_name = {d: n for n, d in SWITCHES.items()}
        self.ip_to_host = {ip: n for n, ip in HOSTS.items()}
        self.mac_to_host = {mac_of(ip): n for n, ip in HOSTS.items()}

        self.datapaths = {}       # dpid -> datapath
        self.port = {}            # (u, v) -> port on u that faces v
        self.trunk_ports = set()  # (dpid, port) of switch-to-switch ports
        self.host_loc = {}        # host -> (switch, port)

        # Sessions
        self.sessions = {srv: 0 for srv in SERVERS}   # server -> active sessions
        self.active = {}          # client -> server it is currently streaming from

        # Port statistics
        self.last_bytes = {}      # (dpid, port) -> (tx_bytes, rx_bytes, time)
        self.rate = {}            # (dpid, port) -> (tx Mbps, rx Mbps)
        hub.spawn(self._monitor)

        # Delay measurement
        self.echo_sent = {}       # dpid -> time our echo request was sent
        self.echo = {}            # dpid -> controller <-> switch round trip (s)
        self.probe_sent = {}      # (u, v) -> time the probe/ping was sent
        self.delay = {}           # (u, v) -> one-way link delay (s)
        if MODE in ('delay', 'combo'):
            hub.spawn(self._delay_monitor)
        self.logger.info('LB_MODE = %s', MODE)

    # ------------------------------------------------------------------
    # Switch connection
    # ------------------------------------------------------------------
    @set_ev_cls(ofp_event.EventOFPSwitchFeatures, CONFIG_DISPATCHER)
    def switch_features_handler(self, ev):
        # Table-miss rule: send unmatched packets to the controller
        dp = ev.msg.datapath
        ofp, parser = dp.ofproto, dp.ofproto_parser
        actions = [parser.OFPActionOutput(ofp.OFPP_CONTROLLER, ofp.OFPCML_NO_BUFFER)]
        self._add_flow(dp, 0, parser.OFPMatch(), actions)

    @set_ev_cls(ofp_event.EventOFPStateChange, [MAIN_DISPATCHER, DEAD_DISPATCHER])
    def state_change_handler(self, ev):
        dp = ev.datapath
        if dp.id is None:
            return
        if ev.state == MAIN_DISPATCHER:
            self.datapaths[dp.id] = dp
            self.logger.info('Switch connected: %s', self.dpid_to_name.get(dp.id, dp.id))
        else:
            self.datapaths.pop(dp.id, None)

    def _add_flow(self, dp, priority, match, actions, idle=0, cookie=0, flags=0):
        ofp, parser = dp.ofproto, dp.ofproto_parser
        inst = [parser.OFPInstructionActions(ofp.OFPIT_APPLY_ACTIONS, actions)]
        dp.send_msg(parser.OFPFlowMod(datapath=dp, priority=priority, match=match,
                                      instructions=inst, idle_timeout=idle,
                                      cookie=cookie, flags=flags))

    def _packet_out(self, dp, in_port, actions, data):
        parser, ofp = dp.ofproto_parser, dp.ofproto
        dp.send_msg(parser.OFPPacketOut(datapath=dp, buffer_id=ofp.OFP_NO_BUFFER,
                                        in_port=in_port, actions=actions, data=data))

    # ------------------------------------------------------------------
    # Topology: switch links from LLDP, hosts from their first packet
    # ------------------------------------------------------------------
    @set_ev_cls(topo_event.EventLinkAdd)
    def link_add_handler(self, ev):
        src, dst = ev.link.src, ev.link.dst
        u, v = self.dpid_to_name[src.dpid], self.dpid_to_name[dst.dpid]
        if (u, v) not in self.port:
            self.logger.info('Link found: %s:%d -> %s:%d', u, src.port_no, v, dst.port_no)
        self.port[(u, v)] = src.port_no
        self.trunk_ports.add((src.dpid, src.port_no))

    def _learn_host(self, dpid, in_port, mac):
        host = self.mac_to_host.get(mac)
        # A packet arriving on a trunk port came through another switch,
        # so the host is not attached here.
        if host is None or (dpid, in_port) in self.trunk_ports:
            return
        sw = self.dpid_to_name[dpid]
        if self.host_loc.get(host) != (sw, in_port):
            self.logger.info('Host found: %s -> %s:%d', host, sw, in_port)
            self.host_loc[host] = (sw, in_port)
            self.port[(sw, host)] = in_port

    def _graph(self):
        """Network map: nodes are switches and hosts, edges are links."""
        g = nx.Graph()
        for u, v in self.port:
            if u in SWITCHES and v in SWITCHES:
                g.add_edge(u, v)
        for host, (sw, _) in self.host_loc.items():
            g.add_edge(host, sw)
        return g

    # ------------------------------------------------------------------
    # PacketIn
    # ------------------------------------------------------------------
    @set_ev_cls(ofp_event.EventOFPPacketIn, MAIN_DISPATCHER)
    def packet_in_handler(self, ev):
        msg = ev.msg
        dp = msg.datapath
        in_port = msg.match['in_port']
        pkt = packet.Packet(msg.data)
        eth = pkt.get_protocol(ethernet.ethernet)

        if eth.ethertype == ether_types.ETH_TYPE_LLDP:
            return                      # handled by Ryu's topology module
        if eth.ethertype == PROBE_TYPE:
            self._probe_in(msg.data[14:])   # skip the 14-byte Ethernet header
            return

        self._learn_host(dp.id, in_port, eth.src)

        arp_pkt = pkt.get_protocol(arp.arp)
        if arp_pkt:
            self._handle_arp(dp, in_port, eth, arp_pkt)
            return

        ip = pkt.get_protocol(ipv4.ipv4)
        ping = pkt.get_protocol(icmp.icmp)
        if ip and ping and ping.type == icmp.ICMP_ECHO_REPLY and ip.dst == VIP:
            self._ping_in(ip.src)       # a server answering our delay ping
            return
        # Never flood: the network has loops and no STP.
        # IPv4 arriving on a trunk port raced ahead of the rules being installed;
        # drop it and let TCP retransmit.
        if ip is None or (dp.id, in_port) in self.trunk_ports:
            return
        if ip.dst == VIP:
            self._handle_vip(dp, in_port, ip.src, msg.data)
        elif ip.dst in self.ip_to_host:
            self._handle_ip(dp, in_port, ip.src, ip.dst, msg.data)

    def _handle_arp(self, dp, in_port, eth, req):
        """Proxy ARP: answer 'who has X?' directly instead of flooding it."""
        if req.opcode != arp.ARP_REQUEST:
            return
        if req.dst_ip == VIP:
            mac = VIP_MAC
        elif req.dst_ip in self.ip_to_host:
            mac = mac_of(req.dst_ip)
        else:
            return
        reply = packet.Packet()
        reply.add_protocol(ethernet.ethernet(dst=eth.src, src=mac,
                                             ethertype=ether_types.ETH_TYPE_ARP))
        reply.add_protocol(arp.arp(opcode=arp.ARP_REPLY, src_mac=mac, src_ip=req.dst_ip,
                                   dst_mac=req.src_mac, dst_ip=req.src_ip))
        reply.serialize()
        actions = [dp.ofproto_parser.OFPActionOutput(in_port)]
        self._packet_out(dp, dp.ofproto.OFPP_CONTROLLER, actions, reply.data)

    # ------------------------------------------------------------------
    # Plain IP routing: shortest path
    # ------------------------------------------------------------------
    def _handle_ip(self, dp, in_port, src_ip, dst_ip, data):
        src, dst = self.ip_to_host.get(src_ip), self.ip_to_host[dst_ip]
        g = self._graph()
        if src not in g or dst not in g or not nx.has_path(g, src, dst):
            self.logger.warning('%s -> %s: no path (host location may be unknown)', src, dst)
            return
        path = nx.shortest_path(g, src, dst)
        self.logger.info('Path: %s', '-'.join(path))
        self._install_path(path, src_ip, dst_ip)
        self._install_path(path[::-1], dst_ip, src_ip)
        # Re-inject the first packet; the new rules carry it.
        actions = [dp.ofproto_parser.OFPActionOutput(dp.ofproto.OFPP_TABLE)]
        self._packet_out(dp, in_port, actions, data)

    def _install_path(self, path, src_ip, dst_ip):
        """path = [src_host, sw1, ..., swN, dst_host].

        Rules are installed starting from the switch nearest the destination,
        so a packet already in flight never reaches a switch without a rule.
        """
        for i in range(len(path) - 2, 0, -1):
            sw = path[i]
            out_port = self.port[(sw, path[i + 1])]
            dp = self.datapaths[SWITCHES[sw]]
            parser = dp.ofproto_parser
            match = parser.OFPMatch(eth_type=ether_types.ETH_TYPE_IP,
                                    ipv4_src=src_ip, ipv4_dst=dst_ip)
            actions = [parser.OFPActionOutput(out_port)]
            self._add_flow(dp, 10, match, actions, idle=30)

    # ------------------------------------------------------------------
    # VIP: server selection + NAT
    # ------------------------------------------------------------------
    def _handle_vip(self, dp, in_port, src_ip, data):
        client = self.ip_to_host.get(src_ip)
        if client is None or client in SERVERS:
            return
        # Several packets from the same client can arrive before the rules are
        # installed. Reuse the existing assignment so the session is counted once.
        server = self.active.get(client) or self._choose_server(client)
        g = self._graph()
        if client not in g or server not in g:
            self.logger.warning('%s -> %s: no path', client, server)
            return
        path = nx.shortest_path(g, client, server)
        if client not in self.active:
            self.active[client] = server
            self.sessions[server] += 1
        self.logger.info('VIP: %s -> %s  path %s  sessions %s',
                         client, server, '-'.join(path), self.sessions)
        self._install_vip(path)
        actions = [dp.ofproto_parser.OFPActionOutput(dp.ofproto.OFPP_TABLE)]
        self._packet_out(dp, in_port, actions, data)

    def _path_free(self, path):
        """Bottleneck free capacity (Mbps) of path in the server -> client direction."""
        return min(self._free(path[i + 1], path[i]) for i in range(len(path) - 1))

    def _path_delay(self, path, default):
        """Sum of measured link delays (s) along path, excluding the client link
        (it is shared by all of the client's paths). Unmeasured links count as default."""
        return sum(self.delay.get((path[i], path[i + 1]), default)
                   for i in range(1, len(path) - 1))

    def _choose_server(self, client):
        g = self._graph()
        hops = {}
        for srv in SERVERS:
            if srv in g:                        # skip servers not discovered yet
                hops[srv] = nx.shortest_path_length(g, client, srv)
        self.logger.info('HOP %s: %s', client, hops)

        if MODE == 'bw':
            # Largest bottleneck free capacity
            free = {srv: self._path_free(nx.shortest_path(g, client, srv)) for srv in hops}
            self.logger.info('BW %s: %s', client,
                             {srv: round(f, 1) for srv, f in free.items()})
            return max(free, key=free.get)
        if MODE == 'combo':
            # Normalise each metric to 0..1 by dividing by its maximum, make
            # "smaller is better" for all of them, and take the weighted sum.
            delay, free = {}, {}
            for srv in hops:
                path = nx.shortest_path(g, client, srv)
                # Unmeasured links count as 0 (only happens before the first round)
                delay[srv] = self._path_delay(path, 0)
                free[srv] = self._path_free(path)
            # "or 1" avoids division by zero when all values are 0 (e.g. no sessions yet)
            max_hop = max(hops.values())
            max_delay = max(delay.values()) or 1
            max_free = max(free.values()) or 1
            max_sess = max(self.sessions[srv] for srv in hops) or 1
            score = {}
            for srv in hops:
                score[srv] = (WEIGHTS['hop'] * hops[srv] / max_hop
                              + WEIGHTS['delay'] * delay[srv] / max_delay
                              + WEIGHTS['bw'] * (1 - free[srv] / max_free)
                              + WEIGHTS['load'] * self.sessions[srv] / max_sess)
            for srv in hops:
                self.logger.info('COMBO %s %s: hop %d  delay %.1f ms  bw %.1f Mbps  '
                                 'sessions %d  -> score %.2f', client, srv, hops[srv],
                                 delay[srv] * 1000, free[srv], self.sessions[srv], score[srv])
            return min(score, key=score.get)
        if MODE == 'delay':
            # Smallest total path delay; unmeasured links make a path unusable
            delay = {srv: self._path_delay(nx.shortest_path(g, client, srv), float('inf'))
                     for srv in hops}
            self.logger.info('DELAY %s (ms): %s', client,
                             {srv: round(d * 1000, 1) for srv, d in delay.items()})
            return min(delay, key=delay.get)
        if MODE == 'load':
            # Fewest sessions; ties broken by hop count
            return min(hops, key=lambda srv: (self.sessions[srv], hops[srv]))
        # hop (default): ties go to the first server in SERVERS order
        return min(hops, key=hops.get)

    def _install_vip(self, path):
        """path = [client, sw1, ..., swN, server]. NAT happens only on swN,
        the switch facing the server; the other switches just forward."""
        client, server = path[0], path[-1]
        c_ip, s_ip = HOSTS[client], HOSTS[server]
        for i in range(len(path) - 2, 0, -1):
            sw = path[i]
            dp = self.datapaths[SWITCHES[sw]]
            parser = dp.ofproto_parser
            nat = (i == len(path) - 2)
            to_server = self.port[(sw, path[i + 1])]
            to_client = self.port[(sw, path[i - 1])]

            # Forward direction: client -> VIP
            match = parser.OFPMatch(eth_type=ether_types.ETH_TYPE_IP,
                                    ipv4_src=c_ip, ipv4_dst=VIP)
            actions = []
            if nat:     # rewrite destination VIP -> real server
                actions += [parser.OFPActionSetField(eth_dst=mac_of(s_ip)),
                            parser.OFPActionSetField(ipv4_dst=s_ip)]
            actions.append(parser.OFPActionOutput(to_server))
            if nat:
                # Only this rule reports its removal. If every switch on the path
                # did, one session would be decremented several times.
                self._add_flow(dp, 20, match, actions, idle=10,
                               cookie=int(c_ip.split('.')[-1]),
                               flags=dp.ofproto.OFPFF_SEND_FLOW_REM)
            else:
                self._add_flow(dp, 20, match, actions, idle=10)

            # Reverse direction: server -> client
            if nat:     # the server replies from its own IP; rewrite source back to VIP
                match = parser.OFPMatch(eth_type=ether_types.ETH_TYPE_IP,
                                        ipv4_src=s_ip, ipv4_dst=c_ip)
                actions = [parser.OFPActionSetField(eth_src=VIP_MAC),
                           parser.OFPActionSetField(ipv4_src=VIP)]
            else:       # already rewritten to VIP by the NAT switch
                match = parser.OFPMatch(eth_type=ether_types.ETH_TYPE_IP,
                                        ipv4_src=VIP, ipv4_dst=c_ip)
                actions = []
            actions.append(parser.OFPActionOutput(to_client))
            self._add_flow(dp, 20, match, actions, idle=10)

    @set_ev_cls(ofp_event.EventOFPFlowRemoved, MAIN_DISPATCHER)
    def _flow_removed(self, ev):
        """The NAT rule idled out: the client's session has ended."""
        client = self.ip_to_host.get('10.0.0.%d' % ev.msg.cookie)
        server = self.active.pop(client, None)
        if server is None:
            return
        self.sessions[server] -= 1
        self.logger.info('Session ended: %s (%s)  sessions %s',
                         client, server, self.sessions)

    # ------------------------------------------------------------------
    # Port statistics -> link usage -> free capacity
    # ------------------------------------------------------------------
    def _monitor(self):
        while True:
            for dp in list(self.datapaths.values()):
                parser = dp.ofproto_parser
                dp.send_msg(parser.OFPPortStatsRequest(dp, 0, dp.ofproto.OFPP_ANY))
            hub.sleep(MONITOR_INTERVAL)

    @set_ev_cls(ofp_event.EventOFPPortStatsReply, MAIN_DISPATCHER)
    def _port_stats_reply(self, ev):
        """Counters are cumulative: rate = difference / elapsed time."""
        dpid, now = ev.msg.datapath.id, time.time()
        for st in ev.msg.body:
            key = (dpid, st.port_no)
            prev = self.last_bytes.get(key)
            self.last_bytes[key] = (st.tx_bytes, st.rx_bytes, now)
            if prev is None:
                continue
            dt = now - prev[2]
            self.rate[key] = ((st.tx_bytes - prev[0]) * 8 / dt / 1e6,
                              (st.rx_bytes - prev[1]) * 8 / dt / 1e6)

    def _used(self, u, v):
        """Current traffic (Mbps) in the u -> v direction.

        Always read on the switch-side port (hosts have no counters): tx of u's
        port towards v if u is a switch, otherwise rx of v's port towards u.
        """
        if u in SWITCHES:
            tx, _ = self.rate.get((SWITCHES[u], self.port[(u, v)]), (0, 0))
            return tx
        _, rx = self.rate.get((SWITCHES[v], self.port[(v, u)]), (0, 0))
        return rx

    def _free(self, u, v):
        """Free capacity (Mbps) in the u -> v direction."""
        return max(CAPACITY[(u, v)] - self._used(u, v), 0)

    # ------------------------------------------------------------------
    # Delay measurement
    #   switch-switch link: probe -> link = total - echo(u)/2 - echo(v)/2
    #   switch-server link: ping  -> link = (total - echo(sw)) / 2
    #   client link: not measured (shared by all of a client's paths)
    # echo(x) = controller <-> switch round trip, subtracted to remove the
    # control channel from the measurement.
    # ------------------------------------------------------------------
    def _delay_monitor(self):
        while True:
            for dpid, dp in list(self.datapaths.items()):
                self.echo_sent[dpid] = time.time()
                dp.send_msg(dp.ofproto_parser.OFPEchoRequest(dp, data=b'delay'))
            for u, v in list(self.port):
                if u in SWITCHES and v in SWITCHES:
                    self._send_probe(u, v)
                elif u in SWITCHES and v in SERVERS:
                    self._send_ping(u, v)
            hub.sleep(DELAY_INTERVAL)
            self.logger.info('Link delay (ms): %s', ', '.join(
                '%s-%s %.1f' % (u, v, d * 1000)
                for (u, v), d in sorted(self.delay.items()) if u in SWITCHES))

    @set_ev_cls(ofp_event.EventOFPEchoReply, MAIN_DISPATCHER)
    def _echo_reply(self, ev):
        dpid = ev.msg.datapath.id
        # Ryu sends its own keepalive echoes; only use ours (data=b'delay').
        if ev.msg.data == b'delay' and dpid in self.echo_sent:
            self.echo[dpid] = time.time() - self.echo_sent[dpid]

    def _send_probe(self, u, v):
        """Send a probe out of u's port towards v. v has no rule for it, so it
        comes back to the controller as a packet-in."""
        dp = self.datapaths.get(SWITCHES[u])
        if dp is None:
            return
        p = packet.Packet()
        p.add_protocol(ethernet.ethernet(dst='ff:ff:ff:ff:ff:ff', src=VIP_MAC,
                                         ethertype=PROBE_TYPE))
        p.add_protocol(('%s,%s' % (u, v)).encode())     # payload, e.g. "e1,e2"
        p.serialize()
        self.probe_sent[(u, v)] = time.time()
        actions = [dp.ofproto_parser.OFPActionOutput(self.port[(u, v)])]
        self._packet_out(dp, dp.ofproto.OFPP_CONTROLLER, actions, p.data)

    def _probe_in(self, payload):
        # Strip the zero padding added to reach the minimum Ethernet frame size
        u, v = bytes(payload).rstrip(b'\x00').decode().split(',')
        total = time.time() - self.probe_sent[(u, v)]
        echo_u, echo_v = self.echo.get(SWITCHES[u]), self.echo.get(SWITCHES[v])
        if echo_u is None or echo_v is None:
            return                      # echo not measured yet; next round
        self.delay[(u, v)] = max(total - echo_u / 2 - echo_v / 2, 0)

    def _send_ping(self, sw, srv):
        """Ping srv out of sw's port. A server is not a switch and cannot return
        a probe, but it answers a ping; with source = VIP the reply comes back
        to the controller via the same switch."""
        dp = self.datapaths.get(SWITCHES[sw])
        if dp is None:
            return
        srv_ip = SERVERS[srv]
        p = packet.Packet()
        p.add_protocol(ethernet.ethernet(dst=mac_of(srv_ip), src=VIP_MAC,
                                         ethertype=ether_types.ETH_TYPE_IP))
        p.add_protocol(ipv4.ipv4(src=VIP, dst=srv_ip, proto=in_proto.IPPROTO_ICMP))
        p.add_protocol(icmp.icmp(type_=icmp.ICMP_ECHO_REQUEST, data=icmp.echo(id_=1, seq=1)))
        p.serialize()
        self.probe_sent[(sw, srv)] = time.time()
        actions = [dp.ofproto_parser.OFPActionOutput(self.port[(sw, srv)])]
        self._packet_out(dp, dp.ofproto.OFPP_CONTROLLER, actions, p.data)

    def _ping_in(self, srv_ip):
        srv = self.ip_to_host.get(srv_ip)
        if srv not in self.host_loc:
            return
        sw = self.host_loc[srv][0]
        sent, echo = self.probe_sent.get((sw, srv)), self.echo.get(SWITCHES[sw])
        if sent is None or echo is None:
            return
        total = time.time() - sent
        # The link is crossed twice (there and back)
        self.delay[(sw, srv)] = self.delay[(srv, sw)] = max((total - echo) / 2, 0)

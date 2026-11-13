# Technical deep dive

The [README](../README.md) tells the story. This document is for readers who want to know exactly how each piece works, with the relevant code next to the explanation. Everything quoted here comes from the files in this repository.

**Contents**

1. [Architecture](#1-architecture)
2. [Learning the topology](#2-learning-the-topology)
3. [Proxy ARP: a network that never floods](#3-proxy-arp-a-network-that-never-floods)
4. [Routing and the order of rule installation](#4-routing-and-the-order-of-rule-installation)
5. [Virtual IP and NAT](#5-virtual-ip-and-nat)
6. [Counting sessions with FlowRemoved](#6-counting-sessions-with-flowremoved)
7. [Measuring free bandwidth](#7-measuring-free-bandwidth)
8. [Measuring link delay](#8-measuring-link-delay)
9. [The five selection policies](#9-the-five-selection-policies)
10. [The video and the client](#10-the-video-and-the-client)
11. [Experiment method](#11-experiment-method)
12. [Results in full](#12-results-in-full)
13. [Known limitations](#13-known-limitations)

---

## 1. Architecture

```
                 +-----------------------------+
                 |  sdn_controller.py (Ryu)    |   control plane
                 |  map · ARP · paths · NAT    |
                 |  policies · measurements    |
                 +--------------+--------------+
                                | OpenFlow 1.3 (TCP 6653)
        +-----------+-----------+-----------+-----------+
        |           |           |           |           |
       e1          e2          e3        c1, c2        d1      data plane (Open vSwitch)
        |           |           |           |           |
     h1-h3       h4-h6       h7-h9        srv3        srv4     hosts (Mininet namespaces)
     srv1                    srv2
```

| Layer | Tool | Role |
|---|---|---|
| Emulation | Mininet 2.3 + `tc`/netem | hosts, links with a bandwidth limit and a delay |
| Switches | Open vSwitch 2.17 | forward packets according to rules pushed by the controller |
| Controller | Ryu 4.34, Python 3.10 | all decisions |
| Graph | networkx | shortest paths on the discovered topology |
| Video | ffmpeg (encode), `python3 -m http.server` (serve) | MPEG-DASH segments in three qualities |
| Client | `dash_client.py` | adaptive bitrate logic and quality measurements |

The topology is defined once, in [`net_config.py`](../net_config.py). Both the Mininet script and the controller import it, so they cannot disagree about a link's capacity:

```python
# (node 1, node 2, bandwidth in Mbps, delay)
LINKS = [
    ('e1', 'srv1', 10, '15ms'),
    ('e3', 'srv2', 10, '2ms'),
    ...
    ('c1', 'srv3', 20, '1ms'),
    ('c2', 'd1', 60, '30ms'),
    ('d1', 'srv4', 100, '1ms'),
]
```

The controller needs the capacity from this file because a switch has no idea that `tc` is shaping its port. What the controller does *not* take from the file is how much of that capacity is in use, or how long a link really takes. Those are measured (sections 7 and 8).

## 2. Learning the topology

**Switch-to-switch links** come from LLDP. Ryu's topology module (enabled with `--observe-links`) sends an LLDP frame out of every switch port with a packet-out; the neighbouring switch has no rule for it and hands it back with a packet-in. Sent from `e1` port 5 and received on `e2` port 4 means those two ports are connected. The controller only has to listen for the result:

```python
@set_ev_cls(topo_event.EventLinkAdd)
def link_add_handler(self, ev):
    src, dst = ev.link.src, ev.link.dst
    u, v = self.dpid_to_name[src.dpid], self.dpid_to_name[dst.dpid]
    ...
    self.port[(u, v)] = src.port_no
    self.trunk_ports.add((src.dpid, src.port_no))
```

`self.port[(u, v)]` answers the question the rest of the controller asks all the time: *which port of `u` leads to `v`?*

**Hosts** do not speak LLDP. They are learned from the first packet they send. The one rule that matters: a packet that arrives on a trunk port has already travelled through another switch, so its sender is not attached here.

```python
def _learn_host(self, dpid, in_port, mac):
    host = self.mac_to_host.get(mac)
    if host is None or (dpid, in_port) in self.trunk_ports:
        return
    ...
    self.host_loc[host] = (sw, in_port)
    self.port[(sw, host)] = in_port
```

From these two sources `_graph()` builds a networkx graph on demand, with switches and hosts as nodes.

## 3. Proxy ARP: a network that never floods

The topology has three loops and spanning tree is switched off. In such a network one flooded broadcast is fatal: Ethernet frames carry no TTL, so the copies circulate and multiply until the switches choke. I reproduced this deliberately with a learning switch on a triangle before writing any of this.

The controller therefore never floods anything. It knows every host's address, so it answers ARP requests itself and sends the reply straight back out of the port the request came from:

```python
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
    ...
```

The virtual IP has no network card behind it, so it gets an invented MAC (`00:00:00:00:00:fe`). The client is happy with any answer; the switches later replace that MAC with the chosen server's real one.

Anything else the controller does not recognise (IPv6 neighbour discovery, for example) is silently dropped rather than flooded.

## 4. Routing and the order of rule installation

Ordinary host-to-host traffic (a ping to a server's real address, say) takes the shortest path by hop count. The first packet of a flow reaches the controller through the table-miss rule; the controller installs one rule per switch in each direction and then re-injects the packet.

The detail worth pointing out is the loop direction:

```python
def _install_path(self, path, src_ip, dst_ip):
    """path = [src_host, sw1, ..., swN, dst_host].

    Rules are installed starting from the switch nearest the destination,
    so a packet already in flight never reaches a switch without a rule.
    """
    for i in range(len(path) - 2, 0, -1):
        ...
        self._add_flow(dp, 10, match, actions, idle=30)
```

If the rules were written front to back, the first switch could start forwarding while the second one is still empty. The packet would arrive there, miss, and be sent to the controller a second time, now from a trunk port. Installing back to front removes most of that race. For the few packets that still slip through, the packet-in handler has a simple rule: IPv4 that arrives on a trunk port is dropped, and TCP retransmits it a moment later onto a finished path.

## 5. Virtual IP and NAT

Clients know one address, `10.0.0.100`. A packet-in whose destination is that address is the trigger for server selection:

```python
def _handle_vip(self, dp, in_port, src_ip, data):
    ...
    # Several packets from the same client can arrive before the rules are
    # installed. Reuse the existing assignment so the session is counted once.
    server = self.active.get(client) or self._choose_server(client)
    ...
    path = nx.shortest_path(g, client, server)
    if client not in self.active:
        self.active[client] = server
        self.sessions[server] += 1
    self._install_vip(path)
```

`_install_vip` then writes two rules on every switch of the path. Only the switch that faces the server translates addresses; the others forward. For client `h1` (10.0.0.1) assigned to `srv3` (10.0.0.13) over `h1-e1-c1-srv3`, the rules are:

| Switch | Direction | Match | Actions |
|---|---|---|---|
| `c1` | to server | `ip, src=10.0.0.1, dst=10.0.0.100` | set `eth_dst=00:..:0d`, set `ip_dst=10.0.0.13`, output to `srv3` |
| `c1` | to client | `ip, src=10.0.0.13, dst=10.0.0.1` | set `eth_src=00:..:fe`, set `ip_src=10.0.0.100`, output to `e1` |
| `e1` | to server | `ip, src=10.0.0.1, dst=10.0.0.100` | output to `c1` |
| `e1` | to client | `ip, src=10.0.0.100, dst=10.0.0.1` | output to `h1` |

All four have priority 20 (above the priority 10 routing rules) and an idle timeout of 10 seconds.

This is what `c1` actually holds while `h1` is streaming (`ovs-ofctl -O OpenFlow13 dump-flows c1`, counters removed):

```
cookie=0x1, idle_timeout=10, send_flow_rem priority=20,ip,nw_src=10.0.0.1,nw_dst=10.0.0.100
    actions=set_field:00:00:00:00:00:0d->eth_dst,set_field:10.0.0.13->ip_dst,output:4
cookie=0x0, idle_timeout=10, priority=20,ip,nw_src=10.0.0.13,nw_dst=10.0.0.1
    actions=set_field:00:00:00:00:00:fe->eth_src,set_field:10.0.0.100->ip_src,output:1
```

Why translate at the last switch and not the first? Because then every switch in between matches on the same, unmodified `client -> VIP` header, and the reverse rules on those switches match `VIP -> client`. Only one switch needs to know which server was chosen.

Why translate the reply at all? The client's TCP stack holds a connection to `10.0.0.100`. A SYN-ACK from `10.0.0.13` belongs to no connection it knows, and it would answer with a reset. Rewriting the source on the way back is what makes the virtual IP invisible.

The byte counters of these rules show something that matters for the next sections. For one 30-second session I read 0.21 MB on the client-to-server rule and 9.36 MB on the server-to-client rule. Video flows *towards* the client, so load has to be measured in that direction.

## 6. Counting sessions with FlowRemoved

The `load` policy needs to know how many viewers each server has. Incrementing is easy (it happens at assignment). Decrementing needs a signal that a viewer has left, and nobody says goodbye in HTTP.

The switch can provide that signal. A rule with the `OFPFF_SEND_FLOW_REM` flag reports to the controller when it is removed. The client fetches a segment every two seconds, so the rule stays alive for the whole video and idles out 10 seconds after the last segment.

```python
if nat:
    # Only this rule reports its removal. If every switch on the path
    # did, one session would be decremented several times.
    self._add_flow(dp, 20, match, actions, idle=10,
                   cookie=int(c_ip.split('.')[-1]),
                   flags=dp.ofproto.OFPFF_SEND_FLOW_REM)
```

Exactly one rule per session carries the flag: the client-to-server rule on the NAT switch. Its cookie stores the last octet of the client's IP, which is all the handler needs to find the session again:

```python
@set_ev_cls(ofp_event.EventOFPFlowRemoved, MAIN_DISPATCHER)
def _flow_removed(self, ev):
    """The NAT rule idled out: the client's session has ended."""
    client = self.ip_to_host.get('10.0.0.%d' % ev.msg.cookie)
    server = self.active.pop(client, None)
    if server is None:
        return
    self.sessions[server] -= 1
```

A side effect of idle timeouts is that the flow tables clean themselves. After the last viewer leaves, every switch is back to its table-miss rule.

## 7. Measuring free bandwidth

A background green thread asks every switch for its port counters every 2 seconds. The counters are cumulative byte totals, so a rate is the difference between two readings over the time between them:

```python
dt = now - prev[2]
self.rate[key] = ((st.tx_bytes - prev[0]) * 8 / dt / 1e6,
                  (st.rx_bytes - prev[1]) * 8 / dt / 1e6)
```

Free capacity of a link in one direction is its configured capacity minus that rate. Two details:

- **Direction.** Each direction of a link is tracked separately, and paths are evaluated from the server towards the client, because that is where the video bytes go.
- **Host links.** Hosts have no counters, so for a server link the controller reads the *receive* counter of the switch port instead of a transmit counter.

A path can carry no more than its thinnest link, so its free capacity is a minimum:

```python
def _path_free(self, path):
    """Bottleneck free capacity (Mbps) of path in the server -> client direction."""
    return min(self._free(path[i + 1], path[i]) for i in range(len(path) - 1))
```

**What this measurement really sees.** It sees current usage, not demand. An adaptive client downloads flat out while it fills its buffer, then switches to short bursts every two seconds. In one test the same single client made `srv3` look like it had 7.2 Mbps free at one moment and 15.0 Mbps free a few seconds later. The number is honest, but it moves.

## 8. Measuring link delay

I wanted delays that are measured, not copied from the configuration. There are two kinds of link, and they need two different tricks.

### Switch-to-switch links: a probe that comes back

The controller hands switch `u` a tiny frame with a private ethertype (`0x88b5`) and tells it to send the frame out of the port towards `v`. Switch `v` has no rule for that ethertype, so the frame returns to the controller as a packet-in. The payload carries the names of the two switches so the controller knows which stopwatch to stop.

```
controller --packet-out--> u ===== link =====> v --packet-in--> controller
            control(u)          what I want        control(v)
```

The stopwatch has measured three things. To remove the two control-channel trips, the controller also sends each switch an OpenFlow echo request and times the reply. Half of an echo round trip is one trip:

```
link(u, v) = total - echo(u) / 2 - echo(v) / 2
```

```python
def _probe_in(self, payload):
    # Strip the zero padding added to reach the minimum Ethernet frame size
    u, v = bytes(payload).rstrip(b'\x00').decode().split(',')
    total = time.time() - self.probe_sent[(u, v)]
    echo_u, echo_v = self.echo.get(SWITCHES[u]), self.echo.get(SWITCHES[v])
    if echo_u is None or echo_v is None:
        return                      # echo not measured yet; next round
    self.delay[(u, v)] = max(total - echo_u / 2 - echo_v / 2, 0)
```

One small trap: Ryu sends its own keep-alive echoes on the same channel. Mine carry `data=b'delay'` so the reply handler can tell them apart.

### Switch-to-server links: a ping from nobody

The probe trick fails on the last hop. A server is not a switch; it would just discard the strange frame, and its link would look like 0 ms. But a server does answer a ping. So the controller builds a real ICMP echo request, with the virtual IP as its source, and sends it out of the switch port that faces the server. The server's reply is addressed to the virtual IP; it arrives at the same switch, matches nothing, and goes up to the controller.

This time the link was crossed twice and only one switch was involved:

```
link(sw, srv) = (total - echo(sw)) / 2
```

Client links are not measured at all. A client's link is part of every one of its paths, so it cannot change which server wins.

### How good is it?

With an idle network, over 21 measurement rounds:

| Link | Configured (ms) | Measured median (ms) | Min | Max |
|---|---|---|---|---|
| e1-e2 | 5 | 5.6 | 4.4 | 10.5 |
| e2-e3 | 5 | 4.8 | 2.8 | 6.9 |
| e1-c1 | 3 | 4.1 | 2.1 | 9.0 |
| c1-c2 | 5 | 5.1 | 3.2 | 7.6 |
| c2-d1 | 30 | 33.5 | 28.6 | 72.7 |
| e1-srv1 | 15 | 18.4 | 13.7 | 35.4 |
| e3-srv2 | 2 | 2.0 | 1.0 | 6.3 |
| c1-srv3 | 1 | 0.9 | 0.0 | 6.2 |
| d1-srv4 | 1 | 0.9 | 0.0 | 6.2 |

The medians are within a few milliseconds of the truth. Single samples are not: on a 1 ms link the noise is bigger than the link, and now and then a round has an outlier (72.7 ms on a 30 ms link). Replaying server selection on those 21 rounds, clients with a clear favourite chose the same server every time, but `h4`, whose two best options are about 4 ms and 7 ms away, flipped in 4 of 21 rounds. Averaging over a few rounds would fix that; I left it out to keep the first version simple.

### The pleasant surprise

Measured delay includes queueing. While `h4` was filling its buffer from `srv2`, the 10 Mbps server link was saturated and my ping reply waited in line behind video packets. The controller's log for the next client read:

```
DELAY h7 (ms): {'srv1': 24.6, 'srv2': 33.0, 'srv3': 20.1, 'srv4': 33.5}
```

`srv2` is 2 ms away from `h7` when idle. It measured 33 ms, so `h7` was sent to `srv3` instead. That was the right call: two 720p streams do not fit through `srv2`'s link.

## 9. The five selection policies

All five live in one function, `_choose_server`. Each starts from the same list of candidates and their hop counts.

**hop**: the server with the fewest links to the client. Ties go to the first server in the configuration.

**load**: the server with the fewest active sessions, hop count as the tie-breaker.

```python
return min(hops, key=lambda srv: (self.sessions[srv], hops[srv]))
```

**bw**: the server whose path has the most free capacity (section 7).

**delay**: the server whose path has the smallest measured delay (section 8). A path with a link that has not been measured yet counts as infinitely slow.

**combo**: all four signals in one score. They have different units, so each is divided by the largest value among the candidates, which maps it to 0..1. Bandwidth is inverted because more is better. The score is the weighted sum, and the lowest score wins:

```python
score[srv] = (WEIGHTS['hop'] * hops[srv] / max_hop
              + WEIGHTS['delay'] * delay[srv] / max_delay
              + WEIGHTS['bw'] * (1 - free[srv] / max_free)
              + WEIGHTS['load'] * self.sessions[srv] / max_sess)
```

All weights are 0.25. A worked example from a real run, three clients from the same city arriving a few seconds apart:

```
COMBO h1 srv1: hop 2  delay 14.0 ms  bw 10.0 Mbps  sessions 0  -> score 0.32
COMBO h1 srv2: hop 4  delay 8.9 ms   bw 10.0 Mbps  sessions 0  -> score 0.39
COMBO h1 srv3: hop 3  delay 2.0 ms   bw 20.0 Mbps  sessions 0  -> score 0.16   <- chosen
COMBO h1 srv4: hop 5  delay 35.2 ms  bw 20.0 Mbps  sessions 0  -> score 0.50
```

Take `srv3`: hops 3/5, delay 2.0/35.2, bandwidth 1 − 20/20, no sessions. That gives 0.25 × (0.60 + 0.06 + 0 + 0) ≈ 0.16.

When `h2` arrives, `srv3` has one session and 14.8 Mbps free. Its score rises to 0.49 and `srv1` (0.32) wins. For `h3`, `srv1` is now busy too (0.76) and `srv2` wins with 0.38. Three neighbours end up on three servers, all at 720p.

This example also shows the weak point of my normalisation. With one session in the whole system, `sessions / max_sess` is 1/1, the full penalty. `srv3`'s 20 Mbps link could easily have carried a second 720p stream, yet `h2` was pushed to the thin `srv1`. Normalising load by server capacity would be fairer. Load and bandwidth also overlap: a busy server is punished once for its session and again for its used capacity.

## 10. The video and the client

**Encoding** ([`prepare_video.sh`](../prepare_video.sh)). ffmpeg generates a 60-second test pattern and encodes it three times: 360p at 1 Mbps, 540p at 2.5 Mbps, 720p at 5 Mbps, cut into 2-second segments. The setting that matters most is the keyframe interval:

```bash
# Keyframe interval = FPS x segment duration (25 x 2). Every segment must start
# with a keyframe, otherwise a client that switches quality at a segment border
# cannot decode the new segment.
GOP=50
```

The top bitrate was chosen with the topology in mind: 5 Mbps fits through the thinnest server link (10 Mbps) once, but not twice.

**Serving.** Each server runs `python3 -m http.server`. Nothing more is needed; DASH is plain file downloads.

**The client** ([`dash_client.py`](../dash_client.py)). The downloads are real; only the screen is missing. Playback is modelled as a buffer measured in seconds of video: each finished segment adds 2 seconds, and the time spent downloading drains it.

The adaptation rule is deliberately simple. Time the last download, then pick the highest bitrate that fits into 80% of that speed:

```python
def choose(last_mbps):
    """ABR: return the (id, bitrate) for the next segment."""
    if last_mbps is None:          # first segment: speed still unknown
        return REPS[0]
    budget = SAFETY * last_mbps * 1e6
    best = REPS[0]
    for rep in REPS:
        if rep[1] <= budget:
            best = rep
    return best
```

A stall is the buffer hitting zero during a download:

```python
if playing:
    buffer -= dt
    if buffer < 0:
        stalls += 1
        buffer = 0.0
        playing = False
```

When the buffer holds more than 10 seconds the client pauses downloading, which produces the on/off traffic pattern mentioned in section 7.

Two behaviours of this client explain a lot of the results:

- **Small files look slow.** Every segment is a new TCP connection that starts in slow start. A 250 KB segment over a 10 Mbps link measured 6.4 Mbps; a 1.3 MB segment over the same link measured 8.2 Mbps. So the client is cautious at low quality.
- **Round-trip time limits speed.** Slow start doubles once per round trip. Through the 30 ms link the round trip is about 82 ms, and clients measured anywhere between 4.8 and 10.9 Mbps on a path that could carry far more. 720p needs a measured 6.25 Mbps (5 / 0.8), so those clients kept hopping between 540p and 720p.

At the end the client prints one summary line, which is what the analysis script reads:

```
startup 0.29 s | avg quality 4066 kbps | stalls 0 | quality switches 7
```

## 11. Experiment method

[`experiments/run_experiment.py`](../experiments/run_experiment.py) runs the comparison unattended. For each of the 50 runs it:

1. starts a **fresh controller and a fresh network**, so no run inherits rules, counters or TCP state from another;
2. waits until the controller's log shows all 16 link directions and all 13 hosts (each host sends one ARP for a non-existent address, which the controller ignores but learns from);
3. starts a web server on every server host;
4. in `delay` and `combo` mode, waits until a measurement round has covered all four server links;
5. starts the nine clients, all at once (flash) or one every 3 seconds (gradual);
6. waits for every client's summary line, then tears everything down and stores the logs.

Things I did to keep the comparison fair:

- **Same arrival order for every policy.** The order is shuffled with the run number as the seed, so in run 3 every policy faces the identical sequence of clients.
- **Runs are interleaved.** The script does run 1 of every policy, then run 2 of every policy. If the VM is slower at some point, all policies share the pain.
- **Five runs per cell.** A single run is not enough; the `h4` example in section 8 shows how one noisy sample can change an assignment.
- **A busy CPU.** While the VM is idle, its timer is coarse and netem delays come out about three times too long and jittery (a 30 ms round trip measured 50 to 86 ms). With one low-priority busy loop per CPU the same test measured 30.04 ms with 0.006 ms deviation. The script starts those loops itself.

[`experiments/analyze.py`](../experiments/analyze.py) parses the logs into `clients.csv` (one row per client per run) and `summary.md`. Quality is averaged per run first and then across runs, so the min-max and standard deviation describe run-to-run variation, not differences between clients.

## 12. Results in full

50 of 50 runs completed on the first attempt, and all 450 clients finished their video.

**Flash crowd** (9 clients at the same instant)

| Policy | Quality (kbps) | Min-max over runs | Std | Startup (s) | Stalls / run | Switches / client | srv1 / srv2 / srv3 / srv4 |
|---|---|---|---|---|---|---|---|
| hop | 1384 | 1348-1448 | 38 | 0.90 | 0.4 | 1.3 | 6.0 / 3.0 / 0.0 / 0.0 |
| load | 3333 | 3307-3351 | 17 | 0.43 | 0.2 | 2.2 | 2.8 / 2.2 / 2.0 / 2.0 |
| bw | 3660 | 3159-4233 | 491 | 0.47 | 0.0 | 3.9 | 0.0 / 0.0 / 1.2 / 7.8 |
| delay | 2024 | 1915-2122 | 87 | 0.53 | 1.2 | 3.1 | 0.0 / 3.0 / 6.0 / 0.0 |
| combo | 3176 | 3026-3540 | 208 | 0.39 | 0.6 | 3.1 | 1.8 / 2.8 / 3.2 / 1.2 |

**Gradual** (one client every 3 seconds)

| Policy | Quality (kbps) | Min-max over runs | Std | Startup (s) | Stalls / run | Switches / client | srv1 / srv2 / srv3 / srv4 |
|---|---|---|---|---|---|---|---|
| hop | 2378 | 2207-2474 | 128 | 0.66 | 0.4 | 3.3 | 6.0 / 3.0 / 0.0 / 0.0 |
| load | 4228 | 4133-4340 | 81 | 0.40 | 0.0 | 2.5 | 3.0 / 2.0 / 2.0 / 2.0 |
| bw | 4439 | 4344-4566 | 94 | 0.44 | 0.0 | 2.6 | 0.0 / 0.0 / 1.4 / 7.6 |
| delay | 3791 | 3459-4118 | 264 | 0.41 | 0.4 | 2.8 | 1.8 / 3.2 / 3.6 / 0.4 |
| combo | 4581 | 4437-4640 | 84 | 0.30 | 0.0 | 1.8 | 1.2 / 2.0 / 2.8 / 3.0 |

### Reading the tables

**Every policy is worse in the flash crowd.** Partly that is the network (nine streams starting together compete harder), partly it is the controller deciding blind.

**hop: 6 / 3 / 0 / 0, always.** City A is nearest to `srv1`. City B is three hops from `srv1`, `srv2` and `srv3` alike, and the tie goes to the first in the list, `srv1`. Six clients share 10 Mbps and sit at the lowest quality. The policy uses no measurement, so the split is identical in all ten runs.

**load: the steadiest.** The session counter is updated at the moment of assignment, so even nine simultaneous arrivals see each other. The cost is that it treats a 10 Mbps cache and a 100 Mbps data center as equals.

**bw: a herd that happens to survive.** In the flash crowd every client reads the same pre-crowd measurement and almost all choose `srv4`. Its paths are wide enough (40 Mbps at the narrowest point) to keep quality high, but the long round trip makes the clients' speed estimates jumpy: the most quality switches (3.9 per client) and the widest spread between runs. In another topology, with a smaller "biggest" server, the same herd would have been a disaster.

**delay: right answer, too late.** A measurement round takes 5 seconds. Nine clients arriving within 10 ms are all judged against the empty network: cities A and B pick `srv3`, city C picks `srv2`. Six streams on a 20 Mbps link is where the stalls come from. The queueing effect described in section 8 does kick in, but only for clients that arrive after the next round. In the gradual scenario it partly does, and the distribution becomes much more even.

**combo: the best when it can see.** With three seconds between arrivals, all four signals are reasonably fresh and combo is the best on every metric. In the flash crowd, 75% of the score (hop, bandwidth, delay) is identical for every arriving client, and only the load term reacts. In `load` mode that signal has all the weight; in `combo` it is diluted to a quarter, so combo ends up behind `load`.

## 13. Known limitations

- **Paths are always shortest by hop count.** The policies choose the server; the route to it ignores bandwidth and delay. Where two equally short paths exist (for example from city A to `srv4`), which one is used depends on the order in which links were discovered.
- **One decision per session.** The server is chosen on the first packet and kept until the rules idle out. A viewer is not moved when conditions change. Because each segment is its own TCP connection, per-segment re-selection would be safe; it would need hysteresis to avoid clients bouncing between servers.
- **Single-sample measurements.** No smoothing of delay or bandwidth readings (section 8).
- **Combo before the first measurement round.** In `combo` mode an unmeasured link counts as 0 ms, which briefly favours unprobed paths. The experiment script waits for a full round before starting clients.
- **No servers known yet.** If a client connects before any server has been discovered, server selection has no candidates and the request fails. In practice hosts are discovered within the first second.
- **Ping while streaming.** If a client pings a server's real address while it is also streaming from that server through the virtual IP, the higher-priority NAT rule rewrites the ping reply's source to the virtual IP.
- **Playback is simulated.** Downloads, bitrates and timing are real; decoding and rendering are replaced by the buffer model.
- **Static topology.** Link failures are not handled; the controller does not remove links from its map.

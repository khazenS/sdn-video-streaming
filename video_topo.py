#!/usr/bin/env python3
"""Mininet topology of the video streaming network (defined in net_config.py).

    sudo python3 video_topo.py        # expects the SDN controller on 127.0.0.1:6653
    sudo python3 video_topo.py test   # no controller: standalone OVS with STP,
                                      # useful to verify links with ping/iperf
"""
import sys
from mininet.net import Mininet
from mininet.topo import Topo
from mininet.link import TCLink
from mininet.node import RemoteController, OVSSwitch
from mininet.cli import CLI
from mininet.log import setLogLevel
from net_config import SWITCHES, SERVERS, LINKS


class VideoTopo(Topo):
    def build(self, test=False):
        # Without a controller the looped topology needs STP to avoid a broadcast storm
        opts = dict(failMode='standalone', stp=True) if test else {}

        for name, dpid in SWITCHES.items():
            self.addSwitch(name, dpid='%016x' % dpid,
                           protocols='OpenFlow13', **opts)

        for i in range(1, 10):
            self.addHost('h%d' % i, ip='10.0.0.%d/24' % i,
                         mac='00:00:00:00:00:%02x' % i)

        # Last MAC byte = last IP number (10.0.0.11 -> 00:..:0b)
        for name, ip in SERVERS.items():
            last = int(ip.split('.')[-1])
            self.addHost(name, ip=ip + '/24',
                         mac='00:00:00:00:00:%02x' % last)

        for a, b, bw, delay in LINKS:
            self.addLink(a, b, bw=bw, delay=delay)


if __name__ == '__main__':
    setLogLevel('info')
    test = 'test' in sys.argv
    net = Mininet(topo=VideoTopo(test=test), link=TCLink,
                  switch=OVSSwitch, controller=None)
    if not test:
        net.addController('c0', controller=RemoteController,
                          ip='127.0.0.1', port=6653)
    net.start()
    CLI(net)
    net.stop()

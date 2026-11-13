/* Content of the explorer: topology, chapters, steps and experiment results.
   A step is plain data; app.js turns it into drawings and animations.

   Event fields:  t start (s) · d duration (s) · p path (node ids) · k kind
                  l label (string, or function of progress 0..1) · r radius
                  log [from, to, type, info] -> a row in the packet flow table */

const NODES = {
  h1: { x: 120, y: 62, type: 'client' }, h2: { x: 190, y: 62, type: 'client' }, h3: { x: 260, y: 62, type: 'client' },
  h4: { x: 430, y: 62, type: 'client' }, h5: { x: 500, y: 62, type: 'client' }, h6: { x: 570, y: 62, type: 'client' },
  h7: { x: 740, y: 62, type: 'client' }, h8: { x: 810, y: 62, type: 'client' }, h9: { x: 880, y: 62, type: 'client' },
  e1: { x: 190, y: 170, type: 'switch' }, e2: { x: 500, y: 170, type: 'switch' }, e3: { x: 810, y: 170, type: 'switch' },
  c1: { x: 345, y: 330, type: 'switch' }, c2: { x: 655, y: 330, type: 'switch' },
  d1: { x: 655, y: 432, type: 'switch' },
  srv1: { x: 70, y: 292, type: 'server', note: 'EDGE CACHE A' },
  srv2: { x: 930, y: 292, type: 'server', note: 'EDGE CACHE C' },
  srv3: { x: 345, y: 468, type: 'server', note: 'CORE DATA CENTER' },
  srv4: { x: 655, y: 536, type: 'server', note: 'REMOTE DATA CENTER' },
  ctl: { x: 500, y: 468, type: 'controller' },
};

// [a, b, bandwidth Mbps, delay ms] - same values as net_config.py
const LINKS = [
  ['e1', 'srv1', 10, 15], ['e3', 'srv2', 10, 2],
  ['h1', 'e1', 50, 2], ['h2', 'e1', 50, 2], ['h3', 'e1', 50, 2],
  ['h4', 'e2', 50, 2], ['h5', 'e2', 50, 2], ['h6', 'e2', 50, 2],
  ['h7', 'e3', 50, 2], ['h8', 'e3', 50, 2], ['h9', 'e3', 50, 2],
  ['e1', 'e2', 20, 5], ['e2', 'e3', 20, 5],
  ['e1', 'c1', 40, 3], ['e2', 'c1', 40, 3], ['e2', 'c2', 40, 3], ['e3', 'c2', 40, 3],
  ['c1', 'c2', 100, 5], ['c1', 'srv3', 20, 1], ['c2', 'd1', 60, 30], ['d1', 'srv4', 100, 1],
];

const SWITCHES = ['e1', 'e2', 'e3', 'c1', 'c2', 'd1'];
const SERVERS = ['srv1', 'srv2', 'srv3', 'srv4'];
const CLIENTS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h9'];
const MODES = ['hop', 'load', 'bw', 'delay', 'combo'];
const VIP = '10.0.0.100';

// Averages of 5 runs per mode and scenario, 9 clients each (experiments/results/summary.md)
const RESULTS = {
  flash: {
    hop:   { q: 1384, min: 1348, max: 1448, std: 38,  start: 0.90, stalls: 0.4, sw: 1.3, srv: [6.0, 3.0, 0.0, 0.0] },
    load:  { q: 3333, min: 3307, max: 3351, std: 17,  start: 0.43, stalls: 0.2, sw: 2.2, srv: [2.8, 2.2, 2.0, 2.0] },
    bw:    { q: 3660, min: 3159, max: 4233, std: 491, start: 0.47, stalls: 0.0, sw: 3.9, srv: [0.0, 0.0, 1.2, 7.8] },
    delay: { q: 2024, min: 1915, max: 2122, std: 87,  start: 0.53, stalls: 1.2, sw: 3.1, srv: [0.0, 3.0, 6.0, 0.0] },
    combo: { q: 3176, min: 3026, max: 3540, std: 208, start: 0.39, stalls: 0.6, sw: 3.1, srv: [1.8, 2.8, 3.2, 1.2] },
  },
  gradual: {
    hop:   { q: 2378, min: 2207, max: 2474, std: 128, start: 0.66, stalls: 0.4, sw: 3.3, srv: [6.0, 3.0, 0.0, 0.0] },
    load:  { q: 4228, min: 4133, max: 4340, std: 81,  start: 0.40, stalls: 0.0, sw: 2.5, srv: [3.0, 2.0, 2.0, 2.0] },
    bw:    { q: 4439, min: 4344, max: 4566, std: 94,  start: 0.44, stalls: 0.0, sw: 2.6, srv: [0.0, 0.0, 1.4, 7.6] },
    delay: { q: 3791, min: 3459, max: 4118, std: 264, start: 0.41, stalls: 0.4, sw: 2.8, srv: [1.8, 3.2, 3.6, 0.4] },
    combo: { q: 4581, min: 4437, max: 4640, std: 84,  start: 0.30, stalls: 0.0, sw: 1.8, srv: [1.2, 2.0, 2.8, 3.0] },
  },
};

/* ---------- small helpers to keep the step definitions short ---------- */
const TRIANGLE = [['e1', 'e2'], ['e2', 'c1'], ['e1', 'c1']];
const ALL_TRUNKS = LINKS.filter(l => SWITCHES.includes(l[0]) && SWITCHES.includes(l[1])).map(l => [l[0], l[1]]);

function stormEvents() {
  const ev = [];
  const cw = ['e1', 'e2', 'c1', 'e1'], ccw = ['e1', 'c1', 'e2', 'e1'];
  for (let round = 0; round < 4; round++) {
    for (let copy = 0; copy <= round; copy++) {
      const t = round * 1.5 + copy * 0.22;
      ev.push({ t, d: 1.5, p: cw, k: 'arp', l: copy ? '' : 'ARP' });
      ev.push({ t: t + 0.1, d: 1.5, p: ccw, k: 'arp' });
    }
    ev.push({ t: round * 1.5, d: 0.01, p: ['e1', 'e2'], k: 'arp', hidden: true,
              log: ['e' + (1 + round % 2), 'ff:ff:ff:ff:ff:ff', 'ARP', 'Who has 10.0.0.13? (copy #' + 2 ** (round + 1) + ', still circling)'] });
  }
  return ev;
}

function videoLoop(server, path, opts) {
  // A stream of video segments from the server to the client
  const o = Object.assign({ n: 5, gap: 0.8, d: 1.6, t: 0, l: '', r: 6 }, opts || {});
  const ev = [];
  for (let i = 0; i < o.n; i++) {
    ev.push({ t: o.t + i * o.gap, d: o.d, p: path, k: 'video', r: o.r, l: i === 0 ? o.l : '' });
  }
  return ev;
}

const P = {   // paths the controller really used in my runs
  h1s1: ['h1', 'e1', 'srv1'], h1s2: ['h1', 'e1', 'e2', 'e3', 'srv2'],
  h1s3: ['h1', 'e1', 'c1', 'srv3'], h1s4: ['h1', 'e1', 'c1', 'c2', 'd1', 'srv4'],
};
const rev = p => p.slice().reverse();

/* ------------------------------ chapters ------------------------------ */
const CHAPTERS = [
  {
    id: 'network', name: 'The network', sub: 'Three cities, four servers',
    steps: [
      {
        title: 'Three cities', sub: 'Nine viewers behind three edge switches', plane: 'data',
        text: 'A small video streaming company. Nine clients (<b>h1-h9</b>) live in three cities, and each city hangs off its own edge switch (<b>e1, e2, e3</b>). Every client wants the same thing: press play and get a sharp picture without waiting.',
        facts: [['Clients', 'h1-h9 · 10.0.0.1-9'], ['Client link', '50 Mbps · 2 ms'], ['Emulator', 'Mininet + Open vSwitch']],
        code: 'net_config.py · video_topo.py',
        view: { focus: [...CLIENTS, 'e1', 'e2', 'e3'] },
        ev: [],
      },
      {
        title: 'Four servers', sub: 'Same video, very different locations', plane: 'data',
        text: 'All four servers hold the same video. Two small <b>edge caches</b> sit right next to cities A and C but on thin 10 Mbps links. <b>srv3</b> is a data center at the core. <b>srv4</b> has the fattest pipe of all, yet it is far away.',
        facts: [['srv1', '10 Mbps · close to city A'], ['srv2', '10 Mbps · close to city C'], ['srv3', '20 Mbps · at the core'], ['srv4', '100 Mbps · behind a long link']],
        code: 'net_config.py · LINKS',
        view: { linkLabels: 'bw', focus: [...SERVERS, ...SWITCHES] },
        ev: [],
      },
      {
        title: 'Distance costs time', sub: 'Every link also has a delay', plane: 'data',
        text: 'Bandwidth is only half of the story. The link towards the remote data center adds <b>30 ms</b> each way, and srv1\'s short link is surprisingly slow at 15 ms. Delay matters for video more than it seems: every segment is a new TCP connection, and TCP speeds up slowly on a long round trip.',
        facts: [['Fastest server link', 'srv3, srv4 · 1 ms'], ['Slowest hop', 'c2-d1 · 30 ms'], ['srv1 link', '15 ms']],
        code: 'net_config.py · LINKS',
        view: { linkLabels: 'delay' },
        ev: [],
      },
      {
        title: 'Loops on purpose', sub: 'More than one way to get anywhere', plane: 'data',
        text: 'The switches are wired with <b>redundant links</b>. From city A you can reach the core directly or through city B. That is great for capacity. It is also exactly what breaks a classic Ethernet network, as the next chapter shows.',
        facts: [['Switches', '6 (3 edge, 2 core, 1 data center)'], ['Switch links', '8'], ['Loops', 'e1-e2-c1, e2-e3-c2, e2-c1-c2']],
        code: 'net_config.py',
        view: { paths: [{ n: ['e1', 'e2', 'c1', 'e1'], c: 'amber' }, { n: ['e2', 'e3', 'c2', 'e2'], c: 'blue' }] },
        ev: [],
      },
    ],
  },
  {
    id: 'why', name: 'Why SDN?', sub: 'What goes wrong without it',
    steps: [
      {
        title: 'One innocent question', sub: 'h1 asks "who has 10.0.0.13?"', plane: 'data',
        text: 'Before h1 can talk to anyone it sends an <b>ARP broadcast</b>. An ordinary learning switch does the only thing it can with a broadcast: copy it out of every other port.',
        facts: [['Packet', 'ARP request'], ['Destination', 'ff:ff:ff:ff:ff:ff (everyone)'], ['Switch behaviour', 'flood']],
        view: {},
        ev: [
          { t: 0, d: 0.7, p: ['h1', 'e1'], k: 'arp', l: 'ARP?', log: ['h1', 'broadcast', 'ARP', 'Who has 10.0.0.13? Tell 10.0.0.1'] },
          { t: 0.8, d: 0.8, p: ['e1', 'h2'], k: 'arp' }, { t: 0.8, d: 0.8, p: ['e1', 'h3'], k: 'arp' },
          { t: 0.8, d: 0.9, p: ['e1', 'srv1'], k: 'arp' },
          { t: 0.8, d: 1.0, p: ['e1', 'e2'], k: 'arp', log: ['e1', 'all ports', 'ARP', 'Flooded out of 5 ports'] },
          { t: 0.8, d: 1.0, p: ['e1', 'c1'], k: 'arp' },
        ],
      },
      {
        title: 'The storm', sub: 'The copies never die', plane: 'data',
        text: 'e2 floods it to c1. c1 floods it back to e1. e1 floods it again. Ethernet frames have <b>no TTL</b>, so nothing ever removes them, and every lap creates more copies. I ran a learning switch on a triangle like this one: the network was unusable within seconds.',
        facts: [['Cause', 'loop + flooding'], ['TTL in Ethernet', 'none'], ['Result', 'broadcast storm, 100% CPU']],
        view: { hot: TRIANGLE },
        ev: stormEvents(),
      },
      {
        title: 'The classic fix: STP', sub: 'Switch off links until no loop is left', plane: 'data',
        text: 'Spanning Tree Protocol removes loops by <b>blocking links</b>. It works, but look at the price. In my test STP blocked both links into c1 from the edge, so h1 reached srv3 the long way round: <b>32 ms instead of 12 ms</b>, with paid-for links sitting idle.',
        facts: [['Shortest path', 'h1-e1-c1-srv3 · 12 ms RTT'], ['STP path', 'h1-e1-e2-c2-c1-srv3 · 32 ms RTT'], ['Idle links', '3 of 8']],
        code: 'video_topo.py test',
        view: { blocked: [['e1', 'c1'], ['e2', 'c1'], ['e2', 'e3']], paths: [{ n: ['h1', 'e1', 'e2', 'c2', 'c1', 'srv3'], c: 'amber' }] },
        ev: [
          { t: 0.2, d: 3.2, p: ['h1', 'e1', 'e2', 'c2', 'c1', 'srv3'], k: 'data', l: 'ping', log: ['h1', 'srv3', 'ICMP', 'Echo request, forced around the blocked links'] },
          { t: 3.5, d: 3.2, p: ['srv3', 'c1', 'c2', 'e2', 'e1', 'h1'], k: 'data', l: 'reply', log: ['srv3', 'h1', 'ICMP', 'Echo reply · 32 ms round trip'] },
        ],
      },
      {
        title: 'The SDN way', sub: 'One brain that sees the whole map', plane: 'both',
        text: 'With SDN the switches stop deciding on their own. A <b>controller</b> knows every link, answers ARP itself so nothing is ever flooded, and picks a loop-free path for each connection. No link is blocked. The rest of this explorer is about how that controller works and how it chooses a server.',
        facts: [['Control plane', 'Ryu controller (Python)'], ['Data plane', 'Open vSwitch · OpenFlow 1.3'], ['h1 to srv3', '12 ms, on the shortest path']],
        code: 'sdn_controller.py',
        view: { ctl: true, paths: [{ n: P.h1s3, c: 'accent' }] },
        ev: [
          { t: 0.2, d: 1.8, p: P.h1s3, k: 'data', l: 'ping', log: ['h1', 'srv3', 'ICMP', 'Echo request on the shortest path'] },
          { t: 2.2, d: 1.8, p: rev(P.h1s3), k: 'data', l: 'reply', log: ['srv3', 'h1', 'ICMP', 'Echo reply · 12 ms round trip'] },
        ],
      },
    ],
  },
  {
    id: 'discovery', name: 'Discovery', sub: 'How the controller learns the map',
    steps: [
      {
        title: 'Switches check in', sub: 'Each switch opens a channel to the controller', plane: 'control',
        text: 'When a switch starts, it connects to the controller. The controller replies with a single rule, the <b>table-miss</b> rule: "if you do not know what to do with a packet, send it to me". From now on every surprise lands on the controller\'s desk.',
        facts: [['Channel', 'TCP 6653 (OpenFlow)'], ['First rule', 'priority 0 · match all · to controller']],
        code: 'sdn_controller.py · switch_features_handler',
        view: { ctl: true },
        ev: SWITCHES.flatMap((s, i) => [
          { t: i * 0.35, d: 0.8, p: [s, 'ctl'], k: 'ctrl', l: i ? '' : 'hello', log: [s, 'controller', 'OpenFlow', 'Features reply · Switch connected: ' + s] },
          { t: i * 0.35 + 0.9, d: 0.8, p: ['ctl', s], k: 'ctrl', l: i ? '' : 'table-miss' },
        ]),
      },
      {
        title: 'Mapping links with LLDP', sub: 'A packet that reports where it came out', plane: 'control',
        text: 'The controller hands e1 a tiny <b>LLDP</b> packet and says "send this out of port 5". It pops out at e2, which has no rule for it and returns it to the controller. Sent on e1 port 5, seen on e2 port 4: there is a link. Repeat for every port and the switch map is complete.',
        facts: [['Mechanism', 'packet-out, then packet-in'], ['Found', '8 links (16 directions)'], ['Ryu flag', '--observe-links']],
        code: 'sdn_controller.py · link_add_handler',
        view: { ctl: true, paths: ALL_TRUNKS.map(n => ({ n, c: 'accent', after: 4.2 })) },
        ev: [
          { t: 0, d: 1.0, p: ['ctl', 'e1'], k: 'ctrl', l: 'packet-out', log: ['controller', 'e1', 'OpenFlow', 'Packet-out: send LLDP on port 5'] },
          { t: 1.1, d: 1.2, p: ['e1', 'e2'], k: 'probe', l: 'LLDP', log: ['e1:5', 'e2:4', 'LLDP', 'I was sent from e1 port 5'] },
          { t: 2.4, d: 1.0, p: ['e2', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e2', 'controller', 'OpenFlow', 'Packet-in · Link found: e1:5 -> e2:4'] },
          ...ALL_TRUNKS.slice(1).map((l, i) => ({ t: 3.4 + i * 0.12, d: 0.8, p: l, k: 'probe' })),
        ],
      },
      {
        title: 'Finding the hosts', sub: 'Learned from their first packet', plane: 'control',
        text: 'Hosts do not speak LLDP. The controller learns where a host is the first time it sends anything: the packet arrives through the table-miss rule with the switch and port attached. One catch: packets arriving on a <b>switch-to-switch port</b> are ignored, because that host is attached somewhere else.',
        facts: [['Learned', 'h1 is on e1 port 2'], ['Ignored', 'packets on trunk ports']],
        code: 'sdn_controller.py · _learn_host',
        view: { ctl: true, badges: { h1: { text: 'e1 : port 2', after: 2.1 } } },
        ev: [
          { t: 0, d: 0.9, p: ['h1', 'e1'], k: 'arp', l: 'first packet', log: ['h1', 'e1', 'ARP', 'First packet from 00:00:00:00:00:01'] },
          { t: 1.0, d: 1.1, p: ['e1', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e1', 'controller', 'OpenFlow', 'Packet-in · Host found: h1 -> e1:2'] },
        ],
      },
      {
        title: 'Proxy ARP', sub: 'The controller answers for everyone', plane: 'control',
        text: 'Remember the storm? Here the ARP request never spreads. e1 passes it to the controller, the controller already knows every address, and it <b>writes the reply itself</b>. For the video service it answers with a made-up MAC, because that address belongs to no real machine. More on that next.',
        facts: [['Question', 'Who has 10.0.0.100?'], ['Answer', '00:00:00:00:00:fe (invented)'], ['Flooded packets', '0']],
        code: 'sdn_controller.py · _handle_arp',
        view: { ctl: true },
        ev: [
          { t: 0, d: 0.8, p: ['h1', 'e1'], k: 'arp', l: 'ARP?', log: ['h1', 'broadcast', 'ARP', 'Who has 10.0.0.100? Tell 10.0.0.1'] },
          { t: 0.9, d: 1.0, p: ['e1', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e1', 'controller', 'OpenFlow', 'Packet-in (ARP request)'] },
          { t: 2.0, d: 1.0, p: ['ctl', 'e1'], k: 'ctrl', l: 'packet-out', log: ['controller', 'e1', 'OpenFlow', 'Packet-out: ARP reply, send on port 2'] },
          { t: 3.1, d: 0.8, p: ['e1', 'h1'], k: 'arp', l: 'ARP reply', log: ['00:00:00:00:00:fe', 'h1', 'ARP', '10.0.0.100 is at 00:00:00:00:00:fe'] },
        ],
      },
    ],
  },
  {
    id: 'vip', name: 'Virtual IP + NAT', sub: 'One address, four servers',
    steps: [
      {
        title: 'One address for the service', sub: 'Clients never learn a server address', plane: 'both',
        text: 'Every client connects to the same address, <b>10.0.0.100</b>. No machine owns it. It is a <b>virtual IP</b>: a promise that the network will deliver you to <i>some</i> server. Which one is the controller\'s decision, and the client never finds out.',
        facts: [['Virtual IP', '10.0.0.100'], ['Real servers', '10.0.0.11 - 10.0.0.14'], ['Client talks to controller?', 'never']],
        code: 'sdn_controller.py · VIP',
        view: { badges: { ctl: { text: 'VIP 10.0.0.100' } }, focus: ['h1', 'e1', 'c1', 'ctl', ...SERVERS] },
        ev: [],
      },
      {
        title: 'The first packet', sub: 'No rule yet, so it goes to the controller', plane: 'control',
        text: 'h1 opens a TCP connection to the virtual IP. e1 has never seen this flow and has no matching rule, so the table-miss rule sends the packet up. This <b>packet-in</b> is the moment the controller gets to choose a server.',
        facts: [['Packet', 'TCP SYN · 10.0.0.1 to 10.0.0.100:80'], ['e1 flow table', 'no match'], ['Decision point', 'once per session']],
        code: 'sdn_controller.py · packet_in_handler',
        view: { ctl: true },
        ev: [
          { t: 0, d: 0.9, p: ['h1', 'e1'], k: 'data', l: 'SYN to VIP', log: ['10.0.0.1', '10.0.0.100', 'TCP', 'SYN, port 80'] },
          { t: 1.0, d: 1.1, p: ['e1', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e1', 'controller', 'OpenFlow', 'Packet-in: destination is the virtual IP'] },
        ],
      },
      {
        title: 'Rules, written back to front', sub: 'The far switch first', plane: 'control',
        text: 'Say the controller picks <b>srv3</b>. It installs rules on every switch along the path, starting with the one <b>nearest the server</b>. If it started at e1, the packet could race ahead and reach c1 before c1 knows what to do with it. Only then is the waiting packet released.',
        facts: [['Chosen', 'srv3 via h1-e1-c1-srv3'], ['Install order', 'c1, then e1'], ['Rule lifetime', 'removed after 10 s idle']],
        code: 'sdn_controller.py · _install_vip',
        view: { ctl: true, paths: [{ n: P.h1s3, c: 'accent' }], badges: { c1: { text: 'NAT rules', after: 1.0 }, e1: { text: 'forward rules', after: 2.2 } } },
        ev: [
          { t: 0, d: 1.0, p: ['ctl', 'c1'], k: 'ctrl', l: 'flow-mod 1', log: ['controller', 'c1', 'OpenFlow', 'Flow-mod: 10.0.0.1 to VIP: rewrite to srv3, out port 4'] },
          { t: 1.2, d: 1.0, p: ['ctl', 'e1'], k: 'ctrl', l: 'flow-mod 2', log: ['controller', 'e1', 'OpenFlow', 'Flow-mod: 10.0.0.1 to VIP: out port 6 (towards c1)'] },
          { t: 2.4, d: 1.0, p: ['ctl', 'e1'], k: 'ctrl', l: 'packet-out', log: ['controller', 'e1', 'OpenFlow', 'Packet-out: release the SYN into the new rules'] },
        ],
      },
      {
        title: 'On the way in: VIP becomes srv3', sub: 'Rewritten at the last switch', plane: 'data',
        text: 'The packet travels untouched until the switch that faces the server. There c1 <b>rewrites the destination</b> from the virtual address to srv3\'s real IP and MAC. srv3 receives a perfectly normal packet addressed to itself.',
        facts: [['Before c1', 'dst 10.0.0.100 · 00:..:fe'], ['After c1', 'dst 10.0.0.13 · 00:..:0d'], ['Who rewrites', 'the switch, not the controller']],
        code: 'sdn_controller.py · _install_vip',
        view: { paths: [{ n: P.h1s3, c: 'accent' }], badges: { c1: { text: 'NAT' } } },
        ev: [
          { t: 0.2, d: 3.0, p: P.h1s3, k: 'data', l: f => (f < 0.72 ? 'dst 10.0.0.100' : 'dst 10.0.0.13'), swap: 0.72,
            log: ['10.0.0.1', '10.0.0.100', 'TCP', 'SYN · c1 rewrites destination to 10.0.0.13'] },
        ],
      },
      {
        title: 'On the way back: srv3 becomes VIP', sub: 'Otherwise the client hangs up', plane: 'data',
        text: 'srv3 answers from its own address. But h1 opened a connection to 10.0.0.100, and a reply from a stranger would be rejected by its TCP stack. So c1 <b>rewrites the source back</b> to the virtual IP. This half took me the longest to understand, and it is the half that makes the trick invisible.',
        facts: [['Before c1', 'src 10.0.0.13'], ['After c1', 'src 10.0.0.100'], ['h1 believes', 'it talks to 10.0.0.100']],
        code: 'sdn_controller.py · _install_vip',
        view: { paths: [{ n: P.h1s3, c: 'accent' }], badges: { c1: { text: 'NAT' } } },
        ev: [
          { t: 0.2, d: 3.0, p: rev(P.h1s3), k: 'video', l: f => (f < 0.28 ? 'src 10.0.0.13' : 'src 10.0.0.100'), swap: 0.28,
            log: ['10.0.0.13', '10.0.0.1', 'TCP', 'SYN-ACK · c1 rewrites source to 10.0.0.100'] },
        ],
      },
      {
        title: 'Cleaning up', sub: 'The switch reports when the session is over', plane: 'control',
        text: 'When the video ends, the rules sit unused. After 10 idle seconds the switch deletes them, and the NAT rule sends a <b>flow-removed</b> message on its way out. That is how the controller knows a viewer has left and can lower that server\'s session count. Only one rule per session reports back, otherwise one viewer would be subtracted several times.',
        facts: [['Idle timeout', '10 s'], ['Signal', 'OFPFlowRemoved'], ['Sessions on srv3', '1, then 0']],
        code: 'sdn_controller.py · _flow_removed',
        view: { ctl: true, badges: { srv3: { text: '1 session', until: 2.2 }, c1: { text: 'rule expired', after: 0.8 } }, badges2: { srv3: { text: '0 sessions', after: 2.2 } } },
        ev: [
          { t: 1.0, d: 1.2, p: ['c1', 'ctl'], k: 'ctrl', l: 'flow-removed', log: ['c1', 'controller', 'OpenFlow', 'Flow-removed · Session ended: h1 (srv3)'] },
        ],
      },
    ],
  },
  {
    id: 'hop', name: 'Policy 1 · Hop count', sub: 'Pick the nearest server',
    steps: [
      {
        title: 'Count the hops', sub: 'Fewest links wins', plane: 'control',
        text: 'The simplest idea: send each viewer to the <b>closest</b> server, counting links. The controller already has the map, so this is a shortest-path lookup. For h1 the winner is srv1, two hops away.',
        facts: [['Signal', 'number of links'], ['Needs measuring?', 'no'], ['Tie', 'first server in the list']],
        code: 'sdn_controller.py · _choose_server',
        view: {
          paths: [{ n: P.h1s4, c: 'muted' }, { n: P.h1s2, c: 'muted' }, { n: P.h1s3, c: 'muted' }, { n: P.h1s1, c: 'accent' }],
          table: { head: ['Server', 'Hops'], rows: [['srv1', '2'], ['srv2', '4'], ['srv3', '3'], ['srv4', '5']], win: 0 },
        },
        ev: [
          { t: 0, d: 0.8, p: ['h1', 'e1'], k: 'data', l: 'SYN', log: ['10.0.0.1', '10.0.0.100', 'TCP', 'SYN'] },
          { t: 0.9, d: 1.0, p: ['e1', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e1', 'controller', 'OpenFlow', "HOP h1: {'srv1': 2, 'srv2': 4, 'srv3': 3, 'srv4': 5}"] },
          { t: 2.0, d: 1.0, p: ['ctl', 'e1'], k: 'ctrl', l: 'rules', log: ['controller', 'e1', 'OpenFlow', 'VIP: h1 -> srv1  path h1-e1-srv1'] },
          ...videoLoop('srv1', rev(P.h1s1), { t: 3.1, n: 3, l: 'video' }),
        ],
      },
      {
        title: 'The catch', sub: 'Nearest is not the same as best', plane: 'data',
        text: 'Hop count knows nothing about capacity. Everyone in city A is nearest to srv1, and so, by a tie, is city B. In my experiment <b>6 of 9 viewers</b> ended up sharing srv1\'s 10 Mbps link while two data centers sat idle. The picture dropped to the lowest quality.',
        facts: [['On srv1', '6 of 9 clients'], ['On srv3 and srv4', '0'], ['Average quality', '1384 kbps (worst of all)']],
        code: 'experiments/results',
        view: { hot: [['e1', 'srv1']], badges: { srv1: { text: '6 sessions' }, srv3: { text: 'idle' }, srv4: { text: 'idle' }, h1: { text: '360p' }, h2: { text: '360p' }, h3: { text: '360p' } } },
        ev: [
          ...videoLoop('srv1', ['srv1', 'e1', 'h1'], { n: 6, gap: 0.9, r: 4 }),
          ...videoLoop('srv1', ['srv1', 'e1', 'h2'], { n: 6, gap: 0.9, t: 0.3, r: 4 }),
          ...videoLoop('srv1', ['srv1', 'e1', 'h3'], { n: 6, gap: 0.9, t: 0.6, r: 4 }),
          ...videoLoop('srv1', ['srv1', 'e1', 'e2', 'h4'], { n: 5, gap: 0.9, t: 0.2, r: 4 }),
          ...videoLoop('srv1', ['srv1', 'e1', 'e2', 'h5'], { n: 5, gap: 0.9, t: 0.5, r: 4 }),
          ...videoLoop('srv1', ['srv1', 'e1', 'e2', 'h6'], { n: 5, gap: 0.9, t: 0.8, r: 4 }),
        ],
      },
    ],
  },
  {
    id: 'load', name: 'Policy 2 · Least load', sub: 'Pick the emptiest server',
    steps: [
      {
        title: 'Count the viewers', sub: 'h1 arrives at an empty network', plane: 'control',
        text: 'Second idea: keep a counter of active sessions per server and send each newcomer to the <b>lowest count</b>. Everything is at zero when h1 arrives, so the tie goes to the nearest server, srv1.',
        facts: [['Signal', 'active sessions per server'], ['Tie', 'fewest hops'], ['Counter goes up', 'the instant a server is chosen']],
        code: 'sdn_controller.py · _choose_server',
        view: { paths: [{ n: P.h1s1, c: 'accent' }], badges: { srv1: { text: '0 → 1', after: 1.5 } },
                table: { head: ['Server', 'Sessions', 'Hops'], rows: [['srv1', '0', '2'], ['srv2', '0', '4'], ['srv3', '0', '3'], ['srv4', '0', '5']], win: 0 } },
        ev: [
          { t: 0, d: 0.7, p: ['h1', 'e1'], k: 'data', l: 'SYN' },
          { t: 0.8, d: 0.9, p: ['e1', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e1', 'controller', 'OpenFlow', 'h1: all servers at 0, nearest wins'] },
          ...videoLoop('srv1', rev(P.h1s1), { t: 1.8, n: 4, l: 'video', log: 1 }),
        ],
      },
      {
        title: 'The next two spread out', sub: 'h2 and h3 from the same city', plane: 'control',
        text: 'h2 arrives. srv1 is at one session, so it is skipped and the nearest empty server wins: <b>srv3</b>. Then h3: srv1 and srv3 are taken, <b>srv2</b> is nearer than srv4. Three neighbours, three different servers. Under hop count all three would be fighting over srv1.',
        facts: [['h1, h2, h3', 'srv1, srv3, srv2'], ['Quality in my test', 'all three at 720p'], ['Stalls', '0']],
        code: 'sdn_controller.py · _handle_vip',
        view: { paths: [{ n: P.h1s1, c: 'accent' }, { n: ['h2', 'e1', 'c1', 'srv3'], c: 'blue' }, { n: ['h3', 'e1', 'e2', 'e3', 'srv2'], c: 'amber' }],
                badges: { srv1: { text: '1 session' }, srv3: { text: '1 session', after: 1.0 }, srv2: { text: '1 session', after: 2.6 } },
                table: { head: ['Client', 'Server', 'Hops'], rows: [['h1', 'srv1', '2'], ['h2', 'srv3', '3'], ['h3', 'srv2', '4']] } },
        ev: [
          ...videoLoop('srv1', rev(P.h1s1), { n: 7, gap: 0.8 }),
          { t: 0.2, d: 0.8, p: ['h2', 'e1', 'ctl'], k: 'ctrl', l: 'h2', log: ['e1', 'controller', 'OpenFlow', 'VIP: h2 -> srv3  path h2-e1-c1-srv3'] },
          ...videoLoop('srv3', ['srv3', 'c1', 'e1', 'h2'], { t: 1.2, n: 6, gap: 0.8 }),
          { t: 1.8, d: 0.8, p: ['h3', 'e1', 'ctl'], k: 'ctrl', l: 'h3', log: ['e1', 'controller', 'OpenFlow', 'VIP: h3 -> srv2  path h3-e1-e2-e3-srv2'] },
          ...videoLoop('srv2', ['srv2', 'e3', 'e2', 'e1', 'h3'], { t: 2.8, n: 4, gap: 0.8 }),
        ],
      },
      {
        title: 'Strength and blind spot', sub: 'Fast to react, blind to size', plane: 'both',
        text: 'The counter changes the <b>instant</b> a server is assigned, with nothing to measure and nothing to wait for. That made this the most predictable policy when all nine viewers arrived at once. Its blind spot: one session on a 10 Mbps cache counts the same as one session on the 100 Mbps data center.',
        facts: [['Spread (flash crowd)', '2.8 / 2.2 / 2.0 / 2.0'], ['Run-to-run spread', '±17 kbps (most stable)'], ['Blind to', 'link capacity and delay']],
        code: 'experiments/results',
        view: { linkLabels: 'bw', badges: { srv1: { text: '1 session = 1 session' }, srv4: { text: '1 session = 1 session' } }, focus: [...SERVERS, ...SWITCHES] },
        ev: [],
      },
    ],
  },
  {
    id: 'bw', name: 'Policy 3 · Bandwidth', sub: 'Pick the widest free path',
    steps: [
      {
        title: 'Ask the switches', sub: 'Byte counters, every two seconds', plane: 'control',
        text: 'To know how busy a link is, the controller asks every switch for its <b>port counters</b> every 2 seconds. The counters only ever grow, so the speed is the difference between two readings divided by the time between them.',
        facts: [['Request', 'OFPPortStatsRequest'], ['Interval', '2 s'], ['Free capacity', 'link capacity minus measured use']],
        code: 'sdn_controller.py · _monitor · _port_stats_reply',
        view: { ctl: true },
        ev: SWITCHES.flatMap((s, i) => [
          { t: i * 0.15, d: 0.9, p: ['ctl', s], k: 'ctrl', l: i ? '' : 'stats?', log: i ? null : ['controller', 'all switches', 'OpenFlow', 'Port stats request'] },
          { t: i * 0.15 + 1.0, d: 0.9, p: [s, 'ctl'], k: 'ctrl', l: i ? '' : 'tx bytes', log: i ? null : ['all switches', 'controller', 'OpenFlow', 'Port stats reply: tx/rx bytes per port'] },
        ]),
      },
      {
        title: 'A path is as wide as its thinnest link', sub: 'The bottleneck rule', plane: 'control',
        text: 'For each server the controller walks the path and takes the <b>smallest</b> free capacity on it. Video flows from server to client, so links are read in that direction. On an empty network the remote data center wins for h1: 40 Mbps, limited by the e1-c1 link.',
        facts: [['srv4 path', '100 · 60 · 100 · 40 · 50 → 40 Mbps'], ['srv3 path', '20 · 40 · 50 → 20 Mbps'], ['Chosen', 'srv4']],
        code: 'sdn_controller.py · _path_free',
        view: { linkLabels: 'bw', paths: [{ n: P.h1s4, c: 'accent' }],
                table: { head: ['Server', 'Free (Mbps)'], rows: [['srv1', '10'], ['srv2', '10'], ['srv3', '20'], ['srv4', '40']], win: 3 } },
        ev: [
          { t: 0.2, d: 1.0, p: ['e1', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e1', 'controller', 'OpenFlow', "BW h1: {'srv1': 10.0, 'srv2': 10.0, 'srv3': 20.0, 'srv4': 40.0}"] },
          ...videoLoop('srv4', rev(P.h1s4), { t: 1.4, n: 4, d: 2.6, l: 'video' }),
        ],
      },
      {
        title: 'The herd', sub: 'Everyone reads the same old numbers', plane: 'both',
        text: 'The measurement is up to 2 seconds old. When nine viewers arrive together, every one of them sees the same "srv4 is empty" and they all <b>stampede</b> to it: 7.8 of 9 on average. srv4 is big enough to take it, so quality was the highest in the flash crowd, but it was also the least repeatable policy, and it ignores the 30 ms it costs to get there.',
        facts: [['On srv4 (flash crowd)', '7.8 of 9 clients'], ['Average quality', '3660 kbps (highest)'], ['Run-to-run spread', '±491 kbps (most erratic)']],
        code: 'experiments/results',
        view: { hot: [['c2', 'd1']], badges: { srv4: { text: '7.8 sessions' }, srv1: { text: 'idle' }, srv2: { text: 'idle' } } },
        ev: [
          ...['h1', 'h2', 'h3'].flatMap((h, i) => videoLoop('srv4', ['srv4', 'd1', 'c2', 'c1', 'e1', h], { n: 4, gap: 1.0, d: 2.6, t: i * 0.3, r: 4 })),
          ...['h4', 'h5', 'h6'].flatMap((h, i) => videoLoop('srv4', ['srv4', 'd1', 'c2', 'e2', h], { n: 4, gap: 1.0, d: 2.2, t: 0.1 + i * 0.3, r: 4 })),
          ...['h7', 'h8', 'h9'].flatMap((h, i) => videoLoop('srv4', ['srv4', 'd1', 'c2', 'e3', h], { n: 4, gap: 1.0, d: 2.2, t: 0.2 + i * 0.3, r: 4 })),
        ],
      },
    ],
  },
  {
    id: 'delay', name: 'Policy 4 · Delay', sub: 'Pick the fastest round trip',
    steps: [
      {
        title: 'Timing a link', sub: 'A probe that comes straight back', plane: 'control',
        text: 'I did not want to read delays from a config file, so the controller <b>measures</b> them. It gives e1 a probe packet for the e2 port and starts a stopwatch. e2 has no rule for the probe and returns it. The stopwatch now shows the link <i>plus</i> two trips on the control channel.',
        facts: [['Probe', 'custom ethertype 0x88b5'], ['Payload', '"e1,e2"'], ['Measured', 'control(e1) + link + control(e2)']],
        code: 'sdn_controller.py · _send_probe · _probe_in',
        view: { ctl: true, paths: [{ n: ['e1', 'e2'], c: 'amber' }] },
        ev: [
          { t: 0, d: 1.0, p: ['ctl', 'e1'], k: 'ctrl', l: 'packet-out', log: ['controller', 'e1', 'OpenFlow', 'Packet-out: probe "e1,e2" on port 5 · stopwatch starts'] },
          { t: 1.1, d: 1.4, p: ['e1', 'e2'], k: 'probe', l: 'probe', log: ['e1', 'e2', 'Probe', 'ethertype 0x88b5'] },
          { t: 2.6, d: 1.0, p: ['e2', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e2', 'controller', 'OpenFlow', 'Packet-in: probe is back · total 7.0 ms'] },
        ],
      },
      {
        title: 'Subtract the control channel', sub: 'An echo to each switch', plane: 'control',
        text: 'To remove those two trips, the controller sends each switch an <b>echo</b> and times the round trip. Half of each echo is one trip. What is left is the link itself: here 7 − 1 − 1 = <b>5 ms</b>, which is what the link was configured with.',
        facts: [['Formula', 'total − echo(e1)/2 − echo(e2)/2'], ['Example', '7.0 − 1.0 − 1.0 = 5.0 ms'], ['Round', 'every 5 s']],
        code: 'sdn_controller.py · _delay_monitor · _echo_reply',
        view: { ctl: true, paths: [{ n: ['e1', 'e2'], c: 'amber' }], badges: { e1: { text: 'echo 2 ms', after: 1.9 }, e2: { text: 'echo 2 ms', after: 2.1 } } },
        ev: [
          { t: 0, d: 0.9, p: ['ctl', 'e1'], k: 'ctrl', l: 'echo', log: ['controller', 'e1', 'OpenFlow', 'Echo request'] },
          { t: 1.0, d: 0.9, p: ['e1', 'ctl'], k: 'ctrl', log: ['e1', 'controller', 'OpenFlow', 'Echo reply · round trip 2.0 ms'] },
          { t: 0.2, d: 0.9, p: ['ctl', 'e2'], k: 'ctrl', l: 'echo', log: ['controller', 'e2', 'OpenFlow', 'Echo request'] },
          { t: 1.2, d: 0.9, p: ['e2', 'ctl'], k: 'ctrl', log: ['e2', 'controller', 'OpenFlow', 'Echo reply · round trip 2.0 ms'] },
        ],
      },
      {
        title: 'Servers cannot return a probe', sub: 'So the controller pings them', plane: 'control',
        text: 'A server is not a switch. It would simply drop my probe, and its link would look like 0 ms. The fix: the controller builds a real <b>ping</b>, with the virtual IP as its source, and sends it out of the switch port. The server answers, the answer returns to the same switch, and the link was crossed twice, so divide by two.',
        facts: [['Formula', '(total − echo(e1)) / 2'], ['srv1 link, measured', '18.4 ms median (configured 15)'], ['Client links', 'not measured: same on every path']],
        code: 'sdn_controller.py · _send_ping · _ping_in',
        view: { ctl: true, paths: [{ n: ['e1', 'srv1'], c: 'amber' }] },
        ev: [
          { t: 0, d: 0.9, p: ['ctl', 'e1'], k: 'ctrl', l: 'packet-out', log: ['controller', 'e1', 'OpenFlow', 'Packet-out: ICMP echo, src 10.0.0.100'] },
          { t: 1.0, d: 1.2, p: ['e1', 'srv1'], k: 'probe', l: 'ping', log: ['10.0.0.100', '10.0.0.11', 'ICMP', 'Echo request'] },
          { t: 2.3, d: 1.2, p: ['srv1', 'e1'], k: 'probe', l: 'pong', log: ['10.0.0.11', '10.0.0.100', 'ICMP', 'Echo reply'] },
          { t: 3.6, d: 0.9, p: ['e1', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e1', 'controller', 'OpenFlow', 'Packet-in: reply from srv1'] },
        ],
      },
      {
        title: 'A surprise: it feels the load', sub: 'Queues show up as delay', plane: 'both',
        text: 'While h4 was filling its buffer from srv2, the 10 Mbps link was full, and my ping reply had to <b>wait in the queue</b> behind video. The 2 ms link measured 33 ms. When h7 arrived the controller thought srv2 was slow and sent it to srv3 instead. A measured delay notices congestion. A configured one never could.',
        facts: [['e3-srv2 when idle', '2 ms'], ['e3-srv2 under load', '33 ms'], ['h7 was sent to', 'srv3 instead of srv2']],
        code: 'sdn_controller.py · _path_delay',
        view: { ctl: true, hot: [['e3', 'srv2']], paths: [{ n: ['h7', 'e3', 'c2', 'c1', 'srv3'], c: 'accent', after: 3.2 }], badges: { srv2: { text: 'measured 33 ms' } } },
        ev: [
          ...videoLoop('srv2', ['srv2', 'e3', 'e2', 'h4'], { n: 7, gap: 0.55, d: 1.8, l: 'h4 video' }),
          { t: 0.5, d: 1.0, p: ['e3', 'srv2'], k: 'probe', l: 'ping' },
          { t: 1.5, d: 2.2, p: ['srv2', 'e3'], k: 'probe', l: 'pong (queued)', log: ['10.0.0.12', '10.0.0.100', 'ICMP', 'Echo reply, stuck behind video segments'] },
          { t: 3.3, d: 0.9, p: ['h7', 'e3', 'ctl'], k: 'ctrl', l: 'h7', log: ['e3', 'controller', 'OpenFlow', "DELAY h7 (ms): {'srv1': 24.6, 'srv2': 33.0, 'srv3': 20.1, 'srv4': 33.5}"] },
        ],
      },
      {
        title: 'Weak spot: the flash crowd', sub: 'Good numbers, five seconds too late', plane: 'both',
        text: 'A round takes 5 seconds. If nine viewers arrive within the same instant, all of them are judged with the measurements of an <b>empty</b> network. Cities A and B all picked srv3, six viewers on a 20 Mbps link. This policy had the most stalls in my flash-crowd test.',
        facts: [['On srv3 (flash crowd)', '6 of 9 clients'], ['Stalls per run', '1.2 (highest)'], ['Average quality', '2024 kbps']],
        code: 'experiments/results',
        view: { hot: [['c1', 'srv3']], badges: { srv3: { text: '6 sessions' }, srv2: { text: '3 sessions' }, srv1: { text: 'idle' }, srv4: { text: 'idle' } } },
        ev: [
          ...['h1', 'h2', 'h3'].flatMap((h, i) => videoLoop('srv3', ['srv3', 'c1', 'e1', h], { n: 5, gap: 1.0, t: i * 0.3, r: 4 })),
          ...['h4', 'h5', 'h6'].flatMap((h, i) => videoLoop('srv3', ['srv3', 'c1', 'e2', h], { n: 5, gap: 1.0, t: 0.15 + i * 0.3, r: 4 })),
          ...['h7', 'h8', 'h9'].flatMap((h, i) => videoLoop('srv2', ['srv2', 'e3', h], { n: 5, gap: 1.0, t: i * 0.3, r: 4 })),
        ],
      },
    ],
  },
  {
    id: 'combo', name: 'Policy 5 · Combo', sub: 'All four signals in one score',
    steps: [
      {
        title: 'Four signals, one score', sub: 'First make them comparable', plane: 'control',
        text: 'Hops, milliseconds, Mbps and session counts cannot be added up as they are. So each one is divided by the <b>largest value among the candidates</b>, which puts everything between 0 and 1. Bandwidth is flipped, because for bandwidth more is better. Then a weighted sum, 25% each. <b>Lowest score wins.</b>',
        facts: [['Score', '0.25·hop + 0.25·delay + 0.25·(1 − bw) + 0.25·load'], ['Each term', 'value / max over the 4 servers'], ['Winner', 'smallest score']],
        code: 'sdn_controller.py · _choose_server · WEIGHTS',
        view: { ctl: true },
        ev: [],
      },
      {
        title: 'Worked example: h1', sub: 'Numbers from a real run', plane: 'control',
        text: 'h1 arrives at an empty network. srv1 is nearest but thin and slow. srv4 is the worst on hops <i>and</i> delay. <b>srv3</b> is not the best at any single thing, yet it is good at everything, and it wins clearly.',
        facts: [['Chosen', 'srv3'], ['Result', '720p · startup 0.14 s · 0 stalls']],
        code: 'sdn_controller.py · _choose_server',
        view: { ctl: true, paths: [{ n: P.h1s3, c: 'accent' }],
                table: { head: ['Server', 'Hops', 'Delay', 'Free', 'Score'], rows: [['srv1', '2', '14.0 ms', '10', '0.32'], ['srv2', '4', '8.9 ms', '10', '0.39'], ['srv3', '3', '2.0 ms', '20', '0.16'], ['srv4', '5', '35.2 ms', '20', '0.50']], win: 2 } },
        ev: [
          { t: 0, d: 0.7, p: ['h1', 'e1'], k: 'data', l: 'SYN' },
          { t: 0.8, d: 0.9, p: ['e1', 'ctl'], k: 'ctrl', l: 'packet-in', log: ['e1', 'controller', 'OpenFlow', 'COMBO h1: srv1 0.32 · srv2 0.39 · srv3 0.16 · srv4 0.50'] },
          ...videoLoop('srv3', rev(P.h1s3), { t: 1.9, n: 4, l: 'video' }),
        ],
      },
      {
        title: 'Then h2 and h3', sub: 'The score moves as the network fills', plane: 'control',
        text: 'With h1 streaming, srv3 now carries a session and has less free bandwidth, so its score jumps from 0.16 to 0.49. h2 goes to srv1. For h3 both are busy and <b>srv2</b> wins. Three neighbours on three servers, all at 720p with no stalls.',
        facts: [['h1, h2, h3', 'srv3, srv1, srv2'], ['My prediction before the test', 'the same three']],
        code: 'sdn_controller.py · _choose_server',
        view: { paths: [{ n: P.h1s3, c: 'accent' }, { n: ['h2', 'e1', 'srv1'], c: 'blue' }, { n: ['h3', 'e1', 'e2', 'e3', 'srv2'], c: 'amber' }],
                table: { head: ['Client', 'srv1', 'srv2', 'srv3', 'srv4'], rows: [['h1', '0.32', '0.39', '<b>0.16</b>', '0.50'], ['h2', '<b>0.32</b>', '0.40', '0.49', '0.50'], ['h3', '0.76', '<b>0.38</b>', '0.48', '0.50']] } },
        ev: [
          ...videoLoop('srv3', rev(P.h1s3), { n: 7, gap: 0.8 }),
          ...videoLoop('srv1', ['srv1', 'e1', 'h2'], { t: 1.0, n: 6, gap: 0.8 }),
          ...videoLoop('srv2', ['srv2', 'e3', 'e2', 'e1', 'h3'], { t: 2.2, n: 4, gap: 0.8 }),
        ],
      },
      {
        title: 'Verdict', sub: 'Best when it has time to measure', plane: 'both',
        text: 'When viewers arrived a few seconds apart, combo was the <b>best policy on every metric</b>: highest quality, fastest start, fewest quality changes, no stalls. In a flash crowd it fell behind plain load counting. Three quarters of its score comes from signals that are stale or never change in that instant, so the one live signal gets diluted.',
        facts: [['Gradual arrivals', '4581 kbps · 0 stalls (best)'], ['Flash crowd', '3176 kbps (third)'], ['Lesson', 'a signal is only as good as it is fresh']],
        code: 'experiments/results',
        view: {},
        ev: [],
      },
    ],
  },
  {
    id: 'dash', name: 'The video (DASH)', sub: 'What the clients actually do',
    steps: [
      {
        title: 'Video in two-second pieces', sub: 'Every piece exists in three qualities', plane: 'data',
        text: 'The video is cut into <b>2-second segments</b>, and each segment is encoded three times. A client downloads them one by one over plain HTTP, and it may pick a different quality for every segment. The servers are nothing more than Python\'s built-in web server.',
        facts: [['360p', '1 Mbps · ~250 KB per segment'], ['540p', '2.5 Mbps · ~615 KB'], ['720p', '5 Mbps · ~1.2 MB'], ['Encoder', 'ffmpeg · keyframe every 2 s']],
        code: 'prepare_video.sh',
        view: { paths: [{ n: P.h1s3, c: 'accent' }], focus: ['h1', 'e1', 'c1', 'srv3'] },
        ev: [
          { t: 0.0, d: 1.6, p: rev(P.h1s3), k: 'video', r: 4, l: '360p' },
          { t: 1.0, d: 1.6, p: rev(P.h1s3), k: 'video', r: 6, l: '540p' },
          { t: 2.0, d: 1.6, p: rev(P.h1s3), k: 'video', r: 9, l: '720p' },
        ],
      },
      {
        title: 'The client adapts', sub: 'Measure, then pick what fits', plane: 'data',
        text: 'My client times every download. For the next segment it picks the highest quality that fits into <b>80%</b> of the speed it just measured. It always starts at the lowest quality, because it knows nothing yet, then climbs.',
        facts: [['Rule', 'bitrate ≤ 0.8 × last speed'], ['Start', 'always 360p'], ['From srv3', '720p from the 2nd segment']],
        code: 'dash_client.py · choose',
        view: { paths: [{ n: P.h1s3, c: 'accent' }], focus: ['h1', 'e1', 'c1', 'srv3'],
                badges: { h1: { text: '360p', until: 1.9 } }, badges2: { h1: { text: '720p', after: 1.9 } } },
        ev: [
          { t: 0.0, d: 1.5, p: rev(P.h1s3), k: 'video', r: 4, l: 'seg 1', log: ['srv3', 'h1', 'HTTP', 'seg  1  1000 kbps  download 0.15s  speed 12.9 Mbps'] },
          { t: 1.8, d: 1.5, p: rev(P.h1s3), k: 'video', r: 9, l: 'seg 2', log: ['srv3', 'h1', 'HTTP', 'seg  2  5000 kbps  download 0.56s  speed 17.6 Mbps'] },
          { t: 3.5, d: 1.5, p: rev(P.h1s3), k: 'video', r: 9, l: 'seg 3', log: ['srv3', 'h1', 'HTTP', 'seg  3  5000 kbps  download 0.55s  speed 17.8 Mbps'] },
        ],
      },
      {
        title: 'Buffer, stalls and what I measure', sub: 'The numbers behind "good video"', plane: 'data',
        text: 'Downloaded segments wait in a <b>buffer</b> while playback drains it in real time. If a download is so slow that the buffer runs dry, the picture freezes: a <b>stall</b>. Two viewers sharing srv1\'s 10 Mbps cannot both hold 720p. For every client I record four things, and these are what the policies are judged on.',
        facts: [['Average quality', 'kbps, higher is better'], ['Startup time', 'until the first 2 s are buffered'], ['Stalls', 'buffer ran empty'], ['Quality switches', 'fewer is calmer']],
        code: 'dash_client.py · main',
        view: { hot: [['e1', 'srv1']], badges: { h1: { text: '540p' }, h2: { text: '540p' } }, focus: ['h1', 'h2', 'e1', 'srv1'] },
        ev: [
          ...videoLoop('srv1', ['srv1', 'e1', 'h1'], { n: 6, gap: 0.9, d: 2.0 }),
          ...videoLoop('srv1', ['srv1', 'e1', 'h2'], { n: 6, gap: 0.9, d: 2.0, t: 0.45 }),
        ],
      },
    ],
  },
  { id: 'sim', kind: 'sim', name: 'Simulator', sub: 'Try the five policies yourself', steps: [{ title: 'Simulator', sub: 'Click clients, switch policies' }] },
  {
    id: 'results', kind: 'results', name: 'Results', sub: '50 runs, 450 video sessions',
    steps: [
      {
        title: 'The experiment', sub: '5 policies × 2 scenarios × 5 runs', plane: 'both', show: 'both', metric: 'q',
        text: 'A script starts a fresh controller and network for every run, launches nine clients that each watch 30 seconds of video, and collects their logs. Within a run number every policy sees the <b>same arrival order</b>, so the comparison is fair. All 450 sessions finished.',
        facts: [['Flash crowd', 'all 9 clients at the same instant'], ['Gradual', 'one client every 3 seconds'], ['Total', '50 runs · 41 minutes']],
        code: 'experiments/run_experiment.py · analyze.py',
      },
      {
        title: 'Flash crowd', sub: 'Everybody presses play at once', plane: 'both', show: 'flash', metric: 'q',
        text: 'The hardest case, because nothing can be measured in time. <b>Bandwidth</b> scored highest by herding almost everyone onto the big data center, but swung wildly between runs. <b>Load</b> was nearly as good and rock steady. <b>Delay</b> crowded six viewers onto one 20 Mbps link and stalled the most. <b>Hop</b> was last by a wide margin.',
        facts: [['Highest quality', 'bw · 3660 kbps'], ['Most stable', 'load · ±17 kbps'], ['Most stalls', 'delay · 1.2 per run']],
        code: 'experiments/results/summary.md',
      },
      {
        title: 'Gradual arrivals', sub: 'Three seconds between viewers', plane: 'both', show: 'gradual', metric: 'q',
        text: 'Give the controller three seconds between viewers and the measuring policies come alive. <b>Combo wins everything</b>: best quality, fastest startup, calmest picture, zero stalls. Hop count stays stuck with the same 6 / 3 / 0 / 0 split because it never looks at the network at all.',
        facts: [['Best', 'combo · 4581 kbps · 0.30 s startup'], ['Runner-up', 'bw · 4439 kbps'], ['Worst', 'hop · 2378 kbps']],
        code: 'experiments/results/summary.md',
      },
      {
        title: 'What I took away', sub: 'There is no free lunch', plane: 'both', show: 'both', metric: 'q',
        text: '<b>1.</b> A signal is only as good as it is fresh. Session counts update instantly; measurements lag by seconds. <b>2.</b> Every single signal has a blind spot: hops ignore capacity, load ignores link size, bandwidth ignores distance, delay ignores a crowd that has not arrived yet. <b>3.</b> Combining them covers the blind spots, as long as there is time to measure.',
        facts: [['Next idea', 'reserve bandwidth the moment a server is assigned'], ['Next idea', 'smooth measurements over several rounds'], ['Next idea', 'route on the widest path, not the shortest']],
        code: 'docs/TECHNICAL.md',
      },
    ],
  },
];

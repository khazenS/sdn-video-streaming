"""Single source of truth for the topology.

Shared by the Mininet script (video_topo.py) and the controller (sdn_controller.py).
The order of entries matters: it determines Mininet port numbers and how the
controller breaks ties between servers.
"""

# Switch name -> DPID
SWITCHES = {'e1': 1, 'e2': 2, 'e3': 3, 'c1': 11, 'c2': 12, 'd1': 21}

# Server name -> IP address
SERVERS = {'srv1': '10.0.0.11', 'srv2': '10.0.0.12',
           'srv3': '10.0.0.13', 'srv4': '10.0.0.14'}

# (node 1, node 2, bandwidth in Mbps, delay)
LINKS = [
    # Edge servers
    ('e1', 'srv1', 10, '15ms'),
    ('e3', 'srv2', 10, '2ms'),

    # Clients - edge switches
    ('h1', 'e1', 50, '2ms'),
    ('h2', 'e1', 50, '2ms'),
    ('h3', 'e1', 50, '2ms'),
    ('h4', 'e2', 50, '2ms'),
    ('h5', 'e2', 50, '2ms'),
    ('h6', 'e2', 50, '2ms'),
    ('h7', 'e3', 50, '2ms'),
    ('h8', 'e3', 50, '2ms'),
    ('h9', 'e3', 50, '2ms'),

    # Edge - edge
    ('e1', 'e2', 20, '5ms'),
    ('e2', 'e3', 20, '5ms'),

    # Edge - core
    ('e1', 'c1', 40, '3ms'),
    ('e2', 'c1', 40, '3ms'),
    ('e2', 'c2', 40, '3ms'),
    ('e3', 'c2', 40, '3ms'),

    # Core, data center and their servers
    ('c1', 'c2', 100, '5ms'),
    ('c1', 'srv3', 20, '1ms'),
    ('c2', 'd1', 60, '30ms'),
    ('d1', 'srv4', 100, '1ms'),
]

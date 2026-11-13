#!/usr/bin/env python3
"""Automated experiment: every server-selection mode under two arrival scenarios.

Scenarios:
  flash    all 9 clients start at the same moment (flash crowd, e.g. a big trailer release)
  gradual  one client every --interval seconds (audience growing over the evening)

Each run starts a fresh ryu controller + Mininet network, so runs do not affect
each other. Runs are ordered run 1 (all modes), run 2 (all modes), ... so that an
interrupted experiment still has the same number of runs for every mode.

Run inside the VM (Mininet needs root). The full matrix (2 x 5 x 5 = 50 runs)
takes about 40 minutes, so start it detached:
    cd experiments
    mkdir -p results
    sudo setsid nohup python3 run_experiment.py > results/experiment.log 2>&1 &
    tail -f results/experiment.log

Quick test (1 run, 1 mode, separate output folder):
    sudo python3 run_experiment.py --modes hop --scenarios flash --runs 1 --out test_results

Raw output: <out>/<scenario>/<mode>/run<k>/{ryu.log, hN.log, srvN.log, meta.json}
A run that already has meta.json is skipped, so a crashed experiment can be resumed.
Then: python3 analyze.py
"""
import argparse
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
sys.path.insert(0, PROJECT)

from mininet.link import TCLink                      # noqa: E402
from mininet.log import setLogLevel                  # noqa: E402
from mininet.net import Mininet                      # noqa: E402
from mininet.node import OVSSwitch, RemoteController  # noqa: E402

from net_config import LINKS, SERVERS, SWITCHES      # noqa: E402
from video_topo import VideoTopo                     # noqa: E402

CONTROLLER = os.path.join(PROJECT, 'sdn_controller.py')
CLIENT = os.path.join(PROJECT, 'dash_client.py')
VIP_URL = 'http://10.0.0.100'
WORK_DIR = '/tmp/sdn-experiment'     # local disk: client logs are polled, a network mount may cache reads

CLIENTS = ['h%d' % i for i in range(1, 10)]
MODES = ['hop', 'load', 'bw', 'delay', 'combo']
SCENARIOS = ['flash', 'gradual']

# Log lines printed by sdn_controller.py / dash_client.py that we wait for.
# Keep in sync if those messages are ever renamed.
LINK_FOUND = 'Link found'
HOST_FOUND = re.compile(r'Host found: (\S+)')
DELAY_ROUND = 'Link delay (ms):'     # periodic round, not the per-client 'DELAY hN (ms):'
CLIENT_DONE = re.compile(r'^(startup |Traceback)', re.M)

# LLDP reports every switch-switch link once per direction
N_TRUNK_LINKS = 2 * sum(1 for a, b, _, _ in LINKS if a in SWITCHES and b in SWITCHES)
N_HOSTS = len(CLIENTS) + len(SERVERS)

WARMUP = 5            # s after host discovery: bw monitor needs two port-stats samples
CLIENT_TIMEOUT = 240  # s for all clients to finish (30 s of video, overloaded modes are slower)


def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return ''


def wait_for(check, timeout, step=0.5):
    """Poll check() until it returns True or timeout seconds pass."""
    end = time.time() + timeout
    while time.time() < end:
        if check():
            return True
        time.sleep(step)
    return False


def other_network_running():
    bridges = subprocess.run(['ovs-vsctl', 'list-br'], capture_output=True,
                             text=True).stdout.split()
    # a controller is running if something listens on the OpenFlow port
    listening = subprocess.run(['ss', '-Hltn', 'sport = :6653'], capture_output=True,
                               text=True).stdout.strip()
    return bool(bridges) or bool(listening)


def start_cpu_burn():
    """Busy loops at the lowest priority. While the VM is idle its timer is coarse and
    netem delays come out ~3x too high; keeping the CPUs busy fixes that."""
    return [subprocess.Popen(['nice', '-n', '19', 'sh', '-c', 'while :; do :; done'])
            for _ in range(os.cpu_count() or 2)]


def start_bg(host, cmd, logfile):
    """Start cmd in the background on a Mininet host and return its PID."""
    out = host.cmd('%s > %s 2>&1 & echo $!' % (cmd, logfile))
    return int(out.split()[-1])


def delay_ready(ryu_log):
    """True once a delay round has measured the links to all servers."""
    rounds = [line for line in read(ryu_log).splitlines() if DELAY_ROUND in line]
    return bool(rounds) and all('-%s ' % srv in rounds[-1] for srv in SERVERS)


def run_one(scenario, mode, run, work, interval, ryu_bin, video_dir):
    """One experiment run. Raw logs are written to work/."""
    ryu_log = os.path.join(work, 'ryu.log')
    # Same arrival order for every mode within a run -> modes see identical input
    order = CLIENTS[:]
    random.Random(run).shuffle(order)

    ryu = net = None
    pids = []
    try:
        with open(ryu_log, 'w') as f:
            env = dict(os.environ, LB_MODE=mode, PYTHONUNBUFFERED='1')
            ryu = subprocess.Popen([ryu_bin, '--observe-links', CONTROLLER], cwd=PROJECT,
                                   env=env, stdout=f, stderr=subprocess.STDOUT)
        time.sleep(3)

        net = Mininet(topo=VideoTopo(), link=TCLink, switch=OVSSwitch, controller=None)
        net.addController('c0', controller=RemoteController, ip='127.0.0.1', port=6653)
        net.start()

        if not wait_for(lambda: read(ryu_log).count(LINK_FOUND) >= N_TRUNK_LINKS, 60):
            raise RuntimeError('LLDP did not find all %d links' % N_TRUNK_LINKS)

        # One ARP from every host so the controller learns where it is.
        # 10.0.0.250 does not exist: proxy ARP ignores it, no other side effects.
        for host in net.hosts:
            host.cmd('ping -c1 -W1 10.0.0.250 > /dev/null 2>&1 &')
        found = lambda: set(HOST_FOUND.findall(read(ryu_log)))  # noqa: E731
        if not wait_for(lambda: len(found()) >= N_HOSTS, 30):
            raise RuntimeError('hosts not found: %s' % sorted((set(CLIENTS) | set(SERVERS)) - found()))

        for srv in SERVERS:
            host = net.get(srv)
            pids.append(start_bg(host, 'python3 -m http.server 80 --directory %s' % video_dir,
                                 os.path.join(work, srv + '.log')))

        time.sleep(WARMUP)
        if mode in ('delay', 'combo') and not wait_for(lambda: delay_ready(ryu_log), 30):
            raise RuntimeError('delay measurement did not cover all servers')

        t0 = time.time()
        starts = {}
        for i, client in enumerate(order):
            if scenario == 'gradual':
                time.sleep(max(0.0, t0 + i * interval - time.time()))
            starts[client] = round(time.time() - t0, 2)
            pids.append(start_bg(net.get(client), 'python3 -u %s %s' % (CLIENT, VIP_URL),
                                 os.path.join(work, client + '.log')))

        done = lambda c: CLIENT_DONE.search(read(os.path.join(work, c + '.log')))  # noqa: E731
        wait_for(lambda: all(done(c) for c in CLIENTS), CLIENT_TIMEOUT, step=1)
        unfinished = [c for c in CLIENTS if not done(c)]

        return {'scenario': scenario, 'mode': mode, 'run': run, 'order': order,
                'start_offsets': starts, 'unfinished': unfinished,
                'duration_s': round(time.time() - t0, 1),
                'finished_at': time.strftime('%Y-%m-%d %H:%M:%S')}
    finally:
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if net is not None:
            net.stop()
        if ryu is not None:
            ryu.terminate()
            try:
                ryu.wait(10)
            except subprocess.TimeoutExpired:
                ryu.kill()


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--modes', default=','.join(MODES))
    p.add_argument('--scenarios', default=','.join(SCENARIOS))
    p.add_argument('--runs', type=int, default=5)
    p.add_argument('--interval', type=float, default=3.0,
                   help='seconds between clients in the gradual scenario')
    p.add_argument('--out', default=os.path.join(HERE, 'results'))
    p.add_argument('--no-cpu-burn', action='store_true')
    p.add_argument('--ryu', default=shutil.which('ryu-manager'),
                   help='path to ryu-manager (default: the one on PATH)')
    p.add_argument('--video-dir', default=os.path.join(PROJECT, 'video'),
                   help='DASH video made by prepare_video.sh')
    args = p.parse_args()
    modes, scenarios = args.modes.split(','), args.scenarios.split(',')
    out_root = os.path.abspath(args.out)

    if os.geteuid() != 0:
        sys.exit('Mininet needs root: sudo python3 run_experiment.py')
    if other_network_running():
        sys.exit('Another Mininet network or ryu-manager is running. Close it first '
                 '(exit in the Mininet CLI, Ctrl+C in ryu).')
    if not args.ryu or not shutil.which(args.ryu):
        sys.exit('ryu-manager not found: pass its path with --ryu')
    ryu_bin = os.path.abspath(shutil.which(args.ryu))   # ryu is started with cwd=PROJECT
    video_dir = os.path.abspath(args.video_dir)
    if not os.path.isdir(video_dir):
        sys.exit('Video not found: %s (run prepare_video.sh)' % video_dir)
    for m in modes:
        if m not in MODES:
            sys.exit('Unknown mode: %s' % m)
    for s in scenarios:
        if s not in SCENARIOS:
            sys.exit('Unknown scenario: %s' % s)

    setLogLevel('warning')
    plan = [(s, m, r) for r in range(1, args.runs + 1) for s in scenarios for m in modes]
    log('%d runs -> %s' % (len(plan), out_root))
    burners = [] if args.no_cpu_burn else start_cpu_burn()
    try:
        for k, (scenario, mode, run) in enumerate(plan, 1):
            dest = os.path.join(out_root, scenario, mode, 'run%d' % run)
            if os.path.exists(os.path.join(dest, 'meta.json')):
                log('[%d/%d] %s %s run %d: already done, skipped' % (k, len(plan), scenario, mode, run))
                continue
            for attempt in (1, 2):
                log('[%d/%d] %s %s run %d (attempt %d)' % (k, len(plan), scenario, mode, run, attempt))
                shutil.rmtree(WORK_DIR, ignore_errors=True)
                os.makedirs(WORK_DIR)
                try:
                    meta = run_one(scenario, mode, run, WORK_DIR, args.interval,
                                   ryu_bin, video_dir)
                except Exception as e:  # noqa: BLE001  (log it and retry once)
                    log('  FAILED: %r' % e)
                    subprocess.run(['mn', '-c'], capture_output=True)
                    continue
                with open(os.path.join(WORK_DIR, 'meta.json'), 'w') as f:
                    json.dump(meta, f, indent=2)
                shutil.rmtree(dest, ignore_errors=True)
                shutil.copytree(WORK_DIR, dest)
                log('  done in %.0f s, unfinished clients: %s'
                    % (meta['duration_s'], meta['unfinished'] or 'none'))
                break
            time.sleep(2)
    finally:
        for b in burners:
            b.terminate()
    log('Finished. Next: python3 analyze.py --results %s' % out_root)


if __name__ == '__main__':
    main()

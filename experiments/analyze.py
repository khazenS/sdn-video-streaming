#!/usr/bin/env python3
"""Summarize the raw logs written by run_experiment.py.

    python3 analyze.py                      # reads ./results
    python3 analyze.py --results test_results

Writes <results>/summary.md (tables per scenario) and <results>/clients.csv
(one row per client per run, for plots). Needs only the standard library.
"""
import argparse
import csv
import glob
import json
import os
import re
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
MODES = ['hop', 'load', 'bw', 'delay', 'combo']
SERVERS = ['srv1', 'srv2', 'srv3', 'srv4']

# Last line of dash_client.py and the assignment line of sdn_controller.py.
# Keep in sync if those messages are ever renamed.
SUMMARY = re.compile(r'startup (-?[\d.]+) s \| avg quality (\d+) kbps \| '
                     r'stalls (\d+) \| quality switches (\d+)')
ASSIGNED = re.compile(r'VIP: (h\d+) -> (srv\d+)')


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return ''


def load_run(run_dir):
    """Return (meta, rows): one row per client of this run."""
    with open(os.path.join(run_dir, 'meta.json')) as f:
        meta = json.load(f)
    servers = {}
    for client, srv in ASSIGNED.findall(read(os.path.join(run_dir, 'ryu.log'))):
        servers.setdefault(client, srv)          # first assignment = session start
    rows = []
    for client in meta['order']:
        m = SUMMARY.search(read(os.path.join(run_dir, client + '.log')))
        row = {'scenario': meta['scenario'], 'mode': meta['mode'], 'run': meta['run'],
               'client': client, 'server': servers.get(client, ''),
               'start_offset_s': meta['start_offsets'].get(client, ''),
               'finished': bool(m)}
        if m:
            startup = float(m.group(1))
            row.update(startup_s=startup if startup >= 0 else None,
                       quality_kbps=int(m.group(2)), stalls=int(m.group(3)),
                       switches=int(m.group(4)))
        rows.append(row)
    return meta, rows


def mean(values):
    values = [v for v in values if v is not None]
    return statistics.mean(values) if values else None


def fmt(value, digits=0):
    return '-' if value is None else '%.*f' % (digits, value)


def summarize(rows):
    """Aggregate the rows of one (scenario, mode): per-run means, then mean over runs."""
    runs = sorted({r['run'] for r in rows})
    per_run_quality, per_run_stalls = [], []
    for run in runs:
        ok = [r for r in rows if r['run'] == run and r['finished']]
        per_run_quality.append(mean(r['quality_kbps'] for r in ok))
        per_run_stalls.append(sum(r['stalls'] for r in ok))
    ok = [r for r in rows if r['finished']]
    quality = [q for q in per_run_quality if q is not None]
    return {
        'runs': len(runs),
        'quality': mean(quality),
        'quality_min': min(quality) if quality else None,
        'quality_max': max(quality) if quality else None,
        'quality_std': statistics.stdev(quality) if len(quality) > 1 else None,
        'startup': mean(r['startup_s'] for r in ok),
        'stalls_per_run': mean(per_run_stalls),
        'clients_stalled': sum(1 for r in ok if r['stalls'] > 0),
        'switches': mean(r['switches'] for r in ok),
        'failed': sum(1 for r in rows if not r['finished']),
        'servers': {s: sum(1 for r in rows if r['server'] == s) / len(runs) for s in SERVERS},
    }


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--results', default=os.path.join(HERE, 'results'))
    args = p.parse_args()

    rows = []
    for meta_path in sorted(glob.glob(os.path.join(args.results, '*', '*', 'run*', 'meta.json'))):
        rows += load_run(os.path.dirname(meta_path))[1]
    if not rows:
        raise SystemExit('No finished runs in %s' % args.results)

    fields = ['scenario', 'mode', 'run', 'client', 'server', 'start_offset_s', 'finished',
              'startup_s', 'quality_kbps', 'stalls', 'switches']
    with open(os.path.join(args.results, 'clients.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    lines = ['# Experiment summary', '',
             'Quality = mean bitrate a client watched (1000 / 2500 / 5000 kbps = 360p / 540p / 720p).',
             'Values are averaged per run first, then over runs; min-max and std show how',
             'much the runs differ from each other. Servers = average clients per run.', '']
    for scenario in sorted({r['scenario'] for r in rows}):
        lines += ['## %s' % scenario, '',
                  '| Mode | Runs | Quality (kbps) | Min-max | Std | Startup (s) | Stalls / run '
                  '| Clients stalled | Switches / client | Failed | srv1 / srv2 / srv3 / srv4 |',
                  '|---|---|---|---|---|---|---|---|---|---|---|']
        for mode in MODES:
            sel = [r for r in rows if r['scenario'] == scenario and r['mode'] == mode]
            if not sel:
                continue
            s = summarize(sel)
            lines.append('| %s | %d | %s | %s-%s | %s | %s | %s | %d | %s | %d | %s |' % (
                mode, s['runs'], fmt(s['quality']), fmt(s['quality_min']),
                fmt(s['quality_max']), fmt(s['quality_std']), fmt(s['startup'], 2),
                fmt(s['stalls_per_run'], 1), s['clients_stalled'], fmt(s['switches'], 1),
                s['failed'], ' / '.join(fmt(s['servers'][srv], 1) for srv in SERVERS)))
        lines.append('')

    text = '\n'.join(lines)
    with open(os.path.join(args.results, 'summary.md'), 'w') as f:
        f.write(text)
    print(text)


if __name__ == '__main__':
    main()

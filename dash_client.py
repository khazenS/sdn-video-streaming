#!/usr/bin/env python3
"""Simple DASH client. Run it on a Mininet host:
    python3 dash_client.py http://10.0.0.100

The video is really downloaded over HTTP; playback is simulated (there is no
screen): each segment adds to a buffer and elapsed time drains it.
"""
import sys
import time
import urllib.request

# Quality ladder (representation id, bitrate in bps); mirrors what
# prepare_video.sh encodes, so the MPD is not parsed.
REPS = [('0', 1_000_000), ('1', 2_500_000), ('2', 5_000_000)]
SEG = 2.0              # segment duration (s)
COUNT = 15             # segments to watch (15 x 2 = 30 s of video)
SAFETY = 0.8           # pick a quality that fits in 80% of the measured speed
STARTUP_BUFFER = 2.0   # playback starts once this much video is buffered
MAX_BUFFER = 10.0      # pause downloading while the buffer is above this


def fetch(url):
    """Download url, return (bytes, seconds)."""
    t0 = time.time()
    with urllib.request.urlopen(url, timeout=20) as resp:
        data = resp.read()
    return len(data), time.time() - t0


def choose(last_mbps):
    """ABR: return the (id, bitrate) for the next segment."""
    if last_mbps is None:          # first segment: speed still unknown
        return REPS[0]
    # Highest quality that fits the budget; REPS is sorted low to high
    budget = SAFETY * last_mbps * 1e6
    best = REPS[0]
    for rep in REPS:
        if rep[1] <= budget:
            best = rep
    return best


def main(base):
    for rid, _ in REPS:                    # init segments (codec setup)
        fetch('%s/init-stream%s.m4s' % (base, rid))

    buffer = 0.0
    playing = False
    start = time.time()
    startup = None
    stalls = 0
    last_mbps = None
    log = []

    for i in range(COUNT):
        # Buffer full: wait; playback keeps draining it meanwhile
        if buffer > MAX_BUFFER:
            wait = buffer - MAX_BUFFER
            time.sleep(wait)
            buffer -= wait

        rid, bw = choose(last_mbps)
        size, dt = fetch('%s/chunk-stream%s-%05d.m4s' % (base, rid, i + 1))
        last_mbps = size * 8 / dt / 1e6

        # Playback drained the buffer during the download; running dry is a stall
        if playing:
            buffer -= dt
            if buffer < 0:
                stalls += 1
                buffer = 0.0
                playing = False

        # (Re)start playback once enough video is buffered
        buffer += SEG
        if not playing and buffer >= STARTUP_BUFFER:
            playing = True
            if startup is None:
                startup = time.time() - start

        log.append(bw // 1000)
        print('seg %2d  %4d kbps  download %.2fs  speed %.1f Mbps  buffer %.1fs  %s'
              % (i + 1, bw // 1000, dt, last_mbps, buffer,
                 'playing' if playing else 'WAITING'))

    print('\nstartup %.2f s | avg quality %d kbps | stalls %d | quality switches %d'
          % (startup or -1, sum(log) / len(log), stalls,
             sum(1 for a, b in zip(log, log[1:]) if a != b)))


if __name__ == '__main__':
    main(sys.argv[1].rstrip('/'))

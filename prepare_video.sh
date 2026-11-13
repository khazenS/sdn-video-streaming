#!/bin/bash
# Generate the DASH test video: 60 s, 3 qualities (360p / 540p / 720p at
# 1 / 2.5 / 5 Mbps), 2 s segments.
#   bash prepare_video.sh [output_dir]     (default: video/ next to this script)
set -e
OUT="${1:-$(cd "$(dirname "$0")" && pwd)/video}"
DUR=60          # video length (s)
FPS=25

mkdir -p "$OUT"
rm -f "$OUT"/*.m4s "$OUT"/*.mpd

# Keyframe interval = FPS x segment duration (25 x 2). Every segment must start
# with a keyframe, otherwise a client that switches quality at a segment border
# cannot decode the new segment.
GOP=50

# Highest bitrate (5 Mbps) stays below the thinnest server link (10 Mbps).
ffmpeg -hide_banner -loglevel warning -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=$FPS" -t "$DUR" \
  -filter_complex "[0:v]noise=alls=10:allf=t,split=3[a][b][c];[a]scale=640:360[v0];[b]scale=960:540[v1];[c]null[v2]" \
  -map "[v0]" -map "[v1]" -map "[v2]" \
  -c:v libx264 -preset ultrafast -g $GOP -keyint_min $GOP -sc_threshold 0 \
  -x264opts nal-hrd=cbr \
  -b:v:0 1000k -maxrate:v:0 1000k -bufsize:v:0 1000k \
  -b:v:1 2500k -maxrate:v:1 2500k -bufsize:v:1 2500k \
  -b:v:2 5000k -maxrate:v:2 5000k -bufsize:v:2 5000k \
  -f dash -seg_duration 2 -use_template 1 -use_timeline 0 \
  -adaptation_sets "id=0,streams=v" \
  "$OUT/manifest.mpd"

echo "Done: $OUT"
du -sh "$OUT"

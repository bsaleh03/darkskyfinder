#!/usr/bin/env bash
# Upload the per-metro PMTiles (and only those) to Cloudflare R2 via rclone.
# Usage: scripts/upload_tiles.sh [--dry-run]
# Requires an rclone remote named "r2" (see README: `rclone config`, provider Cloudflare).
# Credentials live in your rclone config; this script never reads or prints them.
set -euo pipefail

DRY=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=(--dry-run) ;;
    *) echo "unknown argument: $arg (only --dry-run is supported)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/pipeline/out"
BUCKET="${R2_BUCKET:-darksky-tiles}"
METROS=(se_mi bay_area)
TILE_RE='^(basemap_[a-z_]+_(base|transportation|buildings|divisions)|lightpollution_[a-z_]+)\.pmtiles$'

command -v rclone >/dev/null || { echo "rclone not found on PATH" >&2; exit 1; }
rclone listremotes | grep -qx 'r2:' || {
  echo "rclone remote 'r2' not configured. Run 'rclone config' (S3 / Cloudflare) first." >&2; exit 1; }

for m in "${METROS[@]}"; do
  dir="$OUT/$m"
  [ -d "$dir" ] || { echo "missing $dir (run the pipeline first)" >&2; exit 1; }
  files=()
  for f in "basemap_${m}_base" "basemap_${m}_transportation" "basemap_${m}_buildings" \
           "basemap_${m}_divisions" "lightpollution_${m}"; do
    [ -f "$dir/$f.pmtiles" ] || { echo "missing $dir/$f.pmtiles" >&2; exit 1; }
    [[ "$f.pmtiles" =~ $TILE_RE ]] || { echo "refusing: unexpected file $f.pmtiles" >&2; exit 1; }
    files+=("--include" "$f.pmtiles")
  done
  # Explicit includes plus a final catch-all exclude: nothing else (.npz/.tif/.sqlite/.json) can go up.
  echo "== $m -> r2:$BUCKET/$m/"
  rclone copy "$dir" "r2:$BUCKET/$m/" "${files[@]}" --exclude "*" \
    --s3-upload-cutoff 100M --s3-chunk-size 64M --progress ${DRY[@]+"${DRY[@]}"}
done
echo "Done."

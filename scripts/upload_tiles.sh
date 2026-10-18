#!/usr/bin/env bash
# Upload the map files (and only those) to Cloudflare R2 via rclone: per-metro basemaps under <metro>/;
# the lower-48 light-pollution overlay (normal + red-mode), land shapes and land-only borders under us/.
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
DIRS=("${METROS[@]}" us)
TILE_RE='^(basemap_[a-z_]+_(base|transportation|buildings|divisions)|lightpollution_us(_red)?)\.pmtiles$'

tiles_for() {
  if [ "$1" = us ]; then echo "lightpollution_us.pmtiles lightpollution_us_red.pmtiles basemap_us_divisions.pmtiles"
  else echo "basemap_$1_base.pmtiles basemap_$1_transportation.pmtiles basemap_$1_buildings.pmtiles basemap_$1_divisions.pmtiles"; fi
}

command -v rclone >/dev/null || { echo "rclone not found on PATH" >&2; exit 1; }
REMOTES="$(rclone listremotes)"
grep -qx "r2:" <<<"$REMOTES" || {
  echo "rclone remote 'r2' not configured. Run 'rclone config' (S3 / Cloudflare) first." >&2; exit 1; }

for m in "${DIRS[@]}"; do
  dir="$OUT/$m"
  [ -d "$dir" ] || { echo "missing $dir (run the pipeline first; us/ comes from darksky_pipeline.us_glow)" >&2; exit 1; }
  files=()
  # The per-metro lightpollution_<metro>.pmtiles are no longer shown on the map and stay local.
  for f in $(tiles_for "$m"); do
    [ -f "$dir/$f" ] || { echo "missing $dir/$f" >&2; exit 1; }
    [[ "$f" =~ $TILE_RE ]] || { echo "refusing: unexpected file $f" >&2; exit 1; }
    files+=("--include" "$f")
  done
  # Explicit includes plus a final catch-all exclude: nothing else (.npz/.tif/.sqlite/.json) can go up.
  echo "== $m -> r2:$BUCKET/$m/"
  rclone copy "$dir" "r2:$BUCKET/$m/" "${files[@]}" --exclude "*" \
    --s3-upload-cutoff 100M --s3-chunk-size 64M --progress ${DRY[@]+"${DRY[@]}"}
done

# borders.geojson (~1 MB) goes up gzipped with Content-Encoding, so browsers fetch ~1/4 of it and unpack it.
borders="$OUT/us/borders.geojson"
[ -f "$borders" ] || { echo "missing $borders" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gzip -9 -c "$borders" > "$tmp/borders.geojson"
echo "== us/borders.geojson (gzip) -> r2:$BUCKET/us/"
rclone copyto "$tmp/borders.geojson" "r2:$BUCKET/us/borders.geojson"   --header-upload "Content-Encoding: gzip" --header-upload "Content-Type: application/geo+json"   --progress ${DRY[@]+"${DRY[@]}"}
echo "Done."

#!/usr/bin/env bash
# Upload the pre-rendered map pictures (and only those) to Cloudflare R2 via rclone:
# pipeline/out/maps/<metro>/web/ -> r2:$R2_BUCKET/maps/<metro>/ (manifest.json, labels.json and
# {base,base_red,glow,glow_red}_<width>.webp, every width the manifest lists). The bucket holds nothing else.
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
MAPS="$ROOT/pipeline/out/maps"
BUCKET="${R2_BUCKET:-darksky-tiles}"
METROS=(se_mi bay_area)
FILE_RE='^(manifest\.json|labels\.json|(base|base_red|glow|glow_red)_[0-9]+\.webp)$'

command -v rclone >/dev/null || { echo "rclone not found on PATH" >&2; exit 1; }
REMOTES="$(rclone listremotes)"
grep -qx "r2:" <<<"$REMOTES" || {
  echo "rclone remote 'r2' not configured. Run 'rclone config' (S3 / Cloudflare) first." >&2; exit 1; }

for m in "${METROS[@]}"; do
  dir="$MAPS/$m/web"
  [ -f "$dir/manifest.json" ] || {
    echo "missing $dir/manifest.json (run darksky_pipeline.static_maps, then 'npm run render-maps' in web/)" >&2; exit 1; }
  # The manifest's widths decide which pictures must exist; nothing outside the allow-list can go up.
  widths="$(tr -d '\r\n' <"$dir/manifest.json" | grep -o '"widths"[[:space:]]*:[[:space:]]*\[[^]]*\]' | grep -o '[0-9][0-9]*' || true)"
  [ -n "$widths" ] || { echo "no widths in $dir/manifest.json" >&2; exit 1; }
  files=(manifest.json labels.json)
  for w in $widths; do
    for k in base base_red glow glow_red; do files+=("${k}_${w}.webp"); done
  done
  includes=()
  for f in "${files[@]}"; do
    [ -f "$dir/$f" ] || { echo "missing $dir/$f" >&2; exit 1; }
    [[ "$f" =~ $FILE_RE ]] || { echo "refusing: unexpected file $f" >&2; exit 1; }
    includes+=("--include" "$f")
  done
  # Explicit includes plus a final catch-all exclude: nothing else in web/ can go up.
  echo "== $m (${#files[@]} files) -> r2:$BUCKET/maps/$m/"
  rclone copy "$dir" "r2:$BUCKET/maps/$m/" "${includes[@]}" --exclude "*" --progress ${DRY[@]+"${DRY[@]}"}
done
echo "Done."

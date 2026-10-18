#!/usr/bin/env bash
# Upload the pre-rendered map pictures (and only those) to Cloudflare R2 via rclone:
# pipeline/out/maps/<metro>/web/ -> r2:$R2_BUCKET/maps/<metro>/. The manifest decides every file name:
# manifest.json, labels.json, {base,base_red,glow,glow_red}_<width>.webp for every level-0 width it lists, and
# {base,base_red,glow,glow_red}_L<l>_<c>_<r>.webp for every tile of every level >= 1 (2 + 4x3 + 4x4 = 30 files
# per region with two levels). The bucket holds nothing else.
# Usage: scripts/upload_tiles.sh [--dry-run]
# Requires an rclone remote named "r2" (see README: `rclone config`, provider Cloudflare).
# Credentials live in your rclone config; this script never reads or prints them.
# MAPS_DIR overrides pipeline/out/maps (tests).
set -euo pipefail

DRY=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=(--dry-run) ;;
    *) echo "unknown argument: $arg (only --dry-run is supported)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAPS="${MAPS_DIR:-$ROOT/pipeline/out/maps}"
BUCKET="${R2_BUCKET:-darksky-tiles}"
METROS=(se_mi bay_area)
KINDS=(base base_red glow glow_red)
FILE_RE='^(manifest\.json|labels\.json|(base|base_red|glow|glow_red)_([0-9]+|L[1-9][0-9]*_[0-9]+_[0-9]+)\.webp)$'

command -v rclone >/dev/null || { echo "rclone not found on PATH" >&2; exit 1; }
REMOTES="$(rclone listremotes)"
grep -qx "r2:" <<<"$REMOTES" || {
  echo "rclone remote 'r2' not configured. Run 'rclone config' (S3 / Cloudflare) first." >&2; exit 1; }

total=0
for m in "${METROS[@]}"; do
  dir="$MAPS/$m/web"
  [ -f "$dir/manifest.json" ] || {
    echo "missing $dir/manifest.json (run darksky_pipeline.static_maps, then 'npm run render-maps' in web/)" >&2; exit 1; }
  manifest="$(tr -d '\r\n\t ' <"$dir/manifest.json")"
  # Level 0: the widths. Every picture kind at every width.
  widths="$(grep -o '"widths":\[[^]]*\]' <<<"$manifest" | grep -o '[0-9][0-9]*' || true)"
  [ -n "$widths" ] || { echo "no widths in $dir/manifest.json" >&2; exit 1; }
  files=(manifest.json labels.json)
  for w in $widths; do
    for k in "${KINDS[@]}"; do files+=("${k}_${w}.webp"); done
  done
  # Levels >= 1: every tile of the level's cols x rows grid, named by the manifest's tile templates.
  levels="$(grep -o '{"level":[0-9]*,"cols":[0-9]*,"rows":[0-9]*}' <<<"$manifest" | tr -dc '0-9,\n' || true)"
  [ -n "$levels" ] || { echo "no levels in $dir/manifest.json (render-maps writes manifest v2)" >&2; exit 1; }
  tiles="$(grep -oE '"tiles":[{]("[a-z_]+":"[^"]*",?)*[}]' <<<"$manifest" || true)"
  while IFS=, read -r level cols rows; do
    [ "$level" -ge 1 ] || continue
    for k in "${KINDS[@]}"; do
      tpl="$(grep -o "\"$k\":\"[^\"]*\"" <<<"$tiles" | sed 's/^"[^"]*":"//; s/"$//' || true)"
      [ -n "$tpl" ] || { echo "no tiles.$k in $dir/manifest.json" >&2; exit 1; }
      for ((c = 0; c < cols; c++)); do
        for ((r = 0; r < rows; r++)); do
          f="${tpl//\{l\}/$level}"; f="${f//\{c\}/$c}"; f="${f//\{r\}/$r}"
          files+=("$f")
        done
      done
    done
  done <<<"$levels"
  json=()
  webp=()
  for f in "${files[@]}"; do
    [ -f "$dir/$f" ] || { echo "missing $dir/$f" >&2; exit 1; }
    [[ "$f" =~ $FILE_RE ]] || { echo "refusing: unexpected file $f" >&2; exit 1; }
    case "$f" in
      *.json) json+=("--include" "$f") ;;
      *) webp+=("--include" "$f") ;;
    esac
  done
  total=$((total + ${#files[@]}))
  # Explicit includes plus a final catch-all exclude: nothing else in web/ can go up. The manifest and labels
  # may change on a re-render, so browsers recheck them after 5 minutes; the pictures keep for a day.
  echo "== $m (${#files[@]} files) -> r2:$BUCKET/maps/$m/"
  rclone copy "$dir" "r2:$BUCKET/maps/$m/" "${json[@]}" --exclude "*"     --header-upload "Cache-Control: public, max-age=300" --progress ${DRY[@]+"${DRY[@]}"}
  rclone copy "$dir" "r2:$BUCKET/maps/$m/" "${webp[@]}" --exclude "*"     --header-upload "Cache-Control: public, max-age=86400" --progress ${DRY[@]+"${DRY[@]}"}
done
echo "Done: $total files${DRY[@]+ (dry run)}."

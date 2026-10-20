# Operations

How the live site is put together, how to update it, and what to check when something looks wrong.
First-time setup is in the [root README](../README.md#deploy).

## Live services

| Piece | Where | Notes |
| --- | --- | --- |
| Site | https://darksky-web-8vxg.onrender.com | Render static site `darksky-web`, built from `web/` on every push to `master`. |
| API | https://darksky-api-xn9f.onrender.com | Render web service `darksky-api` (free plan), built from `api/`. Health: `/api/health`. |
| Map pictures | https://pub-66de2a6e0b4d49a0a063d02f365bd62d.r2.dev/maps/&lt;metro&gt;/ | Cloudflare R2 bucket `darksky-tiles`, Public Development URL. |
| Weather | Open-Meteo | No key. |
| Drive times, address lookup | openrouteservice.org | `ORS_API_KEY` on the API. |

Render added a suffix to both service names (`-8vxg`, `-xn9f`) because the plain names were taken; the URLs above
are the real ones.

## Settings

| Service | Setting | Value |
| --- | --- | --- |
| `darksky-api` | `ORS_API_KEY` | openrouteservice key (secret; only in Render and the git-ignored `api/.env`) |
| `darksky-api` | `ALLOWED_ORIGINS` | `https://darksky-web-8vxg.onrender.com` (comma-separated for several) |
| `darksky-api` | `TRUSTED_PROXY_HOPS` | `1` (preset by `render.yaml`) |
| `darksky-web` | `VITE_API_URL` | `https://darksky-api-xn9f.onrender.com` |
| `darksky-web` | `VITE_TILES_URL` | `https://pub-66de2a6e0b4d49a0a063d02f365bd62d.r2.dev` (no trailing slash) |

`VITE_*` values are baked into the site when it is built: after changing one, run **Manual Deploy → Deploy latest
commit** on `darksky-web`. The API's settings apply when it restarts, which Render does on save.

The R2 bucket's CORS policy is [scripts/r2-cors.json](../scripts/r2-cors.json) (bucket Settings → CORS Policy).
It must list the site's URL; `http://localhost:5173` is there for local development.

## Limits and costs

- **API sleeps when idle** (Render free plan). The first request after a while takes about 20–30 s; the site shows a
  "waking up" screen meanwhile.
- **openrouteservice**: drive times use at most 450 matrix calls a day and address lookups at most 500 geocoding
  calls a day (each budget resets daily and sits under ORS's free limits). Both are cached for a day. When a
  budget is spent or ORS fails, drive times fall back to straight-line estimates (shown with ≈) and address
  lookups return only Overture results.
- **Rate limits per client**: 20 spot requests and 60 searches a minute.
- **R2**: about 15 MB in 60 files, well inside the free tier. The Public Development URL is rate-limited and not
  cached by Cloudflare; for more traffic, connect a custom domain to the bucket and point `VITE_TILES_URL` at it.

## Updating

### Code

Push to `master`. Render rebuilds both services (the API re-installs, the site re-builds with its `VITE_*` values).

### Spots, darkness or search data

The API's data ships in git (`api/data/<metro>/`), so a data change is a commit:

```bash
cd pipeline
python -m darksky_pipeline.build --metro se_mi --release <R> --viirs data/viirs/vnl_annual.tif
python -m darksky_pipeline.build --metro bay_area --release <R> --viirs data/viirs/vnl_annual.tif
# only the search index (places, areas, street addresses): add --search-only
cd ../api
.venv/Scripts/python -m darksky_api.sync_data --from ../pipeline/out --to data
```

Run the API tests, commit `api/data`, push. `search_bay_area.sqlite` is about 52 MB; GitHub warns above 50 MB and
refuses above 100 MB, so watch it if the address index grows.

### Map pictures

```bash
cd pipeline
python -m darksky_pipeline.static_maps --metro se_mi --viirs data/viirs/vnl_annual.tif --tiles-release <R>
python -m darksky_pipeline.static_maps --metro bay_area --viirs data/viirs/vnl_annual.tif --tiles-release <R>
cd ../web
npm run render-maps
cd ..
scripts/upload_tiles.sh --dry-run    # expect 60 files
scripts/upload_tiles.sh
```

The upload only adds or replaces files; it never deletes. Pictures are cached by browsers for a day under fixed
names and the manifest for 5 minutes, so after a re-render that changes the bounds, widths or levels, expect a day
of mixed old and new files unless you rename the pictures.

### rclone and the R2 token

The upload uses an rclone remote named `r2` (S3, provider Cloudflare, endpoint
`https://<account id>.r2.cloudflarestorage.com`) with an R2 API token that has **Object Read & Write** on
`darksky-tiles` only. Such a token can read, write and list objects in that bucket but cannot list or create
buckets, so:

- `rclone lsd r2:` fails with 403 `ListBuckets AccessDenied`. That is expected; use `rclone lsf r2:darksky-tiles`.
- The upload script passes `--s3-no-check-bucket` so rclone does not try to create the bucket.

Check the remote without showing the keys: `rclone config redacted r2`.

### Rotating the ORS key

Create a new key at openrouteservice.org, set `ORS_API_KEY` on `darksky-api` in Render (it restarts), update your
local `api/.env`, then revoke the old key.

## Checks

```bash
curl https://darksky-api-xn9f.onrender.com/api/health
curl "https://darksky-api-xn9f.onrender.com/api/search?q=royal%20oak&limit=1"
curl -sI -H "Origin: https://darksky-web-8vxg.onrender.com" \
  https://pub-66de2a6e0b4d49a0a063d02f365bd62d.r2.dev/maps/se_mi/manifest.json
```

The last one should return 200 with `Access-Control-Allow-Origin` set to the site's URL.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Map unavailable right now" | The manifest didn't load: wrong `VITE_TILES_URL`, files not uploaded, or CORS doesn't list the site | Run the CORS check above; fix the bucket's CORS policy or the setting and redeploy the site. |
| The site can't reach the API (stays on "waking up", or errors) | `VITE_API_URL` is wrong, or the API's `ALLOWED_ORIGINS` doesn't include the site | Check both settings; redeploy the site after changing `VITE_API_URL`. |
| Every drive time shows ≈ | No ORS key, the daily budget is spent, or ORS is down | Check `ORS_API_KEY` on Render; it recovers the next day if the budget ran out. |
| A few drive times show ≈ | Normal: ORS can't route to some spots (islands, across the Canadian border) | Nothing to do. |
| An address isn't found | Neither Overture nor openrouteservice has it (Overture has no Detroit, Dearborn or Ann Arbor addresses; ORS answers some) | Search the town, or use "Use my location". |
| `rclone lsd r2:` gives 403 | The token can't list buckets (by design) | Use `rclone lsf r2:darksky-tiles`. |

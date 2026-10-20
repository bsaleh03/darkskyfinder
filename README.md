# Dark Sky Finder

Where's the closest dark sky tonight? Enter a starting point and a night, and Dark Sky Finder rates the
stargazing conditions (sky darkness, moon, clouds) and ranks nearby dark spots by drive time. Spots cover
southeast Michigan and the SF Bay Area so far; each region has a pre-rendered map picture (roads, borders and
an optional light-pollution glow) with the spots pinned on it.

**Live:** https://darksky-web-8vxg.onrender.com (the API sleeps when idle, so the first visit can take ~30 s).

## What you can do

- **Pick a start**: search a town, place or street address, or use your location.
- **Pick a night**: tonight or any of the next six, each with a verdict (good night to go, possible, or not great), the best viewing window,
  the moon and cloud cover hour by hour.
- **See the spots**: dark places within your drive time, ranked by how good the sky is against the drive, with an
  estimate of how much darker each is than home, directions to its entrance, and its sources and amenities.
- **Filter**: drive time, sort (relevant, closest, best view), likely open, crosses a country or state border.
- **Red mode**: an all-red screen that keeps your night vision.

## How search works

Suggestions appear as you type, from Overture alone: towns, counties and neighbourhoods (Divisions), places, and
street addresses (Overture Addresses, stored compactly as one row per 100-number block of a street and interpolated).
Pressing Enter or the search button runs a full lookup and goes straight to the best match; only that explicit
search may also ask the openrouteservice geocoder, for addresses Overture doesn't have (in SE Michigan, Overture's
addresses cover mostly Oakland and Macomb counties). Nothing found shows a short message instead.

## How it works

Overture Maps supplies the places and the map:

- **Places**: parks, nature areas and other candidate spots (and the start-point search index).
- **Land use / land cover**: filters to park-like, open land and informs the basemap.
- **Transportation**: road network for the basemap and access sanity checks.
- **Buildings**: building footprints for the basemap, and a nearby-building count that feeds the per-spot glare factor.
- **Divisions**: localities, regions and borders for search and the basemap; they also give each spot its country and
  state, which drive the `Crosses country border` and `Crosses state border` filters.

These are extracted for each metro into a **PMTiles** basemap in a moonlit style (`base`, `transportation`,
`buildings`, `divisions`). Sky darkness comes from **VIIRS Nighttime Lights**, resampled to a darkness grid used
for scoring and a light-pollution glow. Offline, the basemap and glow are rendered into one static picture per
region at two levels (normal and red-mode variants, each with and without the glow drawn in, WebP): level 0 is the
whole picture at three widths, level 1 is a 2x2 grid of tiles at twice the full width. The app picks the level the
view needs, paints the smallest level-0 picture first and sharpens it, keeps the level-0 picture underneath and loads
only the level-1 tiles in view, and draws the pins, start and place labels over them, with no
map library at runtime. Weather comes from Open-Meteo, drive times
from OpenRouteService (straight-line estimates without a key).

```
 Overture Maps release + VIIRS VNL GeoTIFF
              |
        pipeline/  (offline Python build)
              |
   pipeline/out/<metro>/
     |- *.pmtiles + static_maps inputs --- npm run render-maps (web/, dev only)
     |                                        |
     |                     pipeline/out/maps/<metro>/web/ (manifest, labels, WebP pictures)
     |                                        |
     |                                  upload_tiles.sh ---> Cloudflare R2 maps/<metro>/ (public + CORS)
     |- spots / darkness / search files --- copied (sync_data) ---> api/data
                                                                      |
   Browser (web/, Vite React static site on Render)                   |
     |- <img> map pictures + manifest ------ GET -----------------> R2   |
     |- TanStack Query ------------------- /api/* --------> api/ (FastAPI on Render) -> Open-Meteo, ORS
```

## Repository layout

| Path | What |
| --- | --- |
| `pipeline/` | Offline data build (Overture + VIIRS to tiles, spots, darkness grid, search index). See `pipeline/README.md`. |
| `api/` | FastAPI service: verdict, ranked spots, search, regions. See `api/README.md`. |
| `web/` | Vite + React static site. |
| `scripts/` | `upload_tiles.sh` (R2 upload), `r2-cors.json`. |
| `render.yaml` | Render Blueprint for both services. |
| `docs/operations.md` | Live URLs, settings, limits, how to update data and pictures, troubleshooting. |
| `docs/superpowers/` | Design specs and implementation plans. |

## Local development

Pipeline (needs the `pmtiles` CLI and a VNL GeoTIFF; see `pipeline/README.md`):

```bash
cd pipeline
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # macOS/Linux: .venv/bin/python
python -m darksky_pipeline.build --metro se_mi --release <R> --viirs data/viirs/vnl_annual.tif
python -m darksky_pipeline.build --metro bay_area --release <R> --viirs data/viirs/vnl_annual.tif
# map picture inputs (extent, glow, labels, borders) per region, into out/maps/<metro>/
python -m darksky_pipeline.static_maps --metro se_mi --viirs data/viirs/vnl_annual.tif --tiles-release <R>
python -m darksky_pipeline.static_maps --metro bay_area --viirs data/viirs/vnl_annual.tif --tiles-release <R>
```

Map pictures (renders each region with MapLibre in headless Chromium, then writes
`pipeline/out/maps/<metro>/web/`: `manifest.json` (v3, with `levels` and `tiles`), `labels.json`,
`{base,base_red,base_glow,base_glow_red}_<width>.webp` at three level-0 widths and the same four kinds as
`<kind>_L1_<c>_<r>.webp` for the 2x2 level-1 tiles, 28 pictures per region; `base_glow*` are the base with the
glow drawn in, so the glow appears with the map; red variants are pixel-checked):

```bash
cd web
npm run render-maps                     # both regions; or: npm run render-maps -- --metro se_mi
```

API:

```bash
cd api
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"
.venv/Scripts/python -m darksky_api.sync_data --from ../pipeline/out --to data
cp .env.example .env     # optional: add ORS_API_KEY (git-ignored)
.venv/Scripts/uvicorn darksky_api.app:build_default_app --factory --reload
```

Web (the dev server serves the rendered pictures from `../pipeline/out/maps/<metro>/web` at `/tiles/maps/<metro>`,
the same layout as R2):

```bash
cd web
npm ci
npm run dev        # http://localhost:5173, API defaults to http://localhost:8000
npm test           # unit tests;  npm run lint:css;  npm run e2e
```

## Deploy

Hosting: Render (API + static site) and Cloudflare R2 (map pictures). You create the accounts, the R2 API token and
the Render secrets yourself; no credentials are stored in this repo. Once it is running, see
[docs/operations.md](docs/operations.md) for the live URLs, updates and troubleshooting.

1. **GitHub**: push this repo to a GitHub repository you own.
2. **R2 bucket**: create bucket `darksky-tiles`, enable its **Public Development URL** (the `r2.dev` URL; bucket
   Settings → Public access), and apply the CORS policy in `scripts/r2-cors.json` (bucket Settings → CORS Policy).
   Its first origin must be your site's real URL (see step 4).
3. **Upload the map pictures** (about 15 MB, 60 files). Create an R2 API token (R2 → Manage API tokens, **Object
   Read & Write**, limited to `darksky-tiles`) and configure rclone once: `rclone config`, new remote named `r2`,
   storage `s3`, provider `Cloudflare`, enter the access key and secret, endpoint
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Check it with `rclone lsf r2:darksky-tiles`; `rclone lsd r2:`
   fails with 403 because such a token can't list buckets, which is expected. Then:
   ```bash
   scripts/upload_tiles.sh --dry-run   # 2 regions x (manifest + labels + 4 kinds x 3 widths + 4 kinds x 4 tiles) = 60 files
   scripts/upload_tiles.sh
   ```
   Run it after the pipeline, `python -m darksky_pipeline.static_maps` and `npm run render-maps` (see Local
   development). The script copies `pipeline/out/maps/<metro>/web/` to `r2:darksky-tiles/maps/<metro>/`, allowing
   only `manifest.json`, `labels.json`, `(base|base_red|base_glow|base_glow_red)_<width>.webp` for the widths the
   manifest lists and the same kinds as `<kind>_L<l>_<c>_<r>.webp` for every tile of its levels, and refuses
   anything else. The bucket holds only `maps/`; PMTiles stay local (they are render inputs).
   Caching: the pictures are cached for 1 day under fixed names, the manifest and labels for 5 minutes. After a
   re-render that changes the bounds, widths or levels, browsers can pair the new manifest with day-old pictures, so
   wait a day before relying on it, or purge the R2/CDN cache (or rename the pictures) when you upload.
   The API's data files ship with the API (`api/data`), not via R2.
4. **Render Blueprint**: New > Blueprint, pick the repo; it reads `render.yaml` and creates `darksky-api`
   and `darksky-web`. Render adds a suffix to a service's URL when the plain name is taken
   (e.g. `darksky-web-8vxg.onrender.com`), so read the real URLs off each service's page. When prompted, enter the
   secrets:
   - `darksky-api`: `ORS_API_KEY` (OpenRouteService key), `ALLOWED_ORIGINS` (the static site URL, comma-separated
     for several); `TRUSTED_PROXY_HOPS=1` and `PYTHON_VERSION` are preset.
   - `darksky-web`: `VITE_API_URL` (e.g. `https://darksky-api.onrender.com`) and `VITE_TILES_URL`
     (the R2 public URL with no trailing slash, e.g. `https://pub-xxxx.r2.dev`). The app then loads
     `<VITE_TILES_URL>/maps/se_mi/manifest.json` and the pictures it lists.
   `VITE_*` values are baked in at build time, so redeploy the web service after changing them.

The free API plan sleeps when idle; the first request shows a "Waking up the stargazing engine..." screen.

### First-deploy checklist

- [x] `/api/health` OK and cold start time noted (about 22 s, 2026-10-19)
- [ ] One-time log of `X-Forwarded-For` shape to confirm the rate-limit key (then remove)
- [x] `maps/<metro>/manifest.json` and the pictures return 200 with CORS headers
- [x] Live smoke test via the site (Royal Oak, San Francisco, an address lookup)
- [ ] Phone check in red mode outdoors

## Credits and licenses

- **Overture Maps Foundation** (https://docs.overturemaps.org/attribution/): Base, Buildings, Divisions and
  Transportation are ODbL, built on "© OpenStreetMap contributors" (plus Esri Community Maps, Microsoft and
  Google building footprints, geoBoundaries and others per theme). Transportation also credits TomTom; Base
  credits "© ESA WorldCover project 2020" (contains modified Copernicus Sentinel data, CC BY 4.0), NOAA ETOPO1
  and GLOBathy. Places is CDLA Permissive 2.0 (Meta, Microsoft and others), with Foursquare portions under
  Apache 2.0 and AllThePlaces under CC0. The map's attribution line credits Overture, OSM, TomTom, ESA and VIIRS.
- **VIIRS Nighttime Lights (VNL v2)**: Earth Observation Group, Payne Institute, Colorado School of Mines.
- **Open-Meteo** weather API (CC BY 4.0, non-commercial free tier).
- **OpenRouteService** drive times and the address-lookup fallback (heigit.org, openrouteservice.org; geocoding
  results © OpenStreetMap contributors). The map's credits line names it.
- Map pictures rendered offline with MapLibre GL JS and PMTiles (not shipped in the app).

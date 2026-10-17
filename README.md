# Dark Sky Finder

Where's the closest dark sky tonight? Enter a starting point and a night, and Dark Sky Finder rates the
stargazing conditions (sky darkness, moon, clouds) and ranks nearby dark spots by drive time. It covers
SE Michigan and the SF Bay Area so far.

## How it works

Overture Maps supplies the places and the map:

- **Places**: parks, nature areas and other candidate spots (and the start-point search index).
- **Land use / land cover**: filters to park-like, open land and informs the basemap.
- **Transportation**: road network for the basemap and access sanity checks.
- **Buildings**: building footprints for the basemap, and a nearby-building count that feeds the per-spot glare factor.
- **Divisions**: localities, regions and borders for search and the basemap (including the Canada border option).

These are extracted for each metro and turned into a self-hosted **PMTiles** basemap in a moonlit style
(`base`, `transportation`, `buildings`, `divisions`). Sky darkness comes from **VIIRS Nighttime Lights**,
resampled to a light-pollution raster (also PMTiles, shown as an optional glow layer) and a darkness grid used
for scoring. Weather comes from Open-Meteo, drive times from OpenRouteService (straight-line estimates without a key).

```
 Overture Maps release + VIIRS VNL GeoTIFF
              |
        pipeline/  (offline Python build)
              |
   pipeline/out/<metro>/
     |- *.pmtiles  --- upload_tiles.sh ---> Cloudflare R2 (public, Range + CORS)
     |- spots / darkness / search files --- copied (sync_data) ---> api/data
                                                                      |
   Browser (web/, Vite React static site on Render)                   |
     |- MapLibre + pmtiles protocol ------- Range requests -----> R2   |
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

## Local development

Pipeline (needs the `pmtiles` CLI and a VNL GeoTIFF; see `pipeline/README.md`):

```bash
cd pipeline
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev,tiles]"     # macOS/Linux: .venv/bin/python
python -m darksky_pipeline.build --metro se_mi --release <R> --viirs data/viirs/vnl_annual.tif
python -m darksky_pipeline.build --metro bay_area --release <R> --viirs data/viirs/vnl_annual.tif
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

Web (the dev server serves tiles from `../pipeline/out` at `/tiles`, with Range support):

```bash
cd web
npm ci
npm run dev        # http://localhost:5173, API defaults to http://localhost:8000
npm test           # unit tests;  npm run lint:css;  npm run e2e
```

## Deploy

Hosting: Render (API + static site) and Cloudflare R2 (tiles). You create the accounts, the R2 API token and
the Render secrets yourself; no credentials are stored in this repo.

1. **GitHub**: push this repo to a GitHub repository you own.
2. **R2 bucket**: create bucket `darksky-tiles`, enable the public `r2.dev` URL, and apply the CORS policy
   in `scripts/r2-cors.json` (bucket Settings, CORS Policy). Replace the placeholder
   `https://darksky-web.onrender.com` origin with your real site URL if it differs.
3. **Upload tiles** (about 2.3 GB, 10 files). Create an R2 API token (Object Read & Write) and configure
   rclone once: `rclone config`, new remote named `r2`, storage `s3`, provider `Cloudflare`, enter the access
   key and secret, endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Then:
   ```bash
   scripts/upload_tiles.sh --dry-run   # lists exactly the 10 .pmtiles files
   scripts/upload_tiles.sh
   ```
   The script uploads only `basemap_*` and `lightpollution_*` `.pmtiles` files to `r2:darksky-tiles/<metro>/`
   and refuses anything else. The API's data files ship with the API (`api/data`), not via R2.
4. **Render Blueprint**: New > Blueprint, pick the repo; it reads `render.yaml` and creates `darksky-api`
   and `darksky-web`. When prompted, enter the secrets:
   - `darksky-api`: `ORS_API_KEY` (OpenRouteService key), `ALLOWED_ORIGINS` (the static site URL, comma-separated
     for several); `TRUSTED_PROXY_HOPS=1` and `PYTHON_VERSION` are preset.
   - `darksky-web`: `VITE_API_URL` (e.g. `https://darksky-api.onrender.com`) and `VITE_TILES_URL`
     (the R2 public URL with no trailing slash, e.g. `https://pub-xxxx.r2.dev`). The app then loads
     `<VITE_TILES_URL>/se_mi/basemap_se_mi_base.pmtiles` and so on.
   `VITE_*` values are baked in at build time, so redeploy the web service after changing them.

The free API plan sleeps when idle; the first request shows a "Waking up the stargazing engine..." screen.

### First-deploy checklist

- [ ] `/api/health` OK and cold start time noted
- [ ] One-time log of `X-Forwarded-For` shape to confirm the rate-limit key (then remove)
- [ ] Tiles return 206 with CORS headers
- [ ] Live smoke test via the site (Royal Oak, San Francisco)
- [ ] Phone check in red mode outdoors

## Credits and licenses

- **Overture Maps Foundation** (https://docs.overturemaps.org/attribution/): Base, Buildings, Divisions and
  Transportation are ODbL, built on "© OpenStreetMap contributors" (plus Esri Community Maps, Microsoft and
  Google building footprints, geoBoundaries and others per theme). Transportation also credits TomTom; Base
  credits "© ESA WorldCover project 2020" (contains modified Copernicus Sentinel data, CC BY 4.0), NOAA ETOPO1
  and GLOBathy. Places is CDLA Permissive 2.0 (Meta, Microsoft and others), with Foursquare portions under
  Apache 2.0 and AllThePlaces under CC0. The map's attribution control credits Overture, OSM, TomTom, ESA and VIIRS.
- **VIIRS Nighttime Lights (VNL v2)**: Earth Observation Group, Payne Institute, Colorado School of Mines.
- **Open-Meteo** weather API (CC BY 4.0, non-commercial free tier).
- **OpenRouteService** drive times (heigit.org, openrouteservice.org).
- **Noto Sans** map glyphs (SIL Open Font License 1.1), via openmaptiles/fonts.
- Map rendering: MapLibre GL JS and PMTiles.

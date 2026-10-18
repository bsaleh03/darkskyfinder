# Static Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live MapLibre map with pre-rendered, resized regional pictures (base + light-pollution glow, normal and red) that frame themselves around the user's start and spots, with crisp HTML labels and pins.

**Architecture:** The Python pipeline writes per-region glow images, a town-label list and land-only borders over each region's picture extent. A dev-only Node script renders the base picture from the existing PMTiles extracts with MapLibre in headless Chromium, then resizes and encodes every variant (sharp) and writes a manifest. The app fetches the manifest, picks the smallest sharp size, and positions images, labels and pins with Web-Mercator math. MapLibre and PMTiles leave the app bundle.

**Tech Stack:** Python 3.11 (rasterio, numpy, duckdb, shapely), Node 24, Playwright (Chromium), MapLibre GL 4 + pmtiles 3 (render-only, devDependencies), sharp (new devDependency), React 18 + TanStack Query 5, Vitest, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-18-static-map-design.md` (amends `docs/superpowers/specs/2026-10-17-dark-sky-web-design.md`).

## Global Constraints

- Each image ≤ 16,000,000 pixels decoded (`width × height ≤ 16_000_000`).
- Sizes per variant: full, ½, ¼ widths; full width is a multiple of 4.
- Normal-mode download per region at the largest size ≤ ~6 MB; all sizes and variants for both regions ≤ ~100 MB.
- Red variants (`base_red`, `glow_red`): no pixel with alpha > 0 where green or blue > red / 2 (checked on the decoded output files).
- One projection everywhere: Web Mercator. Image bounds, pins and labels must line up within 2 px at every framing.
- Picture extent = pipeline `METROS[key].tiles_bbox` (Michigan `(-86.9, 41.65, -82.4, 45.9)`, Bay Area `(-123.2, 36.4, -121.0, 38.6)`).
- Glow = `build_darkness_grid` (same constants as spots) over the picture extent, colored with `tiles._COLOR_STOPS` / `tiles.RED_STOPS`.
- No land cover, no baked labels, no glyphs in the render.
- Attribution text on the picture, verbatim: `Overture Maps Foundation · © OpenStreetMap contributors · TomTom · ESA WorldCover · VIIRS VNL (EOG / Colorado School of Mines)`.
- Hosting: R2 bucket under `maps/<metro>/`; the app reads the base URL from `VITE_TILES_URL` (`${tilesUrl}/maps/<metro>/manifest.json`).
- The app never renders maps at runtime; no MapLibre/PMTiles code in the production bundle.
- Start comes only from search and "Use my location": no tap-to-start, no drag pin, no confirm toast, no region chips, no MetroSwitch.
- Copy: unavailable map state reads `Map unavailable right now`.
- Never print or read `api/.env`.

## Review Focus

1. A start near the picture edge, or spots past it: every pin and the start stay visible; area beyond the image shows the water color (Task 3 test `frameView keeps points inside even past the extent`).
2. Manifest or images fail to load (R2 down, CORS): the map area says `Map unavailable right now`; list, cards and controls still work (Task 4 test `shows unavailable state when the manifest fails`).
3. Phone rotation / window resize: framing and chosen size recompute (Task 4 test `refits and re-chooses width on resize`).
4. Device pixel ratio 3 on a big screen: size choice caps at the largest width, never requests a size that doesn't exist (Task 3 test `chooseWidth caps at the largest width`).
5. Turning red mode on: the base and glow switch to the `_red` files in the same render, never showing a normal-color picture in red mode (Task 4 test `red mode uses only red files`).

---

### Task 1: Pipeline: region glow images, labels and borders

**Files:**
- Create: `pipeline/darksky_pipeline/static_maps.py`, `pipeline/tests/test_static_maps.py`
- Delete: `pipeline/darksky_pipeline/us_glow.py`, `pipeline/tests/test_us_glow.py`
- Modify: `pipeline/darksky_pipeline/config.py` (replace the `US_GLOW_*`, `US_BORDERS_*`, `US_BORDER_*` block with the constants below), `pipeline/darksky_pipeline/build.py` (stop generating `lightpollution_<metro>.tif/.pmtiles`; keep basemap extracts), affected tests in `pipeline/tests/test_build.py`

**Interfaces:**
- Produces (outputs in `pipeline/out/maps/<metro>/`): `extent.json` = `{"bounds": [w, s, e, n], "width": W, "height": H}`; `glow.png`, `glow_red.png` (8-bit RGBA, exactly W×H, Web Mercator rectangle = bounds); `labels.json` = `[{"name": str, "lon": float, "lat": float, "rank": int}]` (rank 1 = most important, ≤ `STATIC_MAP_LABEL_LIMIT` entries); `borders.geojson` (same schema as before: `subtype` country|region, `water` bool).
- Config: `STATIC_MAP_MAX_PIXELS = 16_000_000`, `STATIC_MAP_GLOW_RES_M = 500`, `STATIC_MAP_LABEL_LIMIT = 400`, `BORDER_COUNTRIES = frozenset({"US", "CA", "MX"})`, `BORDER_SIMPLIFY_DEG = 0.001`, `BORDER_LAND_SLACK_DEG = 0.003`.
- Functions: `image_size(bbox: BBox, max_pixels: int = STATIC_MAP_MAX_PIXELS) -> tuple[int, int]`; `glow_rgba(grid: DarknessGrid, bbox: BBox, width: int, height: int, stops: np.ndarray | None = None) -> np.ndarray` (shape `(height, width, 4)`, uint8); `labels_query(release: str, bbox: BBox) -> str`; `labels_json(df: pd.DataFrame, limit: int = STATIC_MAP_LABEL_LIMIT) -> list[dict]`; `border_line_query(release, bbox)`, `border_area_query(release, bbox)`, `land_borders_geojson(lines, areas, ...)` moved from `us_glow.py` with an added `bbox` parameter; `build_static_map_inputs(metro_key: str, viirs: Path, release: str, out_root: Path) -> Path`; CLI `python -m darksky_pipeline.static_maps --metro se_mi --viirs data/viirs/vnl_annual.tif --tiles-release 2026-09-23.1 --out out/maps`.

- [ ] **Step 1: Write failing tests** in `pipeline/tests/test_static_maps.py`:
  - `test_image_size_respects_pixel_cap_and_mercator_aspect`: for `(-86.9, 41.65, -82.4, 45.9)`, `w*h <= 16_000_000`, `w % 4 == 0`, `w*h >= 15_000_000`, and `h/w` equals the Web-Mercator aspect within 0.5%.
  - `test_glow_rgba_shape_and_ramps`: with the existing `darkness_grid` fixture over its own bbox, `glow_rgba(grid, bbox, 64, 48)` is `(48, 64, 4)` uint8, has some alpha > 0 near the fixture city, and with `RED_STOPS` every visible pixel has `g <= r/2 and b <= r/2`.
  - `test_labels_query_and_json`: query contains `type=division/`, `subtype = 'locality'` and the bbox; `labels_json` on a frame with `name, lon, lat, population, prominence` (one null name, one duplicate name+position) returns entries sorted by importance (population desc, then prominence desc), ranks `1..n`, drops null names and duplicates, honours `limit`.
  - Move the four border tests from `test_us_glow.py` (queries filter land; country lines not filtered by country; water stretches kept for countries only), adapted to the `bbox` parameter.
  - `test_build_static_map_inputs_writes_all_outputs` (monkeypatch the DuckDB-backed `labels`/`borders` writers and use the VIIRS fixture with a small bbox): `extent.json`, `glow.png`, `glow_red.png` exist and the PNGs are `width×height` from `extent.json`.
- [ ] **Step 2: Run** `.venv/Scripts/python -m pytest -q tests/test_static_maps.py` → FAIL (module missing).
- [ ] **Step 3: Implement** `static_maps.py`. Glow: `build_darkness_grid(viirs, bbox, metro.utm_epsg, res_m=STATIC_MAP_GLOW_RES_M)`, then `rasterio.warp.reproject` the `sqm` grid to EPSG:3857 with the destination transform from `bounds` projected to 3857 and `(width, height)`, bilinear, then `sqm_to_rgba(..., stops)`. Write PNG with rasterio (`driver="PNG"`, 4 bands). Labels: `type=division`, `subtype = 'locality'`, columns `names.primary AS name`, centroid lon/lat, `population`, `prominence` (null-safe). Delete `us_glow.py` and its tests; remove the `US_*` config; drop lightpollution outputs from `build.py`.
- [ ] **Step 4: Run** full `.venv/Scripts/python -m pytest -q` → all pass.
- [ ] **Step 5: Generate real inputs** for both metros (needs network for labels/borders):
  `PATH="$PWD/.venv/Scripts:$PATH" .venv/Scripts/python -m darksky_pipeline.static_maps --metro se_mi --viirs data/viirs/vnl_annual.tif --tiles-release 2026-09-23.1 --out out/maps` (and `--metro bay_area`). Record sizes and label counts in the report.
- [ ] **Step 6: Commit** `feat(pipeline): static map inputs: region glow images, labels, land-only borders`.

### Task 2: Render tooling: base pictures, resized variants, manifest

**Files:**
- Create: `web/render/index.html`, `web/render/main.ts`, `web/render/style.ts` (moved from `web/src/map/style.ts` and reduced), `web/render/sizes.ts`, `web/render/redcheck.ts`, `web/scripts/render-maps.mjs`, `web/tests/render/style.test.ts` (from `tests/map/style.test.ts`), `web/tests/render/sizes.test.ts`, `web/tests/render/redcheck.test.ts`
- Modify: `web/package.json` (`sharp` devDependency; `maplibre-gl`, `pmtiles` move to devDependencies; script `"render-maps": "node scripts/render-maps.mjs"`), `web/vite.config.ts` (`render/index.html` served by the dev server only, not part of `build.rollupOptions.input`), `web/tsconfig.json` (include `render`)

**Interfaces:**
- Consumes: Task 1 outputs in `pipeline/out/maps/<metro>/`; basemap PMTiles at `/tiles/<metro>/basemap_<metro>_<theme>.pmtiles` (existing `devTiles` mount).
- `renderStyle(opts: { tilesUrl: string; metro: string; red: boolean; bordersUrl: string }): StyleSpecification` — water background; land = `<metro>-divisions` `division_area` with `class == 'land'`; parks; water; roads by class (minor from z11 as today); county lines under water; borders from `bordersUrl` (country solid, country-over-water dashed at 0.6 opacity, region dashed); no symbol layers, no `glyphs`, no glow, no land cover. `red` maps every color through `toRed`.
- `sizesFor(fullWidth: number, aspect: number): { w: number; h: number }[]` → `[full, full/2, full/4]` ascending, heights rounded.
- `redViolations(rgba: Uint8Array | Buffer): number` — count of pixels with alpha > 0 and (g > r/2 or b > r/2).
- Render page contract: `render/index.html?metro=<key>&red=0|1&w=<W>&h=<H>` sets `window.__renderDone = true` after the map's first `idle`, map created with `interactive: false`, `preserveDrawingBuffer: true`, `pixelRatio: 1`, `maxCanvasSize: [16384, 16384]`, container exactly W×H, `fitBounds(bounds, { padding: 0, animate: false })`.
- Script outputs to `pipeline/out/maps/<metro>/web/`: `base_<w>.webp`, `base_red_<w>.webp`, `glow_<w>.webp`, `glow_red_<w>.webp` for each size, `labels.json` (copied), `manifest.json`:
  ```ts
  interface MapManifest {
    metro: string
    bounds: [number, number, number, number] // W,S,E,N of the images (Web Mercator rectangle)
    aspect: number                           // height / width
    widths: number[]                         // ascending, e.g. [w/4, w/2, w]
    files: { base: string; base_red: string; glow: string; glow_red: string } // templates, e.g. "base_{w}.webp"
    labels: string                           // "labels.json"
  }
  ```

- [ ] **Step 1: Failing tests**: move the style tests that still apply (colors, roads, parks, water, borders from GeoJSON with water dashed, county lines under water, attribution strings on sources, red mapping) to `tests/render/style.test.ts` against `renderStyle`, plus `has no symbol layers and no glyphs` and `has no land_cover or raster layers`; `sizesFor(3500, 1.3)` → `[{w:875,…},{w:1750,…},{w:3500,…}]`; `redViolations` on a 2-pixel buffer `[255,0,0,255, 100,90,0,255]` → `1` and transparent pixels ignored.
- [ ] **Step 2: Run** `npx vitest run tests/render` → FAIL.
- [ ] **Step 3: Implement** `render/style.ts`, `sizes.ts`, `redcheck.ts`, the render page and `scripts/render-maps.mjs`: start the Vite dev server programmatically (`createServer` with the project config, a free port), launch Playwright Chromium with viewport W×H, deviceScaleFactor 1; for `red` 0 and 1 load the render page, await `__renderDone`, read the canvas with `toDataURL('image/png')`; then with sharp write all sizes (base: WebP quality 82; glow and both red variants: lossless WebP), run `redViolations` on the decoded red outputs and exit non-zero if any, copy `labels.json`, write `manifest.json`. CLI: `--metro <key>` (repeatable; default both).
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `npm run lint:css` → pass. Run `npm run render-maps` for both metros; report image sizes, per-region byte totals against the budgets, and red-check results. Look at the full-size base PNGs and describe them.
- [ ] **Step 5: Commit** `feat(web): render static map pictures and manifests (dev-only)` (rendered images are not committed; `pipeline/out` is git-ignored).

### Task 3: Map math: projection, framing, size choice

**Files:**
- Create: `web/src/map/projection.ts`, `web/src/map/framing.ts`, `web/tests/map/projection.test.ts`, `web/tests/map/framing.test.ts`

**Interfaces:**
- `type LonLat = { lon: number; lat: number }`; `type Box = { x0: number; y0: number; x1: number; y1: number }` (fractions of the image, 0..1, may extend beyond 0..1).
- `toFraction(p: LonLat, bounds: [number, number, number, number]): { x: number; y: number }` (Web Mercator).
- `frameView(points: LonLat[], start: LonLat, driveMinutes: number, bounds): Box` — bbox of `start` + `points`, padded 12% of span each side, minimum span 25 km on each axis (km → fraction at the box's center latitude); with no points, a box centered on `start` of half-span `driveMinutes × 1.2` km.
- `fitBox(box: Box, viewW: number, viewH: number, imageAspect: number): { imgW: number; imgH: number; left: number; top: number }` — CSS size/offset of the full image so the box fills the view, preserving aspect (box expanded on the short axis, centered).
- `chooseWidth(widths: number[], imgW: number, dpr: number): number` — smallest width ≥ `imgW × dpr`, else the largest.

- [ ] **Step 1: Failing tests**: `toFraction` maps bounds corners to (0,1)/(1,0) and a mid-latitude point matches Mercator within 1e-6; `frameView keeps points inside even past the extent` (a point at fraction x = 1.05 stays inside the box); minimum-span box for two points 1 km apart spans ≥ 25 km; empty points with 90 min gives half-span 108 km; `fitBox` on box `[0.25,0.75]²`, square image, 400×400 view → `imgW = 800, left = -200`; non-square view expands the short axis; `chooseWidth([875,1750,3500], 400, 2) === 875`, `(…, 600, 2) === 1750`, `chooseWidth caps at the largest width` `(…, 3000, 3) === 3500`.
- [ ] **Step 2: Run** `npx vitest run tests/map/projection.test.ts tests/map/framing.test.ts` → FAIL.
- [ ] **Step 3: Implement** the four functions.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): static map projection, framing and size choice`.

### Task 4: StaticMap component and App wiring

**Files:**
- Create: `web/src/map/StaticMap.tsx`, `web/src/map/StaticMap.css`, `web/src/map/useMapManifest.ts`, `web/src/map/labels.ts`, `web/tests/map/StaticMap.test.tsx`, `web/tests/map/labels.test.ts`
- Modify: `web/src/App.tsx`, `web/src/components/Welcome.tsx`, `web/src/components/TopBar.tsx`, `web/src/AppLayout.css`, `web/tests/app.flow.test.tsx`, `web/tests/components/topbar.test.tsx`, `web/src/map/pins.ts` (export `pinColor(spot: Spot): string`; drop GeoJSON)
- Delete: `web/src/components/RegionChips.tsx`, `web/src/components/MetroSwitch.tsx` and their tests/usages

**Interfaces:**
- Consumes: Task 3 functions; `MapManifest`/labels from Task 2 (type `MapManifest` re-declared in `src/map/useMapManifest.ts`).
- `useMapManifest(metro: string | null): { manifest: MapManifest | null; labels: MapLabel[]; status: 'loading' | 'ready' | 'error' }` (TanStack Query, `staleTime: Infinity`, fetches `${config.tilesUrl}/maps/<metro>/manifest.json` then the labels file).
- `placeLabels(labels: MapLabel[], toScreen: (p: LonLat) => { x: number; y: number }, viewW: number, viewH: number): { label: MapLabel; x: number; y: number }[]` — greedy by rank; drops labels outside the view and those whose estimated box (`name.length × 7 px` by 14 px) overlaps an accepted one.
- `StaticMap` props: `{ metro: string; spots: Spot[]; start: LonLat; selectedId: string | null; glow: boolean; red: boolean; driveMinutes: number; onSelect(id: string): void; onToggleGlow(): void }`. Renders: view container (measured with `ResizeObserver`, falling back to `clientWidth/clientHeight`), positioned full-image layer from `fitBox`, `<img>` base (`alt=""`), `<img>` glow (only when `glow`), label spans, start pin (`aria-label="Your start"`), spot pins as `<button>` named by `display_name` with `pinColor`, Dark Sky ring, selected enlarged, the glow toggle button (same name `Light pollution glow`, `aria-pressed`), the attribution line, and `Map unavailable right now` when `status === 'error'`. Eased transform transition, none under reduced motion. Red mode uses `base_red`/`glow_red` files and red pin colors (`toRed`).
- App: `.app-map` renders only when there is a start; StaticMap gets `metro` (the region containing the start), `driveMinutes = state.drive`; selecting a pin keeps today's behavior (`update({ spot })`, close full map). Welcome: no picture, no region chips. TopBar: no MetroSwitch. Coverage message stays text-only.

- [ ] **Step 1: Failing tests**:
  - `labels.test.ts`: higher rank wins a collision; off-screen labels dropped.
  - `StaticMap.test.tsx` (mock `useMapManifest`, stub `ResizeObserver` and `devicePixelRatio`): `renders pins as buttons that select spots`; `start pin is labelled`; `glow image only when glow`; `red mode uses only red files` (every `img` src contains `_red_`); `picks the smallest sharp width` (400×200 view, dpr 2 → `base_875.webp` for a framing at full-image width ≤ 437); `refits and re-chooses width on resize`; `shows unavailable state when the manifest fails` (`Map unavailable right now`, no images); `attribution line text`.
  - `app.flow.test.tsx`: welcome has no map and no region chips; results render the map with pins (mocking `useMapManifest`); clicking a pin opens its card (`spot=` in URL); remove tests for map focus, tap-to-start and region chips; coverage message test no longer expects chips.
  - `topbar.test.tsx`: no MetroSwitch.
- [ ] **Step 2: Run** `npx vitest run` → new tests FAIL.
- [ ] **Step 3: Implement** the component, hook, label placement, CSS (tokens only, no shadows; water color behind the image) and App/Welcome/TopBar changes.
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `npm run lint:css` → pass.
- [ ] **Step 5: Commit** `feat(web): static map with framed pictures, labels and pins`.

### Task 5: Remove the live map from the app

**Files:**
- Delete: `web/src/map/MapView.tsx`, `web/src/map/MapView.css`, `web/src/map/helpers.ts`, `web/src/map/retry.ts`, `web/src/map/style.ts` (moved in Task 2), `web/glyphfallback.ts`, `web/public/glyphs/`, and tests `tests/map/MapView.test.tsx`, `tests/map/helpers.test.ts`, `tests/map/retry.test.ts`, `tests/map/style.test.ts`, `tests/glyphfallback.test.ts`
- Modify: `web/vite.config.ts` (drop `glyphFallback`, the `map-vendor` manual chunk and the `/e2e-tiles` → `e2e/fixtures/tiles` mount stays), `web/tsconfig.json`, `web/src/config.ts` (drop `METRO_MAP_BOUNDS`)

- [ ] **Step 1: Failing test** `web/tests/bundle.test.ts` (node env): `app sources never import the live map` — no file under `src/` imports `maplibre-gl` or `pmtiles` (scan the sources); `package.json` lists both only under `devDependencies`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Delete/modify** the files above.
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `npm run lint:css`, `npm run build` → pass; report the JS bundle size before/after.
- [ ] **Step 5: Commit** `refactor(web): drop MapLibre/PMTiles from the app`.

### Task 6: Fixtures, e2e, upload script, docs

**Files:**
- Create: `web/e2e/fixtures/tiles/maps/se_mi/` (manifest.json listing only the ¼ width, the four ¼-width WebPs and labels.json, copied from Task 2 output)
- Delete: all `*.pmtiles`, `borders.geojson` and the region geojson under `web/e2e/fixtures/`
- Modify: `web/e2e/flow.spec.ts`, `scripts/upload_tiles.sh` (upload `pipeline/out/maps/<metro>/web/` → `r2:$BUCKET/maps/<metro>/`; allow only `manifest.json`, `labels.json`, `(base|base_red|glow|glow_red)_<digits>.webp`; drop PMTiles/US uploads and the borders gzip step), `README.md` (pipeline → `static_maps` → `npm run render-maps` → upload; drop US glow/borders text; R2 holds only `maps/`), `docs/superpowers/specs/2026-10-17-dark-sky-web-design.md` (one-line pointer at §5.2 and §8.1 to the static-map spec)

- [ ] **Step 1: Update e2e** to: drop tile-read assertions; after results load assert the base image has `naturalWidth > 0` and its src ends with `base_<w>.webp`; click a spot pin → its card expands and the URL has `spot=`; red mode → all map `img` srcs contain `_red_`; keep the no-console-errors, no-box-shadow and red-color checks; regenerate visual baselines without masking the map (`--update-snapshots` once, then a clean pass).
- [ ] **Step 2: Upload script**: dry-run with the stub `rclone` lists exactly 2 × (2 + 4 × sizes) files under `maps/` and nothing else.
- [ ] **Step 3: Run** `npx vitest run`, `npm run lint:css`, `npm run build`, `npm run e2e` (twice) → pass.
- [ ] **Step 4: Commit** `chore: static map fixtures, e2e, R2 upload and docs`.

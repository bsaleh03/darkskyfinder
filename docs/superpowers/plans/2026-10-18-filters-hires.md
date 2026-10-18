# Filters, State Borders and High-Resolution Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move rarely used filters into More filters, add a state-border filter end to end, state coverage on the welcome screen, and make the map (base and night-sky glow) much sharper with multi-level tiled pictures.

**Architecture:** Spots gain an ISO 3166-2 `region` in the pipeline; the API derives `crosses_state` against each metro's home region and filters on `state_border`. The web moves filters into More filters. The map becomes a 3-level picture pyramid (level 0 = today's single picture; levels 1/2 = 2×2 and 4×4 grids at 2×/4× resolution) for both base and glow; the app loads only visible pieces of the lowest sharp level over the always-present level 0.

**Tech Stack:** Python (rasterio, numpy, duckdb, shapely, FastAPI), Node (Playwright, MapLibre dev-only, sharp), React 18 + TanStack Query, Vitest, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-18-filters-hires-design.md` (amends `2026-10-18-static-map-design.md`).

## Global Constraints
- Filter labels verbatim: `Likely open`, `Crosses country border`, `Crosses state border`; card badge `Crosses state border`.
- Welcome line verbatim: `We currently cover southeast Michigan and the SF Bay Area.`
- URL/API: `state_border=include|exclude` (default `include`); response field `crosses_state`; spots JSON field `region` (ISO 3166-2, e.g. `US-MI`); spots/API schema version 4.
- Home regions: `se_mi` → `US-MI`, `bay_area` → `US-CA`. `crosses_state = region is not None and region != home_region and country == home_country`.
- Every image ≤ 16,000,000 pixels; level 0 sizes ¼/½/full as today; level 1 = 2×2 tiles, level 2 = 4×4 tiles, each tile = level-0 full size.
- Base and glow both exist at every level, normal and red; red files pass the decoded pixel check (no visible pixel with g or b > r/2).
- Glow: smooth, no visible pixel blocks at any framing; computed from VIIRS with cubic resampling and the existing sky-glow model and color ramps.
- Registration: base, glow tiles, pins and labels line up within 2 px (Web Mercator).
- The app never shows a blank or partial picture: level 0 always under higher levels; never steps down a level/width within the same metro+mode; red mode loads only red files.
- No MapLibre/PMTiles in the production bundle; tokens only, no shadows; never open `api/.env`.

## Review Focus
1. A spot with no `region` (division lookup miss near borders/water) → `crosses_state` false, never excluded by `state_border=exclude` (Task 2 test `region_none_never_crosses`).
2. An R2 manifest without `levels` (pictures rendered before this change) → the app still works at level 0 (Task 6 test `old manifest works at level 0`).
3. A higher-level tile fails to load → level 0 stays visible; no unavailable state (Task 6 test `tile error keeps level 0`).
4. `state_border=exclude` combined with `access=likely` and the night dots → dot queries and spot queries both carry `state_border` (Task 3 test `state_border flows into spots and dot queries`).
5. Resizing across a level threshold → level never drops; the right tiles for the new view load (Task 6 test `resize keeps level and loads visible tiles`).

---

### Task 1: Pipeline: spot state (`region`) and schema 4

**Files:** Modify `pipeline/darksky_pipeline/areas.py`, `build.py`, `assemble.py` (SCHEMA_VERSION = 4), affected tests (`tests/test_areas*.py` or where `AreaFinder` is tested, `tests/test_build.py`, `tests/test_assemble.py`).

**Interfaces:** `AreaFinder.lookup(lon, lat) -> tuple[str | None, str | None, str | None]` = (area name, ISO country, ISO 3166-2 region) — region taken from the containing division area's `region` column (the extract already selects it); `region_for(lon, lat)`. Each spot dict gains `"region"`. Spots JSON `schema_version: 4`.

- [ ] **Step 1: Failing tests**: `test_lookup_returns_region` (fixture division with `region="US-OH"` → third element `"US-OH"`; missing/blank region → `None`); assemble writes `schema_version == 4` and each spot has a `region` key.
- [ ] **Step 2: Run** `pipeline/.venv/Scripts/python -m pytest -q` → FAIL.
- [ ] **Step 3: Implement**; update callers of `lookup` (`build.py:106` unpacks three values).
- [ ] **Step 4: Run** full pytest → PASS.
- [ ] **Step 5: Re-run the spot build** for both metros without tiles (network; takes a while): `.venv/Scripts/python -m darksky_pipeline.build --metro se_mi --release 2026-09-23.1 --viirs data/viirs/vnl_annual.tif --skip-tiles` and the same for `bay_area`. Report spot counts and region tallies (e.g. `US-MI`, `US-OH`, `US-IN`, `CA-ON`).
- [ ] **Step 6: Commit** `feat(pipeline): record each spot's state (region); spots schema 4`.

### Task 2: API: `crosses_state` and `state_border`

**Files:** Modify `api/darksky_api/config.py` (SCHEMA_VERSION = 4; `MetroInfo.home_region`: `se_mi` `"US-MI"`, `bay_area` `"US-CA"`), `service.py` (`_crosses_state`, filter, field), `schemas.py` (`crosses_state: bool`), `app.py` (`state_border: Literal["include","exclude"] = "include"`), tests; sync data (`api/data/` via `python -m darksky_api.sync_data --from ../pipeline/out --to data`).

**Interfaces:** `GET /api/spots?...&state_border=exclude`; each spot JSON has `crosses_state`.

- [ ] **Step 1: Failing tests**: `test_crosses_state_rules` (home MI: `US-OH` + `US` → true; `CA-ON` + `CA` → false; `US-MI` → false); `region_none_never_crosses`; `test_state_border_exclude_filters` via the app client; schema 4 accepted, 3 rejected.
- [ ] **Step 2: Run** `api/.venv/Scripts/python -m pytest -q` → FAIL.
- [ ] **Step 3: Implement** mirroring `_crosses_border`.
- [ ] **Step 4: Sync data, run** full pytest → PASS. Report how many se_mi spots cross state.
- [ ] **Step 5: Commit** `feat(api): crosses_state and state_border filter`.

### Task 3: Web: More filters, state filter, coverage line

**Files:** Modify `web/src/api/types.ts` (`Spot.crosses_state: boolean`; `StateBorderKey`), `web/src/api/client.ts`, `web/src/api/queries.ts` (spots + dot keys/params), `web/src/state/useAppState.ts` (`stateBorder` ↔ `state_border`), `web/src/components/Controls.tsx` (+ `ControlsPanel.css`), `web/src/components/Badges.tsx`, `web/src/components/SpotCard.tsx`, `web/src/components/Welcome.tsx`, tests (`tests/components/controls.test.tsx`, `tests/components/spotcard.test.tsx`, `tests/state/*`, `tests/api/*`, `tests/app.flow.test.tsx`), e2e fixture spots JSON (add `crosses_state`).

**Interfaces:** `AppState.stateBorder: 'include' | 'exclude'` (URL `state_border`, default omitted). Controls: main row = drive slider + sort; **More filters** (always shown) contains switch `Likely open` (on ⇔ `access === 'likely'`; `verified` still hidden unless `showVerified`), and for `se_mi` switches `Crosses country border` (on ⇔ `border === 'include'`) and `Crosses state border` (on ⇔ `stateBorder === 'include'`). Count "(N on)" = number of non-default filters among the three.

- [ ] **Step 1: Failing tests**: More filters holds the three switches with exact labels and correct aria-checked; access segmented control is gone; `state_border flows into spots and dot queries`; URL round-trip for `state_border`; badge `Crosses state border` when `crosses_state`; welcome shows the coverage line verbatim.
- [ ] **Step 2: Run** `npx vitest run` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit`, `npm run lint:css` → PASS.
- [ ] **Step 5: Commit** `feat(web): More filters with likely open, country and state border; coverage line`.

### Task 4: Pipeline: glow at every level, smooth

**Files:** Modify `pipeline/darksky_pipeline/static_maps.py`, `config.py`, tests.

**Interfaces:** Config `STATIC_MAP_LEVELS = (0, 1, 2)`, `STATIC_MAP_GLOW_RES_M = 200`. Darkness grid computed once at 200 m with VIIRS resampled **cubic** (not average) — via a `resampling` parameter on `build_darkness_grid` (default unchanged for spots). `glow_tile_rgba(grid, bounds, level, col, row, width0, height0, stops) -> np.ndarray` warps the sqm grid (cubic) to the tile's Web-Mercator sub-rectangle (tile size = level-0 full size; level 0 = whole extent). Outputs in `pipeline/out/maps/<metro>/glow/`: `L0.png`, `L0_red.png`, `L{l}_{c}_{r}.png`, `L{l}_{c}_{r}_red.png` for l ≥ 1; `extent.json` gains `"levels": [0, 1, 2]`.

- [ ] **Step 1: Failing tests**: tile sub-rectangles tile the extent exactly (corners of tile (c,r) at level l equal the Mercator fractions c/2^l, r/2^l); `glow_tile_rgba` shape = level-0 full size; smoothness: on the fixture city, adjacent-pixel alpha differences at level 2 are ≤ a small bound (no step edges ≥ 3× the median gradient); red tiles pass the ramp check; `resampling` default stays `average` for spots.
- [ ] **Step 2: Run** pytest → FAIL. **Step 3: Implement.** **Step 4: Run** full pytest → PASS.
- [ ] **Step 5: Generate** both metros (`python -m darksky_pipeline.static_maps ...` as before). Report runtime, memory, file counts.
- [ ] **Step 6: Commit** `feat(pipeline): smooth glow at three levels for the static map`.

### Task 5: Render and upload: base at three levels, manifest v2

**Files:** Modify `web/scripts/render-maps.mjs`, `web/render/main.ts` (accept explicit sub-bounds and zoom), `web/render/sizes.ts`, tests in `web/tests/render/`, `scripts/upload_tiles.sh`.

**Interfaces:** Manifest v2 adds, keeping all v1 fields:
```ts
levels: { level: number; cols: number; rows: number }[]   // [{0,1,1},{1,2,2},{2,4,4}]
tiles: { base: string; base_red: string; glow: string; glow_red: string } // e.g. "base_L{l}_{c}_{r}.webp"
```
Tile pixel size = level-0 full `w × h`; level l full image = `w·2^l × h·2^l`. Base tiles are rendered by fitting the map to each tile's Mercator sub-bounds at canvas `w × h`. Glow tiles come from Task 4 PNGs. Encoding as today (base lossy q82; red lossless; glow near-lossless with red pixel-check after decode). Upload allow-list derives every file name from the manifest (level 0 widths + tiles for each level); counts reported.

- [ ] **Step 1: Failing tests**: `tileBounds(bounds, level, col, row)` returns exact Mercator sub-rectangles (round-trip with `toFraction`); manifest v2 shape; upload stub dry-run lists exactly `2 × (2 + 4×3 + 4×(4+16))` = 188 files.
- [ ] **Step 2–4:** FAIL → implement → run vitest/tsc; run `npm run render-maps` for both metros; verify every tile's corner registration ≤ 2 px and red checks; report per-region totals and the largest level-2 tile sizes; look at a level-2 Detroit base tile and glow tile and describe them.
- [ ] **Step 5: Commit** `feat(web): render base and glow at three levels; manifest v2; upload all levels`.

### Task 6: App: pick a level, load visible tiles, never blank

**Files:** Modify `web/src/map/useMapManifest.ts` (v2 validation, v1 still accepted as level-0-only), `web/src/map/StaticMap.tsx` (+ css), `web/src/map/framing.ts` (`chooseLevel`, `visibleTiles`), tests `web/tests/map/*`; e2e fixtures (manifest v2 with level 0 + level 1 at fixture scale) and baselines; `README.md` (render/upload counts).

**Interfaces:** `chooseLevel(levels, fullWidth0, imgW, dpr): number` = smallest level with `fullWidth0·2^level ≥ imgW·dpr`, else the highest; `visibleTiles(level, cols, rows, viewBox: Box): {col,row}[]` = tiles intersecting the visible fraction rectangle. StaticMap renders: level-0 base + glow as today; for level ≥ 1, tile `<img>`s absolutely positioned at their fraction rects in the same layer (same transform as pins), each faded in on load; the chosen level never decreases while metro+mode are unchanged; red uses only red files at every level.

- [ ] **Step 1: Failing tests**: `chooseLevel` thresholds; `visibleTiles` for corner/center views; `old manifest works at level 0`; `tile error keeps level 0`; `resize keeps level and loads visible tiles`; red mode at level 2 requests only `_red` tile files; glow follows the same level as base.
- [ ] **Step 2–4:** FAIL → implement → `npx vitest run`, tsc, lint:css, build, `npm run e2e` (update snapshots once, then a clean pass; describe the baselines).
- [ ] **Step 5: Commit** `feat(web): multi-level sharp map with visible-tile loading`.

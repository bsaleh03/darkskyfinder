# Dark Sky Finder — Plan 3: Web App & Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mobile-first web app (React + MapLibre) that lets a user pick a start point and night and see a verdict plus ranked dark-sky spots on a Moonlit Overture basemap, deployed on Render with tiles on Cloudflare R2.

**Architecture:** Vite + React 18 + TypeScript in `web/`. State lives in the URL (`useAppState`), server data via TanStack Query over a typed API client, MapLibre used directly with the `pmtiles` protocol and a hand-built style. Plain CSS with design tokens; red mode is a token swap. Deploy via `render.yaml` (API web service + static site) and an rclone upload script for R2.

**Tech Stack:** Node ≥ 20 (machine has 24), react 18.3, vite 5, typescript 5.6, maplibre-gl 4, pmtiles 3, @tanstack/react-query 5, vitest 2 + @testing-library/react 16 + jsdom, @playwright/test 1.48, stylelint 16 + stylelint-config-standard.

**Spec:** `docs/superpowers/specs/2026-10-17-dark-sky-web-design.md` (binding). API contract: `api/darksky_api/schemas.py` and `docs/superpowers/specs/2026-10-16-dark-sky-api-design.md`.

## Global Constraints

- App name exactly "Dark Sky Finder"; Render services `darksky-api`, `darksky-web`.
- No `box-shadow` or `text-shadow` anywhere (Stylelint-enforced; MapLibre control CSS overridden). Focus = `outline: 2px solid var(--amber); outline-offset: 2px`.
- Tokens: sky `#1A1840 → #0B0F2A → #070A18 → #05060F`; ink `#EEF0F7`; muted `#9CACC3`; amber `#F5C96B`; violet `#A58BE0`; go/maybe/no `#7FD6A0 / #F0C070 / #F0808A`; glass `rgba(20,24,48,.55)` + `backdrop-filter: blur(10px)` + `1px solid rgba(255,255,255,.08)`; radius 16px cards / 12px controls; font Manrope 400/600/800.
- Moonlit map colors: land `#141A2E`, water `#0C1734`, parks `#18302A`, buildings `#1B2238` (z≥13), motorway/trunk `#59658F`, primary/secondary `#3D4870`, minor `#2C3552` (z≥11), boundaries `#3A4466` dashed, labels `#9AA6C8` halo `#0B0F2A`, glow raster opacity 0.55 below roads/labels.
- Tile source-layers: base {land, land_cover, land_use, water, bathymetry, infrastructure} z0–13; transportation {segment, connector} z4–14; buildings {building, building_part} z5–14; divisions {division, division_area, division_boundary} z0–12; glow raster PNG z6–11.
- Tile URLs: `${VITE_TILES_URL}/<metro>/basemap_<metro>_<theme>.pmtiles` and `${VITE_TILES_URL}/<metro>/lightpollution_<metro>.pmtiles`.
- URL state keys: `lat, lon, night, drive (30–180 step 15, default 90), sort (relevant|closest|best_view), access (all|likely; verified accepted, hidden), border (include|exclude), glow (1|0, default 1), spot`. Red mode in localStorage key `dsf.red`.
- Search: ≥ 2 chars, 250 ms debounce. `/spots` `limit=25`; night dots `limit=3`, max 2 concurrent.
- Directions: Google `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lon>`; iOS `https://maps.apple.com/?daddr=<lat>,<lon>`.
- Copy (exact): headline "Where's the closest dark sky tonight?"; coverage "We cover SE Michigan and the SF Bay Area so far."; cold start "Waking up the stargazing engine…"; 429 "Too many searches — try again in a minute."; unavailable "Not available right now".
- Run web commands from `web/` (`npm run …`). Commit messages end with a blank line then the attribution trailer.

## Review Focus

1. **API cold start (Render free tier sleeps)** — first `/spots` can take 30–60 s; the UI must show WakingUp and retry, not an error. Test: Task 4 `retries through cold start and exposes waking state`.
2. **Start point dragged/tapped outside coverage or into a lake** — `out_of_coverage` 422 must show the coverage message with region chips, never a blank screen. Test: Task 11 `out-of-coverage start shows coverage message`.
3. **Hand-edited or stale URLs** (bad numbers, unknown sort, night in the past) — fall back to defaults/tonight silently. Test: Task 3 `invalid values fall back to defaults`, Task 11 `night_out_of_range resets to tonight`.
4. **Spots with missing optional data** (`area` null, `sqm` of start null, empty `sources`, `access.note` null, all amenities null, `best_window` null) — cards render without "null"/"undefined" text. Test: Task 10 `renders sparse spot without placeholders`.
5. **Fast typing / stale search responses** — an older response must never replace a newer query's results. Test: Task 7 `ignores out-of-order search responses`.

---

## File Structure

```
web/
  package.json, vite.config.ts, tsconfig.json, index.html, .stylelintrc.json, playwright.config.ts, .env.example
  src/main.tsx, App.tsx, config.ts
  src/api/{types.ts, client.ts, queries.ts}
  src/state/useAppState.ts, src/state/redMode.ts
  src/map/{style.ts, pins.ts, MapView.tsx}
  src/components/*.tsx (+ co-located *.css)
  src/theme/{tokens.css, red.css, global.css, starfield.svg, horizon.svg}
  src/test/setup.ts
  tests/**/*.test.ts(x)
  e2e/{flow.spec.ts, fixtures/*.json, fixtures/tiles/...}
  devtiles.ts (Vite dev middleware: serves ../pipeline/out with Range support)
render.yaml
scripts/upload_tiles.sh, scripts/r2-cors.json
README.md (root: project overview + deploy checklist)
```

---

### Task 1: Scaffold, theme tokens, no-shadow guardrail

**Files:** Create `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/.stylelintrc.json`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/config.ts`, `web/src/theme/{tokens.css,red.css,global.css}`, `web/src/test/setup.ts`, `web/tests/app.test.tsx`, `web/tests/stylelint.test.ts`, `web/.env.example`; Modify root `.gitignore` (`web/node_modules/`, `web/dist/`, `web/test-results/`, `web/playwright-report/`).

**Interfaces:**
- Produces: scripts `dev`, `build` (`tsc -b && vite build`), `test` (`vitest run`), `lint:css` (`stylelint "src/**/*.css"`), `e2e` (`playwright test`); `config.apiUrl: string` (from `VITE_API_URL`, default `http://localhost:8000`), `config.tilesUrl: string` (from `VITE_TILES_URL`, default `/tiles`); CSS custom properties `--sky-1..4, --ink, --muted, --amber, --violet, --go, --maybe, --no, --glass, --glass-border, --radius-card, --radius-control`; `html[data-red="true"]` remaps every token (red.css).

- [ ] **Step 1: Create the Vite React-TS project files and install deps** (versions per Tech Stack; dev deps include vitest, jsdom, @testing-library/react, @testing-library/user-event, @testing-library/jest-dom, stylelint, stylelint-config-standard, @playwright/test). Manrope via Google Fonts `<link>` in index.html; `<title>Dark Sky Finder</title>`.
- [ ] **Step 2: Write failing tests**
  - `app.test.tsx`: `renders the app name` → `screen.getByRole('banner')` contains "Dark Sky Finder".
  - `stylelint.test.ts`: `rejects box-shadow and text-shadow` — run `stylelint.lint({code: '.a{box-shadow:0 0 1px red}.b{text-shadow:none}', config})` with the repo config and assert two warnings with rule `property-disallowed-list`; `accepts the theme files` — lint `src/**/*.css` → `errored === false`.
- [ ] **Step 3: Run** `npm test` → FAIL (no App / no config).
- [ ] **Step 4: Implement** `.stylelintrc.json` (`extends: stylelint-config-standard`, `property-disallowed-list: ["box-shadow","text-shadow"]`), tokens/red/global CSS with the Global Constraints values (global.css sets body gradient, Manrope, focus outline rule), minimal `App` with `<header>` "Dark Sky Finder".
- [ ] **Step 5: Run** `npm test && npm run lint:css && npm run build` → all pass.
- [ ] **Step 6: Commit** `feat(web): scaffold with Theme 1 tokens and no-shadow guardrail`.

---

### Task 2: API types and client

**Files:** Create `web/src/api/types.ts`, `web/src/api/client.ts`, `web/tests/api/client.test.ts`.

**Interfaces:**
- Produces types mirroring `api/darksky_api/schemas.py` (schema v3): `Region`, `SearchHit`, `Health`, `Verdict {rating: 'good'|'marginal'|'poor'|'unknown'; sentence; best_window: Window|null; moon: {illumination; rise: string|null; set: string|null}; dark: {start; end; kind}}`, `TimelineHour {time; quality; cloud: number|null; fog; moon_up; past}`, `Spot` (all fields incl. `display_name, area: string|null, country: string|null, crosses_border, recommended, sources: {name;url}[], dark_sky_place, unavailable, unavailable_reason, access {badge; road_class; paved; parking; note: string|null}, amenities: Record<'restroom'|'fuel'|'food', {name;km}|null>, why: string[], sqm, bortle, sky_label, radiance, glare, horizon, drive_minutes, drive_is_estimate, darker_than_home, scores: {site;conditions;best_view;relevant}|null, timeline: TimelineHour[], best_window: Window|null`), `SpotsResponse`, `SpotsParams {lat; lon; night?; drive; sort; access; border; limit}`.
- `class ApiError extends Error { kind: 'out_of_coverage'|'night_out_of_range'|'rate_limited'|'invalid'|'server'|'network'; status?: number; detail?: unknown }`
- `fetchSpots(p: SpotsParams, signal?): Promise<SpotsResponse>`, `fetchSearch(q: string, signal?): Promise<SearchHit[]>`, `fetchRegions(): Promise<Region[]>`, `fetchHealth(): Promise<Health>`; query param names: `lat, lon, night, max_drive, sort, access, border, limit`.
- `errorMessage(e: ApiError): string` (exact copy from Global Constraints; `server`/`network` → "Something went wrong. Check your connection and try again.").

- [ ] **Step 1: Failing tests** (mock `fetch` with vi): `builds spots query` (`max_drive=90&sort=relevant&...` present, `night` omitted when undefined); `maps 422 out_of_coverage` (body `{"error":"out_of_coverage","metros":[...]}` → `kind === 'out_of_coverage'`, `detail.metros` kept); `maps 422 night_out_of_range`; `maps 422 invalid_request → invalid`; `maps 429 → rate_limited`; `maps 500 → server`; `maps TypeError (fetch failed) → network`; `errorMessage copy` for each kind.
- [ ] **Step 2: Run** `npx vitest run tests/api/client.test.ts` → FAIL.
- [ ] **Step 3: Implement** client with `config.apiUrl`, `AbortSignal` passthrough, JSON parse guarded.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(web): typed API client with error mapping`.

---

### Task 3: URL app state and red mode

**Files:** Create `web/src/state/useAppState.ts`, `web/src/state/redMode.ts`, `web/tests/state/useAppState.test.tsx`, `web/tests/state/redMode.test.ts`.

**Interfaces:**
- `type AppState = { start: {lat:number; lon:number} | null; night: string | null; drive: number; sort: 'relevant'|'closest'|'best_view'; access: 'all'|'likely'|'verified'; border: 'include'|'exclude'; glow: boolean; spot: string | null }`
- `parseState(search: string): AppState`, `serializeState(s: AppState): string` (omit defaults), `useAppState(): [AppState, (patch: Partial<AppState>, opts?: {replace?: boolean}) => void]` (history.pushState by default; listens to popstate).
- `useRedMode(): [boolean, (v: boolean) => void]` — localStorage `dsf.red`, sets `document.documentElement.dataset.red`.

- [ ] **Step 1: Failing tests**: `round-trips full state`; `defaults when empty` (drive 90, sort relevant, access all, border include, glow true); `invalid values fall back to defaults` (`drive=abc`, `drive=500`, `drive=37` → 90 / clamped to 180 / snapped to 30 or 45 — rule: non-numeric → 90; clamp 30–180; round to nearest 15), `sort=weird` → relevant, `lat=200` → start null, `night=2026-13-45` → null); `push vs replace` (pushState called by default, replaceState with `{replace:true}`); `popstate updates state`; red mode `persists and sets data-red`, `survives missing localStorage` (throwing getItem → false).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): URL-backed app state and red mode`.

---

### Task 4: Query hooks (spots, night dots, search, warm-up)

**Files:** Create `web/src/api/queries.ts`, `web/tests/api/queries.test.tsx`.

**Interfaces:**
- Consumes Task 2 client, Task 3 `AppState`.
- `useSpots(s: AppState): { data?: SpotsResponse; error?: ApiError; isLoading: boolean; waking: boolean }` — disabled when `start` null; `limit=25`; `waking` true when the request has been pending > 3000 ms or a retry for a `server`/`network` error is in progress; retries `server`/`network` with exponential backoff (1s, 2s, 4s, 8s, 16s, 30s → stop ≈ 61 s); never retries 4xx kinds.
- `useNightDots(s: AppState, nights: string[]): Record<string, 'go'|'maybe'|'no'|undefined>` — `limit=3`, starts after `useSpots` succeeds, max 2 concurrent; rating map good→go, marginal→maybe, poor/unknown→no.
- `useSearch(q: string): { hits: SearchHit[]; loading: boolean }` — `[]` without a request when `q.trim().length < 2`; 250 ms debounce; aborts the previous request; stale responses ignored.
- `useWarmup(): void` — fires `fetchHealth` once per page load, errors ignored.

- [ ] **Step 1: Failing tests** (fake timers + mocked client): `retries through cold start and exposes waking state` (first 2 calls reject network, 3rd resolves → `waking` true before success, data after); `does not retry 4xx`; `dots map ratings and cap concurrency at 2`; `search waits for 2 chars and debounces` (1 call after typing "ro","roy","roya" quickly); `ignores out-of-order search responses` (first slow response resolves after second → hits are from second).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with TanStack Query (`QueryClient` from a `makeQueryClient()` exported for tests/app). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): query hooks for spots, night dots, search and warm-up`.

---

### Task 5: Map style builders and pins GeoJSON

**Files:** Create `web/src/map/style.ts`, `web/src/map/pins.ts`, `web/tests/map/style.test.ts`, `web/tests/map/pins.test.ts`.

**Interfaces:**
- `buildStyle(opts: {tilesUrl: string; metros: string[]; glow: boolean; red: boolean}): maplibregl.StyleSpecification` — sources per metro and theme named `<metro>-base|transportation|buildings|divisions|glow` with `url: "pmtiles://<tilesUrl>/<metro>/basemap_<metro>_<theme>.pmtiles"` (glow: `lightpollution_<metro>.pmtiles`, type raster, tileSize 256); layers in order: background, land, land_cover forest, land_use parks, water, glow (visibility `opts.glow ? 'visible' : 'none'`; the App turns glow off when entering red mode, Task 11), buildings (minzoom 13), roads (3 width classes), boundaries (dashed), labels (division_area names; motorway refs). Colors from Global Constraints; red style maps every color through `toRed(hex)` (luminance-preserving dark red).
- `toRed(hex: string): string`.
- `spotsToGeoJSON(spots: Spot[], selectedId: string|null): GeoJSON.FeatureCollection` — properties `{id, color, selected, darkSky, unavailable}`; color by `sky_label`: vivid `#7FD6A0`, visible `#F0C070`, faint `#F0A070`, not visible `#F0808A`; unavailable `#5A6280`.

- [ ] **Step 1: Failing tests**: `uses pmtiles URLs per metro and theme`; `glow layer below first road layer and hidden when glow=false`; `buildings minzoom 13`; `moonlit colors match spec` (land/water/parks/motorway/labels exact hex); `red style contains no non-red hues` (every color in style passes `isRedOrNeutral`: hue within ±20° of 0 or saturation < 10%); `no shadow-like paint props` (no `*-halo-blur` > 1); `toRed preserves relative luminance order`; pins: `colors by sky label`, `marks selected and unavailable`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): Moonlit and red map styles, pins GeoJSON`.

Note: inspect one real tile's `land_use`/`land_cover` `class`/`subtype` values (spec §10) with `../pipeline/tools/pmtiles.exe tile` or a small node script before finalizing filters; if `class` values differ, filter on `subtype` only and record it in the commit body.

---

### Task 6: MapView component and dev tile server

**Files:** Create `web/src/map/MapView.tsx`, `web/src/map/MapView.css`, `web/devtiles.ts`; Modify `web/vite.config.ts` (register devtiles middleware at `/tiles` → `../pipeline/out`, Range support: 206 + `Content-Range`, 416 on bad range); Test `web/tests/devtiles.test.ts`.

**Interfaces:**
- `<MapView spots: Spot[]; start: {lat;lon}|null; selectedId: string|null; glow: boolean; red: boolean; regions: Region[]; focusRegion?: string; onSelect(id: string): void; onSetStart(p: {lat;lon}): void; onToggleGlow(): void />` — registers `pmtiles` protocol once; renders pins via a GeoJSON source + circle layers; draggable amber start marker (`maplibregl.Marker({draggable:true})`, dragend → `onSetStart`); map click on empty area → `onSetStart` (mobile: after confirm toast "Set start here?"); flies to selected spot/region (no animation when `prefers-reduced-motion`); glow toggle control button; MapLibre controls CSS has no shadows.
- `devtilesMiddleware(root: string)` (connect middleware).

- [ ] **Step 1: Failing tests** (`devtiles.test.ts`, node http against middleware on a temp dir file): `serves full file with 200 and Accept-Ranges`; `serves range with 206 and Content-Range`; `416 for unsatisfiable range`; `404 outside root (path traversal ../ rejected)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** middleware and MapView (MapView verified in Task 12 e2e; keep logic that is unit-testable in Task 5 helpers).
- [ ] **Step 4: Run** `npm test` → PASS; `npm run dev` and open `/` → map renders tiles from `pipeline/out` (manual check, note in commit).
- [ ] **Step 5: Commit** `feat(web): MapView with pmtiles, pins, draggable start; dev tile server`.

---

### Task 7: Top bar, search, locate, metro switch, red toggle

**Files:** Create `web/src/components/{TopBar,SearchBox,LocateButton,MetroSwitch,RedModeToggle}.tsx` (+css); Test `web/tests/components/topbar.test.tsx`.

**Interfaces:**
- `<SearchBox onPick(hit: SearchHit): void; placeholder?: string />` — combobox/listbox ARIA; ↑/↓/Enter/Escape; uses `useSearch`.
- `<LocateButton onLocate(p:{lat;lon}): void; onError(msg: string): void />` — geolocation denied → `onError("Location unavailable — search or tap the map instead.")`.
- `<MetroSwitch regions: Region[]; value: string|null; onChange(key: string): void />`; `<RedModeToggle />` (uses `useRedMode`); `<TopBar … />` composes them with the start chip (label = picked hit name or "Dropped pin").

- [ ] **Step 1: Failing tests**: `search shows hits and picks with keyboard`; `ignores out-of-order search responses` (via SearchBox with mocked client timings); `no request under 2 chars`; `locate success calls onLocate`; `locate denied shows message`; `red toggle sets data-red`; `metro switch lists regions`.
- [ ] **Step 2–4:** run FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(web): top bar with search, locate, metro switch, red toggle`.

---

### Task 8: Night picker and verdict card

**Files:** Create `web/src/components/{NightPicker,VerdictCard}.tsx` (+css); Test `web/tests/components/verdict.test.tsx`.

**Interfaces:**
- `nextNights(today: string, n = 7): string[]`; `nightLabel(night: string, today: string): string` → "Tonight" | "Sat 18".
- `<NightPicker nights: string[]; value: string|null; dots: Record<string,'go'|'maybe'|'no'|undefined>; onChange(n: string|null) />` — dot has an accessible label ("good night", "maybe", "poor night").
- `<VerdictCard verdict: Verdict; forecastStatus; driveStatus; timezone: string />` — times formatted in metro tz `h:mm a`; moon "18% moon, sets 10:26 PM"; notes: forecast unavailable → "Cloud forecast unavailable"; drive approx → "Some drive times are estimates (≈)".

- [ ] **Step 1: Failing tests**: `labels tonight and weekdays`; `dots have text labels`; `verdict renders each rating with matching style class`; `formats times in metro timezone` (Detroit vs LA fixtures); `shows notes for unavailable forecast and approx drive`; `renders without best_window`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(web): night picker and verdict card`.

---

### Task 9: Controls

**Files:** Create `web/src/components/Controls.tsx` (+css); Test `web/tests/components/controls.test.tsx`.

**Interfaces:** `<Controls state: AppState; metro: string|null; showVerified: boolean; onChange(patch: Partial<AppState>) />` — drive slider 30–180 step 15 (label "Within 90 min"); sort segmented (Relevant / Closest / Best view); access segmented (All / Likely open [/ Verified only if showVerified]); "Include Canada" switch only when `metro === 'se_mi'` (checked = border include).

- [ ] **Step 1: Failing tests**: `slider emits snapped values`; `sort and access emit patches`; `verified option hidden unless showVerified`; `Canada switch only in se_mi and maps to border`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(web): controls for drive, sort, access and border`.

---

### Task 10: Spot card family

**Files:** Create `web/src/components/{SpotCard,Badges,NightScrubber,SkyPreview,DarknessScale,SourcesList,Amenities,ExpertNumbers,DirectionsButton}.tsx` (+css); Test `web/tests/components/spotcard.test.tsx`.

**Interfaces:**
- `<SpotCard spot: Spot; homeSqm: number|null; homeLabel: string; expanded: boolean; onToggle(): void; timezone: string />`; collapsed/expanded content per spec §5.3; `aria-expanded`.
- `starCount(sqm: number): number` — 18 → 6, 22 → 120, monotone, clamp; Milky Way band when sqm ≥ 21.
- `directionsUrl(lat, lon, ua: string): string`.
- `<NightScrubber timeline: TimelineHour[]; bestWindow: Window|null; timezone />` — past hours get class `past`; best window outlined.
- `<DarknessScale homeSqm; spotSqm />` — labels "Milky Way casts shadows", "Milky Way", "A few stars", "City".

- [ ] **Step 1: Failing tests**: `collapsed shows name, area, drive, sky label`; `estimated drive prefixed with ≈`; `badges: dark sky, recommended, crosses border`; `unavailable greyed with reason`; `expanded shows scrubber with past hours dimmed`; `sources open in new tab with rel noopener noreferrer`; `renders sparse spot without placeholders` (area null, homeSqm null, sources [], note null, amenities all null, best_window null, scores null → no "null"/"undefined" in textContent); `starCount monotone and bounded`; `directions per platform` (iPhone UA → apple; Android/desktop → google).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(web): spot card with scrubber, sky preview, badges and directions`.

---

### Task 11: Screens, states, and App composition

**Files:** Create `web/src/components/{SpotList,Welcome,WakingUp,EmptyState,ErrorState}.tsx` (+css); Modify `web/src/App.tsx`, `web/src/main.tsx`; Test `web/tests/app.flow.test.tsx`.

**Interfaces:** App wires `useAppState`, `useRedMode`, `useWarmup`, `useSpots`, `useNightDots`, regions; Welcome when `start` null; results layout (mobile stack, desktop ≥ 900px: 400px panel + map); entering red mode sets `glow=false` (replace) unless user toggles; `showVerified` = any spot `access.badge === 'verified'`; widen button sets `drive + 30` (max 180).

- [ ] **Step 1: Failing tests** (mocked client): `welcome when no start`; `results render verdict and cards`; `opening a card sets spot in URL`; `out-of-coverage start shows coverage message` (with region chips); `night_out_of_range resets to tonight` (replace night=null and refetch); `empty state offers widen`; `429 shows rate-limit copy`; `waking state shows Waking up copy`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npm test`, `npm run lint:css`, `npm run build`).
- [ ] **Step 5: Commit** `feat(web): screens, states and app composition`.

---

### Task 12: End-to-end tests and visual baselines

**Files:** Create `web/playwright.config.ts`, `web/e2e/flow.spec.ts`, `web/e2e/fixtures/{regions,search_royal,spots_royal,spots_royal_night2,dots}.json`, `web/e2e/fixtures/tiles/se_mi/*.pmtiles` (tiny extracts); Modify `web/package.json` (`e2e`).

**Interfaces:** Playwright projects `mobile` (390×844) and `desktop` (1280×800); `webServer: npm run dev` with `VITE_API_URL=http://localhost:5199/api-mock`, `VITE_TILES_URL=/e2e-tiles`; API mocked via `page.route('**/api-mock/**')` serving fixtures; tiles served from `e2e/fixtures/tiles` via the devtiles middleware (configure a second mount `/e2e-tiles`).

- [ ] **Step 1: Create fixtures**: JSON captured from the real local API (`api/` running, one call each; strip nothing — schema v3); tiny tiles: `../pipeline/tools/pmtiles.exe extract <out/se_mi/…pmtiles> e2e/fixtures/tiles/se_mi/<same name> --bbox=-83.25,42.40,-83.05,42.55 --maxzoom=11` for each basemap theme and lightpollution (each must be < 2 MB; record sizes).
- [ ] **Step 2: Write the flow test**: search "royal" → pick "Royal Oak" → verdict visible → ≥ 3 cards → expand first → Directions href contains `google.com/maps/dir` (desktop) → pick second night chip (request with `night=` observed) → set drive slider to 60 (request `max_drive=60`) → toggle red mode (`html[data-red=true]`) → toggle Include Canada off (request `border=exclude`); assert no console errors; assert no element has computed `box-shadow` other than `none` (evaluate over `document.querySelectorAll('*')`).
- [ ] **Step 3: Screenshots**: `main-normal`, `main-red` per project via `toHaveScreenshot` (mask the map canvas to avoid GPU nondeterminism).
- [ ] **Step 4: Run** `npx playwright install chromium && npm run e2e` → PASS (first run writes baselines; re-run passes).
- [ ] **Step 5: Commit** `test(web): end-to-end flow and visual baselines`.

---

### Task 13: Deploy config, tile upload script, README

**Files:** Create `render.yaml`, `scripts/upload_tiles.sh`, `scripts/r2-cors.json`, root `README.md`; Modify `api/README.md` (link to root deploy section).

**Interfaces / exact values:**
- `render.yaml` per spec §8.2: `darksky-api` (type web, runtime python, plan free, rootDir api, buildCommand `pip install .`, startCommand `uvicorn darksky_api.app:build_default_app --factory --host 0.0.0.0 --port $PORT`, healthCheckPath `/api/health`, envVars `ORS_API_KEY` sync false, `ALLOWED_ORIGINS` sync false, `TRUSTED_PROXY_HOPS` "1", `PYTHON_VERSION` "3.11.9"); `darksky-web` (type web, runtime static, rootDir web, buildCommand `npm ci && npm run build`, staticPublishPath `dist`, envVars `VITE_API_URL`/`VITE_TILES_URL` sync false, routes rewrite `/*` → `/index.html`, headers `/assets/*` `Cache-Control: public, max-age=31536000, immutable`, `/index.html` `Cache-Control: no-cache`). Verify field names against current Render Blueprint docs (spec §10) and note any rename in the commit body.
- `upload_tiles.sh`: requires an rclone remote named `r2` (README shows `rclone config` for Cloudflare R2: provider Cloudflare, endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`); copies `pipeline/out/<metro>/{basemap_*,lightpollution_*}.pmtiles` to `r2:darksky-tiles/<metro>/` with `--s3-upload-cutoff 100M --s3-chunk-size 64M --progress`; refuses to run if any other file types would be uploaded; never echoes credentials.
- `r2-cors.json`: spec §8.1 values (origins placeholder `https://darksky-web.onrender.com` + `http://localhost:5173`).
- README: project overview, local dev (pipeline → api → web), deploy steps (GitHub repo, Render Blueprint, R2 bucket + CORS + upload, env vars), first-deploy checklist (spec §8.3).

- [ ] **Step 1: Test** `scripts/upload_tiles.sh --dry-run` lists exactly 10 `.pmtiles` files (5 per metro) and nothing else (run with a stub `rclone` on PATH that echoes args); YAML parses (`python -c "import yaml,sys; yaml.safe_load(open('render.yaml'))"`).
- [ ] **Step 2: Implement.** **Step 3: Verify** both checks pass.
- [ ] **Step 4: Commit** `chore(deploy): render blueprint, R2 upload script and CORS, README`.

---

### Task 14: Real-data local run and deploy (human-in-the-loop)

Not dispatched to a subagent; the controller runs it with the user.

- [ ] **Step 1:** Local real-data run: `api` (with `api/.env`) on :8000, `web` `npm run dev` with tiles from `pipeline/out`; check Royal Oak and San Francisco in normal and red mode at mobile and desktop sizes; fix-forward any defects via a reviewed task.
- [ ] **Step 2 (user):** create GitHub repo; **with explicit approval** the assistant adds the remote and pushes `master`.
- [ ] **Step 3 (user):** create R2 bucket `darksky-tiles`, enable public r2.dev URL, apply `scripts/r2-cors.json`, create R2 API token, configure rclone remote, run `scripts/upload_tiles.sh`.
- [ ] **Step 4 (user):** Render → New → Blueprint from the repo; enter `ORS_API_KEY`, `ALLOWED_ORIGINS` (static site URL), `VITE_API_URL` (API URL), `VITE_TILES_URL` (r2.dev URL); update R2 CORS origin to the real site URL.
- [ ] **Step 5:** First-deploy checklist (spec §8.3) incl. one-time XFF log check; record results in README.

---

## Self-Review Notes

- Spec coverage: §2 structure (T1, T6), §3 URL state (T3), §4 data flow (T2, T4, T6, T7), §5 screens/states (T7–T11), §6 visuals/no shadows/red/map style/sky preview (T1, T5, T10, T12), §7 a11y/resilience (T4, T7, T10, T11), §8 hosting/deploy (T13, T14), §9 testing (all tasks + T12), §10 open items (T5 note, T13 note).
- Red-mode glow rule simplified to: entering red mode turns glow off via URL replace; the user can turn it back on (spec §6 "hidden by default in red mode (user can toggle)").

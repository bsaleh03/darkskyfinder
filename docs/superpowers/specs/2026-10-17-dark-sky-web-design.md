# Dark Sky Finder — Web App & Deploy Design (Plan 3)

**Date:** 2026-10-17
**Status:** Approved in brainstorming, pending written-spec review
**Parent specs:** `2026-10-15-dark-sky-finder-design.md` (§2 principles, §3 UX/visuals), `2026-10-16-dark-sky-api-design.md` (API contract). Where they differ, this document wins for the web app and deploy.

## 1. Scope

**In:** the web frontend (`web/`), map style, tile hosting on Cloudflare R2, Render deployment (API web service + static site) via `render.yaml`, first-deploy checklist.
**Out:** pipeline/API feature changes (except the deploy config they need), accounts, alerts, aurora, PWA/offline.

App name: **Dark Sky Finder** (page title, header, Render service names `darksky-api`, `darksky-web`).

## 2. Tech & structure

React 18 + TypeScript + Vite; MapLibre GL JS used directly (thin wrapper, no react-map-gl) + `pmtiles` protocol; TanStack Query for server data; app state in the URL; plain CSS with design tokens (no component library, no Tailwind).

```
web/
  index.html, vite.config.ts, tsconfig.json, package.json, .stylelintrc.json, playwright.config.ts
  public/  (favicon, og image)
  src/
    main.tsx, App.tsx
    config.ts            VITE_API_URL, VITE_TILES_URL
    api/  client.ts      typed fetch for /api/health, /regions, /search, /spots; error mapping
          types.ts       mirrors API schemas (schema v3 spot fields)
          queries.ts     TanStack Query hooks (spots, nightDots, search, regions, health warm-up)
    state/ useAppState.ts  URL query ⇄ state
    map/  MapView.tsx    MapLibre map, pmtiles protocol, pins, start pin (draggable), tap-to-set-start
          style.ts       Moonlit + red style builders
    components/ TopBar, SearchBox, LocateButton, MetroSwitch, RedModeToggle, NightPicker, VerdictCard,
                Controls, SpotList, SpotCard, NightScrubber, SkyPreview, DarknessScale, Badges,
                SourcesList, Amenities, ExpertNumbers, DirectionsButton, WakingUp, EmptyState, ErrorState,
                Welcome
    theme/ tokens.css, global.css, red.css, starfield.svg, horizon.svg
  tests/ (Vitest unit/component), e2e/ (Playwright), e2e/fixtures/ (canned API JSON, tiny .pmtiles)
```

**Config (build time):** `VITE_API_URL` (e.g. `https://darksky-api.onrender.com`), `VITE_TILES_URL` (R2 public base URL). Local dev: API at `http://localhost:8000`, tiles served from `pipeline/out` by a Vite dev middleware or a static server.

## 3. App state (URL)

Query keys: `lat`, `lon` (start), `night` (YYYY-MM-DD; absent = API default "tonight"), `drive` (30–180, default 90, step 15), `sort` (`relevant|closest|best_view`, default relevant), `access` (`all|likely`, default all; `verified` accepted but hidden in UI), `border` (`include|exclude`, default include), `glow` (`1|0`, default 1), `spot` (expanded spot id). Red mode is NOT in the URL (persisted in localStorage, per device). Invalid values fall back to defaults silently. Back/forward navigate between states.

## 4. Data flow

1. On load: `GET /api/health` fire-and-forget (warm-up) + `GET /api/regions` (cached for the session).
2. No start → Welcome screen. Start set → `GET /api/spots` with state params (`limit=25`); TanStack Query caches by params (stale 5 min, retry: see §7).
3. Night dots: for each of the 7 nights, `GET /api/spots?…&night=…&limit=3` in the background after the main result arrives; read only `verdict.rating` → dot (good=go, marginal=maybe, poor/unknown=no). Max 2 concurrent.
4. Search: `GET /api/search?q=` when ≥ 2 chars, 250 ms debounce, cancel stale requests; keyboard-navigable listbox.
5. Map tiles straight from R2 via `pmtiles://` (range requests). Pins from the `/spots` response.
6. Directions: `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lon>` (desktop/Android); `https://maps.apple.com/?daddr=<lat>,<lon>` on iOS (UA detection).

## 5. Screens & behavior

### 5.1 Welcome (no start)
Full-screen Moonlit map of both metros, glass panel: headline "Where's the closest dark sky tonight?", search box, "Use my location", region chips (SE Michigan / SF Bay Area → fly to region; then tap map to set start). Location outside coverage → message "We cover SE Michigan and the SF Bay Area so far." + region chips.

### 5.2 Results (hybrid layout; mobile-first, desktop = left panel 400 px + map)
- **TopBar:** start chip (area/search label; tap → search), MetroSwitch, RedModeToggle.
- **NightPicker:** 7 chips (Tonight, Sat 18, …) each with a go/maybe/no dot.
- **VerdictCard:** sentence; best window; moon (illumination %, sets/rises); dark window; small notes for forecast unavailable / estimated drive times.
- **Mini map** (mobile ~200 px tall, expandable to full screen; desktop full right pane): pins colored by `sky_label` (vivid green, visible amber, faint orange, not visible rose), Dark Sky places with a star ring, selected pin enlarged; amber start pin, draggable (drop → new start); tap map → set start (with confirm toast on mobile). Glow layer toggle button on the map.
- **Controls:** drive slider (30–180 min, step 15), sort segmented control, access segmented (All / Likely open; "Verified only" hidden while no spot in the response metro is verified — i.e. hidden in v1), "Include Canada" switch (only when metro is `se_mi`).
- **SpotList:** ranked spots, then unavailable spots (greyed, "Not available right now" + reason).

### 5.3 Spot card
Collapsed: `display_name`, `area`, badges (Dark Sky seal; "Recommended"; "Crosses border 🇨🇦"), drive time (prefix "≈" if `drive_is_estimate`), `sky_label`, SkyPreview thumbnail (star density from `sqm`).
Expanded (internal scroll, max-height 60vh mobile): NightScrubber (timeline hours; quality bar; cloud/fog/moon icons; past hours dimmed; best window outlined amber), SkyPreview home vs spot + `darker_than_home`, DarknessScale (plain-words labels; home and spot markers), why chips, `access.note`, "Recommended by" source links (open in new tab, `rel="noopener noreferrer"`), Amenities, ExpertNumbers (Bortle, SQM, radiance, glare, horizon), DirectionsButton (amber, full width). Opening a card sets `spot=` in URL and scrolls it into view; tapping its pin does the same.

### 5.4 States
Loading → skeleton cards. API slow > 3 s → WakingUp ("Waking up the stargazing engine…") with retries (exponential, up to ~60 s total). Empty (no spots) → "Nothing within N min." + "Widen to N+30 min" button (disabled at 180). Errors: `out_of_coverage` → coverage message; `night_out_of_range` → reset to tonight; 429 → "Too many searches — try again in a minute."; network/5xx → retry button. All error copy is plain language.

## 6. Visual design

- **Theme 1 tokens** (from parent spec §3.5): sky gradient `#1A1840 → #0B0F2A → #070A18 → #05060F`; ink `#EEF0F7`; muted `#9CACC3`; amber `#F5C96B`; violet `#A58BE0`; go/maybe/no `#7FD6A0 / #F0C070 / #F0808A`; glass `rgba(20,24,48,.55)` + `backdrop-filter: blur(10px)` + 1px `rgba(255,255,255,.08)` border; radius 16 px cards, 12 px controls. Font: Manrope (Google Fonts, 400/600/800, `display=swap`).
- **No box shadows anywhere** (cards, panels, buttons, map controls, popovers, focus). Depth only via translucency, blur and 1px borders; focus = 2px amber outline with 2px offset. Enforced by Stylelint (`declaration-property-value-disallowed-list` / `property-disallowed-list: ["box-shadow"]`, also `text-shadow`) and MapLibre control CSS overrides.
- **Red mode:** all tokens remap to red-on-black (`#000` bg, `#FF3B30` family text/accents, no other hues), map switches to the red style, glass becomes `rgba(40,0,0,.6)`; images/emoji flags rendered desaturated red via CSS filter.
- **Moonlit map style** (built in `style.ts` from Overture PMTiles; source-layers verified in the release files):
  - Sources: `base` (layers `land`, `land_cover`, `land_use`, `water`, `bathymetry`, `infrastructure`; z0–13), `transportation` (`segment`, `connector`; z4–14), `buildings` (`building`, `building_part`; z5–14), `divisions` (`division`, `division_area`, `division_boundary`; z0–12), `glow` (raster PNG z6–11, our light pollution).
  - Background/land `#141A2E`; water `#0C1734`; parks/protected (`land_use` park/protected/recreation) `#18302A`; land_cover forest a hair darker than land; buildings `#1B2238` (z≥13, no outlines); roads: motorway/trunk `#59658F` 1.2→3 px, primary/secondary `#3D4870`, minor `#2C3552` (z≥11); boundaries `#3A4466` dashed; labels (division names, major roads) `#9AA6C8` with `#0B0F2A` halo, Manrope 11–13 px; glow raster opacity 0.55 (toggleable) placed below roads/labels.
  - Red style: same layers, all colors mapped to dark reds / black; glow raster hidden by default in red mode (user can toggle).
- **Pattern visuals:** starfield and horizon silhouette SVGs behind the header; SkyPreview renders N deterministic stars where N scales with `sqm` (18 → ~6, 22 → ~120) plus a faint Milky Way band above `sqm` 21.

## 7. Accessibility & resilience

Keyboard-reachable controls; listbox/combobox semantics for search; `aria-expanded` on cards; badges include text; color is never the only signal; min touch target 44 px; `prefers-reduced-motion` disables map fly animations and scrubber transitions; contrast ≥ 4.5:1 for text in both themes. TanStack Query retry: 3 for network/5xx, none for 4xx; cold start retries handled by WakingUp. The app never shows raw error JSON.

## 8. Hosting & deploy

### 8.1 Cloudflare R2 (tiles)
- Bucket `darksky-tiles`, public access via the r2.dev URL (custom domain optional later).
- Objects: `se_mi/basemap_se_mi_{base,transportation,buildings,divisions}.pmtiles`, `se_mi/lightpollution_se_mi.pmtiles`, same for `bay_area/` (~2.3 GB total).
- CORS: AllowedOrigins = site URL + `http://localhost:5173`; AllowedMethods `GET, HEAD`; AllowedHeaders `Range`, `If-Match`, `If-None-Match`; ExposeHeaders `ETag`, `Content-Length`, `Content-Range`, `Accept-Ranges`; MaxAge 86400.
- Upload: `scripts/upload_tiles.sh` using `rclone` (S3-compatible R2 remote, multipart). The user creates the R2 API token and runs the script; credentials never pass through the assistant or the repo.

### 8.2 Render (`render.yaml` blueprint)
- `darksky-api` (web service, Python, free plan): rootDir `api`, build `pip install .`, start `uvicorn darksky_api.app:build_default_app --factory --host 0.0.0.0 --port $PORT`, healthCheckPath `/api/health`, env `ORS_API_KEY` (sync: false — entered by the user in the dashboard), `ALLOWED_ORIGINS` (the static site URL), `TRUSTED_PROXY_HOPS=1`, `PYTHON_VERSION=3.11.9`.
- `darksky-web` (static site): rootDir `web`, build `npm ci && npm run build`, publish `dist`, env `VITE_API_URL`, `VITE_TILES_URL`, route rewrite `/*` → `/index.html`, headers: cache `assets/*` immutable 1 year, `index.html` no-cache.
- Prerequisite: a GitHub repo the user creates; the assistant pushes only with explicit approval.

### 8.3 First-deploy checklist (README)
`/api/health` OK and cold start time noted; one-time log of `X-Forwarded-For` shape to confirm the rate-limit key (then remove); tiles return 206 with CORS headers; live smoke (Royal Oak, San Francisco) via the site; phone check in red mode outdoors.

## 9. Testing

- **Vitest + Testing Library:** `useAppState` (round-trip, defaults, invalid values); API client (types, error mapping incl. 422 codes, 429, network, retry policy); components: VerdictCard (4 ratings + notes), SpotCard (collapsed/expanded, badges, unavailable, "≈", past hours dimmed, sources links), Controls (Canada switch only in se_mi; verified hidden), NightPicker dots, DirectionsButton URLs per platform, SkyPreview star count monotone in sqm, red-mode token switch.
- **Stylelint** in CI/test script: fails on `box-shadow` / `text-shadow`.
- **Playwright** (mobile 390×844 + desktop 1280×800): full flow (search "royal" → pick → verdict + cards → expand top card → Directions href → switch night → move drive slider → toggle red mode → exclude Canada) against canned API JSON (route interception) and a tiny local `.pmtiles` fixture (no network); screenshots of main screen, normal + red, both viewports, as visual baselines.
- **Manual:** local real-data run (web dev + local API + tiles from `pipeline/out`); post-deploy checklist (§8.3).

## 10. Open items to verify during implementation

- Exact `land_use`/`land_cover` class values present in the tiles for park/forest styling (inspect a tile; fall back to subtype-only filters).
- r2.dev public URL rate limits for production traffic (fine for a portfolio; custom domain if needed).
- Render static site header/redirect syntax in `render.yaml` against current Render docs.

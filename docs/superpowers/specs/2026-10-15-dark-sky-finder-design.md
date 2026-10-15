# Dark Sky Finder — Design Spec

**Date:** 2026-10-15
**Status:** Approved in brainstorming, pending written-spec review
**Working name:** Dark Sky Finder

## 1. Purpose

> "On a given night, where's the closest place I can actually go to see the stars — and is it worth the drive?"

- **Goal:** portfolio / learning project showcasing Overture Maps data fused with satellite and weather data. Polish and demo-ability over scale.
- **Hard requirement:** the app must be built on Overture Maps data.
- **Primary user:** casual city stargazer (not telescope hobbyists). Wants to see the Milky Way; needs plain language and a go/no-go answer.
- **Success:** a user picks a start point and night and has a destination plus a go/no-go answer in under 30 seconds.
- **Coverage (v1):** SE Michigan (greater Detroit) and the SF Bay Area, each with a region reaching ~2h drive from the core (SE MI: Lake Hudson to the Thumb; Bay Area: Point Reyes to Pinnacles).

## 2. Design principles

1. **An answer, not a map.** Lead with a recommendation; the map supports it.
2. **Night-aware.** Everything is computed for a chosen night: darkness window, moon, clouds/fog.
3. **Reachable and legal.** Only places you can drive to and be at after dark; be honest about access confidence.
4. **Honest uncertainty.** Show why a spot ranks, data freshness, and forecast confidence.
5. **Night-safe UI.** Dark by default; one-tap red night-vision mode.
6. **Plain language.** "Milky Way bright overhead" instead of Bortle/SQM; expert numbers one tap away.
7. **Mobile-first.** Used in a car or parking lot.

## 3. UX

### 3.1 Core flow

1. Choose a **start point**: search (address/place/area), drop or drag a pin, or "use my location" (convenience, not default). The start point is always editable.
2. Choose a **night**: tonight + next 6 nights.
3. See the **night verdict**: Good / Marginal / Poor, best time window, moon line.
4. See **spots** on a mini map and in a ranked list.
5. Adjust **filters**: max drive time slider (30–180 min, default 90), access filter (All / Likely+ / Verified).
6. Change **sort**: **Relevant** (default, blended score), **Closest** (drive time), **Best view** (darkness + that night's clouds/fog/moon).
7. Tap a spot → card **expands in place**, internally scrollable (no "More" panel).
8. **Directions** → hand off to Google Maps / Apple Maps.

### 3.2 Layout

- **Hybrid layout (mobile):** top bar (start point, locate, metro switch, red-mode toggle) → week-at-a-glance night picker → verdict → mini map → controls → spot list.
- **Desktop:** same components; panel on the left, large map on the right.
- **No dedicated `/spot` page.** Results are personalized by start point. App state (`lat, lon, night, drive, access, sort`) lives in the URL query so refresh/back/sharing work.

### 3.3 Spot card

- **Collapsed:** name, Dark Sky seal if certified, drive time, access badge, sky label, mini sky preview.
- **Expanded (scrollable):** night timeline scrubber, sky preview home vs spot, plain-words darkness scale, "why it's good" chips (horizon, glare, parking), access/hours, nearby amenities, collapsed expert numbers (approx. Bortle, SQM, VIIRS radiance), Directions button.
- **Unavailable spot** (flagged in curated data): stays visible, greyed, labeled **"Not available right now"**, excluded from ranking.

### 3.4 Access badges

- **Verified** — in the hand-curated list per metro (known night access).
- **Likely** — night-friendly Overture category (campground, observatory, boat launch, etc.).
- **Check hours** — everything else.

### 3.5 Visual design (Theme 1: clean sans)

Synthesized from Sky Guide, Star Walk 2, DarkSky International, PhotoPills, Stellarium Web, Clear Outside, Astrospheric (patterns borrowed, no branding/assets copied).

- **Font:** Manrope (headlines 800, body 400/600).
- **Palette:**
  - Sky gradient `#1A1840` → `#0B0F2A` → `#070A18` → `#05060F`
  - Ink `#EEF0F7`, muted `#9CACC3`
  - Action amber `#F5C96B` (primary buttons, best-window outline, selected start pin)
  - Secondary violet `#A58BE0`
  - Go / Maybe / No: `#7FD6A0` / `#F0C070` / `#F0808A` (go/no-go only)
- **Visual elements:** subtle starfield background, mountain/horizon silhouette under the header, translucent "glass" cards (`rgba(20,24,48,.55)`, blur, 1px light border), mini sky previews whose star density reflects darkness.
- **Red mode:** all tokens swap to red-on-black; map switches to a dark-red style; persisted in localStorage.
- **Accessibility:** keyboard navigable, labeled controls, status never by color alone (text + icon).

### 3.6 Borrowed patterns

**In v1 (core set):**
- Night timeline scrubber (sunset → dawn bar: moon up/down, cloud arrival, best window outlined).
- Week at a glance (night picker with go/maybe/no dot per night).
- Sky preview: home vs spot.
- Plain-words darkness scale ("Milky Way casts shadows … City"), home and spot marked.
- Certified Dark Sky Place seal (from curated data).

**Stretch goals (documented, not in v1):**
- Milky Way core direction compass ("where to look", seasonal Mar–Oct).
- Astronomer-style hourly sky clock (clouds / darkness / fog rows) in expert section.
- "Clear night ahead" alerts (needs accounts or push → v2).
- Aurora layer.

## 4. Architecture

```
[Your PC]  Pipeline (Python + DuckDB)
   ├─ reads Overture GeoParquet from S3 (pinned release)
   ├─ reads VIIRS annual night-lights composite
   └─ writes:
        spots_<metro>.json, darkness_<metro>.npz, search_<metro>.sqlite  → bundled into API deploy
        basemap_<metro>.pmtiles, lightpollution_<metro>.pmtiles          → Cloudflare R2

[Render static site]  React + TypeScript + Vite + MapLibre
   ├─ loads PMTiles from R2 (range requests)
   └─ calls API

[Render web service]  FastAPI
   ├─ in-memory spots + darkness grid, SQLite FTS search
   ├─ OpenRouteService matrix API (drive times; key server-side)
   ├─ Open-Meteo (hourly cloud / low cloud / visibility)
   └─ astral (twilight, moonrise/set, illumination)
```

- **Why offline pipeline (not live S3 queries):** live queries would take seconds to tens of seconds per request, exceed free-tier RAM/CPU, recompute identical results, and break when Overture retires old release paths. Monthly re-runs track Overture releases. On-demand regional builds are the v2 path for arbitrary coverage.
- **Hosting:** Render free tier (static site + web service), Cloudflare R2 free tier for tiles. Cold starts (~30–60s after idle) accepted; mitigated by warm-up ping. Upgrade path: $7/mo always-on instance.

### 4.1 Where Overture is used

| Use | Overture theme |
|---|---|
| Candidate spots | Places (park, state/national park, campground, beach, scenic viewpoint, observatory, boat launch); parking places as viewing-point access aids |
| Park extent, darkest reachable corner | Base: land use (parks, protected areas, recreation) |
| Horizon openness | Base: land cover + water |
| Local glare penalty | Buildings |
| Road access, paved, not private; highway headlight penalty | Transportation |
| Start-point search | Addresses + Places + Divisions |
| Region membership, "darker than home" area naming | Divisions |
| Nearby amenities (restrooms, gas, food) | Places |
| Rendered map | Overture PMTiles basemap |
| Stable spot identity | GERS IDs (curated data keyed by GERS ID) |

Non-Overture inputs only where Overture has no data: VIIRS (night brightness), Open-Meteo (weather), astral (sky timing), OpenRouteService (drive time).

## 5. Data pipeline (offline)

Per metro, with a configured region bounding box and a pinned Overture release:

1. **Extract** Overture themes (places, land use, land cover, water, buildings, transportation, addresses, divisions) via DuckDB, clipped to the region.
2. **Candidate spots:** Places in target categories ∪ land-use park/protected polygons; attach places to containing polygons; dedupe; merge with curated YAML.
3. **Curated YAML** (`curated/<metro>.yaml`), keyed by GERS ID: `verified: true`, `dark_sky_place: true`, `access_note`, `unavailable: true` + reason.
4. **Darkness:** clip VIIRS annual composite (with a 50 km pad so lights just outside the region still count), resample to a 500 m grid, and convolve with a distance-decay kernel (∝ d^-2.5, 50 km radius) to model **sky glow** — a dark pixel next to a city is not a dark sky. Convert sky glow → approx SQM/Bortle → label: *Milky Way vivid / visible / faint / not visible*. Within each spot's polygon, sample points within ~300 m of a drivable road or a parking place; among samples within 0.1 mag of the darkest, the one nearest the spot's center becomes the **viewing point**. Parking places are access aids, not spots on their own.
5. **Glare:** building count within 1 km of viewing point + distance to nearest motorway/trunk → glare penalty.
6. **Horizon:** land cover/water mix within 1 km (water, grass, crop = open; forest = closed) → *Open / Partial / Enclosed*.
7. **Access:** nearest drivable non-private road, parking presence, badge (Verified / Likely / Check hours).
8. **Amenities:** Places within ~5 km of viewing point (restrooms, fuel, food) → nearest of each with distance.
9. **Outputs:**
   - `spots_<metro>.json` — all fixed spot features.
   - `darkness_<metro>.npz` — 500 m sky-brightness (SQM) grid + georeference (~1 MB) for any-point "darker than home".
   - `search_<metro>.sqlite` — FTS5 index of addresses, places, division names.
   - `basemap_<metro>.pmtiles` — extracted from Overture's published tiles → R2.
   - `lightpollution_<metro>.pmtiles` — VIIRS overlay → R2.

**Out of scope v1:** OSM opening hours.

## 6. API (FastAPI)

### 6.1 Endpoints

- `GET /api/regions` → metros, bounding boxes, default views.
- `GET /api/search?q=` → matches (name, type, lat, lon, metro).
- `GET /api/spots?lat&lon&night=YYYY-MM-DD&max_drive=90&access=all|likely|verified&sort=relevant|closest|best_view` →
  - `verdict`: rating (good/marginal/poor), best window, moon summary, sentence.
  - `home`: radiance, sky label.
  - `spots[]`: id (GERS), name, location, drive_minutes, drive_is_estimate, sky label, darker_than_home ratio, badges, dark_sky_place, unavailable, hourly timeline for the night, best window, why-chips, amenities, expert numbers, scores.
- `GET /api/health` → warm-up ping.

### 6.2 `/api/spots` flow

1. Resolve metro containing start point; else out-of-coverage error.
2. Prefilter spots by straight-line distance; keep ≤ ~50.
3. ORS matrix for drive times; cache 24h keyed by start point rounded to ~1 km; drop spots over `max_drive`.
4. Open-Meteo multi-coordinate hourly forecast (total cloud, low cloud, visibility) for the night; cache 1h; nearby spots share a forecast cell. Low cloud + visibility = fog proxy.
5. astral: astronomical dusk → dawn, moonrise/set, illumination per spot location.
6. Hourly sky quality = clear factor × moon factor; best window = longest run of good hours.
7. Score, filter, sort.

### 6.3 Scoring (0–100; weights configurable and calibrated against known spots)

- **Site quality** (static): log-scaled darkness − glare penalty + horizon bonus.
- **Conditions** (per night): quality of best window.
- **Best view** = site quality × conditions.
- **Relevant** = best view − drive-time penalty + small access-badge bonus.
- **Closest** = drive minutes ascending.
- **Night verdict** = conditions across the top few spots.
- **Darker than home** = sky-brightness ratio from the SQM grid, `10^(0.4 × (sqm_spot − sqm_home))`, rounded ("~6× darker").

## 7. Error handling

| Situation | Behavior |
|---|---|
| Start point outside coverage | Friendly message + jump-to buttons for both metros |
| ORS down / quota exceeded / timeout (5s) | Straight-line × road factor, labeled "≈ approx drive" |
| Open-Meteo down / timeout (5s) | Rank on darkness + drive; verdict "Forecast unavailable"; Best view falls back to darkness |
| Forecast partially missing for a night | Mark night "low confidence" |
| No spots within max drive | Message naming the closest good spot + button to widen slider |
| All nights poor | Honest verdict naming the least-bad night |
| Bright moon | Verdict explains: bright stars/planets only |
| Short astronomical darkness | Show the real window ("Truly dark only 11:40p–3:10a") |
| Geolocation denied | Silently fall back to search |
| API cold start | Static app + map load immediately; first search shows "Waking up the stargazing engine…" with retry/backoff |
| Spot flagged unavailable | Greyed card, "Not available right now", excluded from ranking |
| Search no results | Suggest city/address or dropping a pin |

Server: timeouts on all outbound calls, structured logging, no stack traces to clients, API keys only in Render environment variables.

## 8. Testing

**Pipeline (pytest):** unit tests per feature step on tiny fixtures (darkest reachable point, glare, horizon, access badge, radiance→label); golden test on a small bbox around Lake Hudson; sanity checks on real output (spot count range, all within region, every spot has a viewing point, darkest spots not in cities); known-spot check (Lake Hudson, Port Crescent, Henry Coe darker than Royal Oak / downtown SF).

**API (pytest + httpx):** scoring and best-window unit tests with hand-built hourly data; astral timings vs published tables for fixed dates; ORS and Open-Meteo mocked (normal, timeout, quota) to verify fallbacks; endpoint tests (out-of-region, no spots, sorts, filters).

**Frontend (Vitest + Testing Library; Playwright):** component tests (verdict states, card expand, filters/sort, red mode, unavailable cards); E2E smoke with mocked API (search → pick night → expand top spot → Directions link correct); mobile viewport snapshot.

**Manual:** real-phone, real-night field test in red mode before calling v1 done.

## 9. Out of scope (v1)

Accounts, saved spots, alerts, PWA/offline, aurora, Milky Way direction, hourly sky clock, OSM opening hours, user reviews, regions beyond SE MI and Bay Area, live traffic.

## 10. Open items to verify during implementation

- Current OpenRouteService free-tier limits (requests/day, matrix size).
- Current Render free-tier terms (RAM, sleep, bandwidth).
- Overture PMTiles availability/extract workflow for the pinned release.
- Size of `search_<metro>.sqlite`; if too large, limit to places + divisions + pin drop.
- VIIRS product choice (VNL annual vs Black Marble VNP46A4) and radiance→SQM conversion constants.

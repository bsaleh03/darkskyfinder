# Dark Sky Finder — API Design (addendum to 2026-10-15 spec §6)

**Date:** 2026-10-16
**Status:** Approved in brainstorming, pending written-spec review
**Parent spec:** `docs/superpowers/specs/2026-10-15-dark-sky-finder-design.md` (§6 API, §7 errors, §8 testing). This addendum makes §6 concrete and records decisions made after the pipeline shipped. Where they differ, this document wins.

## 1. Scope

A FastAPI service (`api/` in this repo) that serves ranked stargazing spots for a start point and night, start-point search, and region metadata. It reads pipeline outputs (schema v2) and calls OpenRouteService (drive times) and Open-Meteo (weather); sky timing is computed locally.

**In:** API code, tests, a data-sync CLI, a slim search index (small pipeline change).
**Out:** Render deploy, R2 tile upload, frontend (Plan 3); sky-glow falloff recalibration (later pipeline tweak).

## 2. Inputs

`DATA_DIR/<metro>/` per metro (`se_mi`, `bay_area`):

| File | Source | Use |
|---|---|---|
| `spots_<metro>.json` | pipeline, schema v2 | spot features (`id, name, display_name, area, category, lon, lat, sqm, bortle, sky_label, radiance, glare, horizon, access{badge, road_class, paved, parking, note}, dark_sky_place, unavailable, unavailable_reason, amenities, why`) |
| `darkness_<metro>.npz` | pipeline | SQM grid for any start point (`sqm`, `meta=[x0, y0, res, epsg]`) |
| `search_<metro>.sqlite` | pipeline (slim) | FTS5 `search(name, kind, lat, lon)` |

**Slim search index (pipeline change):** `search_rows` stops including street addresses (config `SEARCH_INCLUDE_ADDRESSES = False`); places + division areas only. Target < 50 MB per metro so files can live in git.

**Data sync:** `python -m darksky_api.sync_data --from ../pipeline/out --to data` copies the three files per metro (never tiles) and verifies `schema_version == 2`. `api/data/` is committed.

## 3. Architecture

```
api/darksky_api/
  config.py     metros (key, name, bbox, center, zoom, timezone, home label), constants, env settings
  data.py       load spots + darkness grids per metro at startup; metro_for(lon, lat)
  grid.py       minimal DarknessGrid loader/sampler (numpy + pyproj; no pipeline import)
  search.py     FTS5 query (prefix tokens, punctuation-safe), across metros or one metro
  sky.py        astral: astronomical dusk/dawn, moon rise/set/illumination, hourly moon-up
  forecast.py   Open-Meteo client + parsing + 1 h cache
  routing.py    ORS matrix client, straight-line fallback, 24 h cache, daily quota counter
  scoring.py    hourly quality, best window, site/conditions/best_view/relevant, verdict
  ratelimit.py  per-IP sliding window
  cache.py      tiny TTL cache
  app.py        FastAPI app, CORS, routes, error mapping
  sync_data.py  CLI from §2
```

Core modules have no FastAPI imports. All outbound HTTP goes through injectable `httpx.Client`s so tests never hit the network.

## 4. Endpoints

### `GET /api/health`
`{"ok": true, "metros": ["bay_area","se_mi"], "release": "<overture release>"}` — also the warm-up ping.

### `GET /api/regions`
`[{key, name, bbox:[w,s,e,n], center:[lon,lat], zoom, timezone}]`

### `GET /api/search?q=&metro=&limit=8`
`[{name, kind, lat, lon, metro}]`. `metro` optional (default: all). Empty/punctuation-only `q` → `[]`. `limit` 1–20.

### `GET /api/spots`
Query: `lat, lon` (required), `night=YYYY-MM-DD` (default: tonight in metro tz), `max_drive=90` (15–240 min), `access=all|likely|verified` (default all), `sort=relevant|closest|best_view` (default relevant), `limit=25` (1–50).

Response:
```json
{
  "metro": "se_mi",
  "night": "2026-10-16",
  "timezone": "America/Detroit",
  "start": {"lat": 0, "lon": 0, "sqm": 18.25, "sky_label": "Milky Way not visible"},
  "verdict": {"rating": "good|marginal|poor|unknown", "sentence": "...",
              "best_window": {"start": "ISO", "end": "ISO"} | null,
              "moon": {"illumination": 0.18, "rise": "ISO|null", "set": "ISO|null"},
              "dark": {"start": "ISO", "end": "ISO", "kind": "astronomical|nautical"}},
  "forecast_status": "ok|partial|unavailable",
  "drive_status": "ok|approx",
  "spots": [ { ...all spot fields from §2...,
               "drive_minutes": 78, "drive_is_estimate": false,
               "darker_than_home": "~6× darker" | "about the same",
               "scores": {"site": 0, "conditions": 0, "best_view": 0, "relevant": 0},
               "timeline": [{"time": "ISO", "quality": 0.0, "cloud": 0, "fog": false, "moon_up": false}],
               "best_window": {"start": "ISO", "end": "ISO"} | null } ]
}
```
Unavailable spots are included after all ranked spots, unscored (`scores` null), so the UI can grey them.

## 5. Processing for `/api/spots`

1. **Metro:** first metro whose bbox contains the point; else `422 {"error": "out_of_coverage", "metros": [...]}`.
2. **Night:** must be today…today+6 in the metro timezone; else `422 {"error": "night_out_of_range"}`.
3. **Prefilter:** spots passing `access`; straight-line distance ≤ `max_drive × 1.2 km`; keep nearest 50.
4. **Drive times:** ORS `POST /v2/matrix/driving-car`, sources `[0]`, destinations the rest, metrics `duration`; timeout 5 s. Cache key: start rounded to 0.01° + sorted spot ids, TTL 24 h. Fallback (error, timeout, missing key, or daily counter ≥ `ORS_DAILY_BUDGET = 450`): `straight_km × 1.35 / 60 km/h`, `drive_is_estimate = true`, `drive_status = "approx"`. Drop spots with drive > `max_drive`.
5. **Dark window:** astral at the start point for the night: astronomical dusk → astronomical dawn; if the sun never reaches −18° (rare at these latitudes), nautical, with `kind = "nautical"`. Hourly slots on the hour within the window.
6. **Forecast:** Open-Meteo `/v1/forecast`, `hourly=cloud_cover,cloud_cover_low,visibility`, `timezone=<metro tz>`, `forecast_days=8`, many coordinates per call (grouped by 0.1° cell). Cache per cell, TTL 1 h; timeout 5 s. Missing → `forecast_status` `partial`/`unavailable`.
7. **Moon:** illumination from astral phase, `(1 − cos(2π·phase/29.53))/2`; up/down per slot from moonrise/moonset at the spot (computed once per metro per night at the metro center; < 0.3% error at metro scale).
8. **Hourly quality** (0–1): `clear = 1 − cloud/100`; fog if `cloud_low ≥ 70` or `visibility < 2000 m` → `clear × 0.3`; `moon = 1 − 0.8 × illumination` when the moon is up, else 1; `quality = clear × moon`. Without forecast, `clear = 1` (moon only).
9. **Best window:** longest run of consecutive slots with `quality ≥ 0.6` (ties → earliest); null if none.
10. **Scores (0–100, rounded ints):**
    - `site = clamp((sqm − 18)/4 × 100 − 20 × glare.penalty + {open: 5, partial: 0, enclosed: −5}[horizon.class])`
    - `conditions = 100 × mean(quality in best window) × min(1, hours/2)`; no window → `50 × max(quality)`; forecast unavailable → computed from moon only
    - `best_view = site × conditions / 100`
    - `relevant = best_view − 25 × drive/max_drive + {verified: 5, likely: 2, check_hours: 0}[badge]`
11. **Sort:** relevant/best_view descending, closest ascending; ties → id. Truncate to `limit`.
12. **Verdict:** mean `conditions` of the top 3 by best_view: ≥ 60 good, ≥ 35 marginal, else poor; `unknown` if no spots. Sentence examples: "Good night to go — clear 9:30 PM–12:30 AM, moon sets 10:40 PM." / "Not great — clouds most of the night." / "Full moon — bright stars and planets only."
13. **Darker than home:** `ratio = 10^(0.4 × (spot.sqm − start.sqm))`; `< 1.5` → "about the same", else `"~N× darker"` (N rounded; ≥ 10 → nearest 5).

## 6. Protection, config, errors

- **Rate limit:** 20 `/api/spots` requests per minute per client IP (in-memory sliding window) → `429`.
- **ORS budget:** process-wide daily counter (UTC day); over budget → fallback estimates, no error.
- **CORS:** origins from `ALLOWED_ORIGINS` (comma list) + `http://localhost:5173`.
- **Env:** `ORS_API_KEY` (optional; absent → estimates), `ALLOWED_ORIGINS`, `DATA_DIR` (default `./data`). Key never returned to clients or logged.
- **Errors:** validation → 422 with `{"error": code, "detail": ...}`; outbound failures never surface as 5xx; unexpected → 500 `{"error": "internal"}` without stack traces.
- **Startup:** missing/invalid data for a metro → fail fast with a clear message.

## 7. Testing

- **Unit:** scoring (fixed hourly arrays: clear night, cloudy, fog, moon up until midnight, no good hours), best window ties, darker-than-home formatting, rate limiter, TTL cache.
- **Sky:** astral dusk/dawn and moon rise/set for Detroit on fixed dates vs. published tables (±3 min).
- **Clients (mocked transport):** ORS ok / timeout / 429 / missing key → fallback; Open-Meteo ok / partial / down; cache hits avoid calls; ORS budget switch.
- **Endpoints (TestClient, fixture metro):** health, regions, search (punctuation, metro filter), spots happy path, sorts, access filter, max_drive filter, out_of_coverage, night_out_of_range, unavailable spots last, forecast down → still 200.
- **Contract:** response matches §4 shape (pydantic models) for a fixture metro built from a tiny spots JSON + npz.

## 8. Dependencies

Python 3.11+, fastapi, uvicorn, httpx, astral (≥ 3.2), numpy, pyproj, pydantic v2; pytest, respx (or httpx MockTransport).

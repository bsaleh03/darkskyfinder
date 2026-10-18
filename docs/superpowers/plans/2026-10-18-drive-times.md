# Realistic Drive Times Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive times match what people see in Google Maps: route to each spot's entrance (not its darkest interior point) and calibrate the router's times.

**Architecture:** The pipeline records an `entry` point per spot (a parking place in the spot's access zone near the viewing point, else the public paved road point nearest the viewing point). The API routes to `entry` (falling back to the spot point), multiplies OpenRouteService durations by a calibrated factor, and uses a faster fallback estimate; it returns `entry` so Directions go there too.

**Tech Stack:** Python pipeline (shapely), FastAPI, React/TS.

**Spec:** User decision in chat (2026-10-18): "Route to the entrance + calibrate". Evidence: Royal Oak → Ortonville Recreation Area showed 71 min vs ~40 min real; ORS to the town point 52 min; spot points sit deep inside parks on service roads/tracks. Calibration samples (Google vs ORS, same endpoints): Ortonville 39/52, Crosswinds Marsh 39/57, Ann Arbor 53/60, Detroit 20/22, SF→Livermore 50/56 (ratios 0.68–0.91).

## Global Constraints
- `ROUTE_TIME_FACTOR = 0.8` applied to every ORS duration (comment the calibration samples above next to it).
- Fallback estimate: `FALLBACK_ROAD_FACTOR = 1.35`, `FALLBACK_SPEED_KMH = 95` (Google's samples ≈ 70 km/h straight-line).
- Spot field `entry`: `{"lon": float, "lat": float}` or `null`; spots/API schema version 5.
- Entry choice (anchored on the viewing point): parking places within `ACCESS_SEARCH_M` of the spot area and within `ENTRY_PARKING_MAX_KM` (1.5 km) of the viewing point first, the one nearest the viewing point; otherwise points on paved, non-highway roads of class primary/secondary/tertiary/residential/unclassified (never `service` or `track`) within `ACCESS_SEARCH_M` of the area and within `ENTRY_ROAD_MAX_KM` (3 km) of the viewing point, the point nearest the viewing point (class does not outrank distance); none → `null` (routing/directions use the viewing point).
- The darkness/viewing point (`lat`/`lon`, sqm, etc.) is unchanged.
- Directions link uses `entry` when present, else the spot point.
- Never open or print `api/.env`; a demo API/web run on ports 8000/5173 (don't stop them).

## Review Focus
1. Spot whose area has no qualifying entry → `entry: null`, routing and directions use the spot point (Task 1 `entry_none_when_only_tracks`, Task 2 `routes_to_spot_point_without_entry`).
2. Route cache keyed by the destination actually routed (entry vs point), so old cached durations aren't reused for the new destination (Task 2 test `cache_key_uses_entry`).
3. Estimated (fallback) minutes are also not scaled twice (factor applies to ORS only) (Task 2 `factor_applies_to_ors_only`).

---

### Task 1: Pipeline: spot entrance point, schema 5
**Files:** `pipeline/darksky_pipeline/roads.py` (`find_entry(area, roads, parking_xy, projector, vp_xy, region=None) -> tuple[float, float] | None` returning lon/lat), `build.py` (set `s["entry"]`), `assemble.py` (SCHEMA_VERSION = 5; keep `entry` in output), tests.
- [ ] Failing tests: `entry_prefers_parking`, `entry_parking_nearest_to_viewing_point`, `entry_parking_far_from_viewing_point_falls_to_road`, `entry_near_road_beats_far_side_primary`, `entry_ignores_road_of_distant_area_part`, `entry_none_when_only_tracks` (service/track only → None), assembled spots have `entry` and schema 5.
- [ ] Implement; full pytest; rebuild both metros with `--skip-tiles`; report how many spots got a parking entry / road entry / none, and the median distance between entry and spot point.
- [ ] Commit `feat(pipeline): spot entrance points for routing; spots schema 5`.

### Task 2: API: route to the entrance, calibrated times
**Files:** `api/darksky_api/config.py` (SCHEMA_VERSION 5, `ROUTE_TIME_FACTOR`, fallback speed), `routing.py`, `service.py` (destination = entry or point; output `entry`), `schemas.py`, tests; sync data.
- [ ] Failing tests: `factor_applies_to_ors_only`; `routes_to_entry_when_present`; `routes_to_spot_point_without_entry`; `cache_key_uses_entry`; fallback minutes for 50 km straight = 50×1.35/95×60 ≈ 42.6; response includes `entry`; schema 5 accepted.
- [ ] Implement; sync data; full pytest. Then with the real key (never printed), query the local app for Royal Oak (42.4895, −83.1446) and report minutes for Ortonville Recreation Area, Crosswinds Marsh, White Oak Twp Park, Pointe Mouillee before vs after.
- [ ] Commit `fix(api): route to spot entrances; calibrate drive times`.

### Task 3: Web: directions to the entrance
**Files:** `web/src/api/types.ts` (`entry: {lon, lat} | null`), `web/src/components/SpotCard.tsx`/`DirectionsButton.tsx`, tests, e2e fixture spots (add `entry`).
- [ ] Failing test: Directions href uses `entry` when present, spot point otherwise.
- [ ] Implement; `npx vitest run`, tsc, lint:css, `npm run e2e`.
- [ ] Commit `feat(web): directions go to the spot entrance`.

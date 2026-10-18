# Dark Sky Finder — Filters, State Borders and High-Resolution Map

Amends `2026-10-18-static-map-design.md` and `2026-10-17-dark-sky-web-design.md`. Where they disagree, this wins.

## 1. What and why
- Fewer controls up front: rarely used filters live in **More filters**.
- People near a state line (e.g. southeast Michigan next to Ohio and Indiana) want to choose whether to see spots in
  another state, the same way they can for Canada.
- The map picture should look clearly better: sharper at every drive time, with more Overture detail.
- The welcome screen should say plainly where the app works.

## 2. Filters (web)
- **More filters** holds: **Likely open** (moved from the main controls), **Crosses country border**, and the new
  **Crosses state border**. The main controls keep the drive slider, sort, and an "All" state implied by Likely open
  being off.
  - *Likely open* becomes a switch (on = `access=likely`, off = `access=all`); "Verified only" stays hidden as today.
  - *Crosses country border* replaces "Include Canada": same `border` URL setting, switch on = include (default).
  - *Crosses state border*: new `state_border` URL setting (`include` default | `exclude`), switch on = include.
  - Show the More filters button for every region (Likely open applies everywhere); the country/state switches show
    only where they can matter (country: Michigan; state: Michigan). The "(N on)" count counts any non-default filter.
- Spot cards get a **"Crosses state border"** badge like the existing country one.

## 3. State borders (pipeline + API)
- Each spot records its state/province as an ISO 3166-2 code (`region`, e.g. `US-MI`, `US-OH`, `CA-ON`) from
  Overture divisions, next to the existing `country`. Spots JSON schema version bumps by one.
- Each metro has a home region (`se_mi` → `US-MI`, `bay_area` → `US-CA`), mirroring how `home_country` drives
  `crosses_border` today. A spot `crosses_state` when its region differs from the home region **and** it is in the
  home country (Canadian spots are already covered by the country filter).
- API: new query parameter `state_border=include|exclude` (default include) and response field `crosses_state` on each
  spot, alongside `crosses_border`. The pipeline is re-run for both metros and API data re-synced.

## 4. Welcome copy
Under the headline: **"We currently cover southeast Michigan and the SF Bay Area."**

## 5. High-resolution map
- **Source stays Overture** (not satellite imagery): Overture is the project's required data source and the base
  picture is its most visible use; a daytime satellite photo also fights the night/red-mode look. Glow stays VIIRS.
- **Levels (amended: "we don't need very high res, it just needs to not look blurry"):** each region's base picture
  (and its red variant) is rendered at two levels: level 0 = today's single picture (≤ 16 MP, with its ¼/½/full sizes);
  level 1 = 2× the resolution as a 2×2 grid of pictures (Michigan ≈ 50 m per pixel). Every grid picture ≤ 16 MP.
- Higher levels are rendered at the matching map zoom so more Overture detail appears (e.g. minor roads from z11).
- **Loading:** the app picks the lowest level that is sharp for the current framing and screen (image width × device
  pixel ratio), loads only the grid pictures that intersect the view, and keeps the lower level visible underneath
  until they arrive (never a blank or partial picture). It never steps down a level within the same region and mode.
  Red mode uses only red pictures at every level.
- **Glow is rendered per level too** (the user's main complaint: the night lights looked low-res). VIIRS resolves
  only ~450 m and no higher-resolution free night-lights data exists, so the goal is a smooth, crisp-looking glow, not
  invented detail: compute the darkness grid on a finer grid (≈ 200 m), serve it at the same sizes as the base
  with smooth (cubic) resampling of the VIIRS radiance, apply the same sky-glow model and color ramps, and cut it into
  the same grid as the base. Towns should read as soft-edged glows with no visible pixel blocks at any framing. Glow
  pictures may use near-lossless WebP to stay small; red glow is still pixel-checked. This replaces the earlier ruling
  that the glow always loads at the smallest width.
- **Manifest** gains the level/grid description; render, upload allow-list and the app follow it. R2 storage grows to
  a few hundred MB (well within the free tier); normal-mode downloads stay small because only visible pieces load.
- Registration rule unchanged: pins, labels and every grid picture line up within 2 px (Web Mercator).

## 6. Non-goals
Satellite imagery; panning/zooming; spots outside the two regions; route-based border crossing.

## 7. Left to the builder
Exact level sizes/zooms within the 16 MP rule; tile file naming; how the lower level is layered under the higher one;
switch styling; where the coverage line sits visually.

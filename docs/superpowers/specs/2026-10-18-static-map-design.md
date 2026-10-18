# Dark Sky Finder — Static Map Design

Amends `2026-10-17-dark-sky-web-design.md` (the web spec). Where they disagree, this document wins.

## 1. Why

The live map (MapLibre + PMTiles) didn't work the way it was meant to. Tiles loaded slowly or not at all, the user
had to pan and zoom to find anything, and the look kept fighting the data (coarse coastlines, borders through lakes,
blocky land cover). Nobody needs to drag the map. The user wants to know **where to go and how good it will be**,
and the map's job is to show that at a glance: their start, the spots around them, and how dark the sky is.

Success: after picking a start and a night, the user sees a sharp, good-looking picture of their area with the
light-pollution glow and the ranked spots on it, instantly and every time, on a phone or a desktop.

## 2. Goals, non-goals, anti-goals

**Goals**
- A high-resolution, pre-rendered picture of each region (Michigan's Lower Peninsula, SF Bay Area) with land,
  water, major roads, borders and readable town names, plus the light-pollution glow on top.
- The picture frames itself around the user's start and the spots in their results. No panning or zooming by hand.
- Spot pins on the picture, colored by sky quality; tapping a pin opens its card and opening a card highlights its pin.
- Loads fast and completely: a few images, no tile requests, no holes.
- Red mode: red-only picture, glow and pins.

**Non-goals**
- Panning, zooming, dragging the map; tap-to-set-start; the draggable start pin. The start comes only from
  search and "Use my location".
- A US-wide or zoomed-out overview. Glow appears on the user's regional picture only.
- Covering more area than the regional pictures. If the drive radius reaches past a picture's edge, the picture
  just shows its edge.
- Changing spots, search, forecasts or the API. Spots stay in southeast Michigan and the Bay Area.

**Anti-goals** (would be a failure even if it technically works)
- Blurry or pixelated imagery at the framings users actually see, or labels that become unreadable when the picture
  is scaled.
- Any white/blue light in red mode.
- Partially loaded pictures, or a picture that shows a different area than the pins.
- A page that is noticeably heavier on a phone than the live map was (see size budgets).

## 3. What the user sees

### 3.1 Welcome (no start)
Only the question and the picker: headline, search box, "Use my location", region chips. **No picture.** Region chips
no longer fly a map; they bias search to that region (or are removed — builder's choice, see §8). Out-of-coverage
locate keeps the existing coverage message.

### 3.2 Results
Layout unchanged from the web spec: phone = picture (~200 px tall) above the list, expandable to full screen;
desktop = left panel 400 px + picture filling the right side.

The picture:
- **Framing:** the visible area is the bounding box of the start and every spot currently in the list, padded so pins
  aren't on the edge, with a minimum span (≈ 25 km) so one nearby spot doesn't produce an extreme close-up. Every
  pin and the start are always inside the visible area (the API only accepts starts inside the spot area and only
  returns spots within the drive time, so the box is bounded). With no spots in the list, frame the start with a
  span matching the drive time (≈ drive minutes × 1.2 km each side). Wide framings (long drives) may look softer;
  that's accepted. *(Builder-check call.)* Framing
  updates when the start, drive time, filters or night change the list (eased transition; instant with reduced
  motion). The framing is clamped to the picture's extent; beyond an edge the background is the water color.
- **Pins:** start = fixed amber pin. Spots = pins colored by `sky_label` (same palette as today), Dark Sky places
  with a star ring, the selected spot enlarged. Pins are real buttons (keyboard and screen-reader reachable, named
  after the spot); tapping one opens its card and sets `spot=` in the URL, exactly as tapping a pin did before.
- **Glow toggle** stays (same `glow` URL setting). Glow is visible in red mode too, in red.
- **Expand to full screen** stays and shows the same framing larger.
- **Attribution** line on the picture: Overture Maps Foundation, © OpenStreetMap contributors, TomTom, ESA WorldCover,
  VIIRS VNL (EOG / Colorado School of Mines).

### 3.3 Red mode
Swaps in the red-rendered base picture and red glow; pins use the existing red pin colors. Nothing on screen may
have green or blue above half of red (the existing e2e red check), now including the picture itself.

## 4. How it gets made

### 4.1 Decided
- **Overture stays the source.** The base picture is rendered from the Overture basemap extracts the pipeline
  already produces (`pipeline/out/<metro>/basemap_<metro>_*.pmtiles`; Michigan covers the whole Lower Peninsula,
  `METROS["se_mi"].tiles_bbox`), using the current Moonlit style colors (land, water, parks, roads, borders as in
  the web spec §6, minus land cover, which is blocky).
- **Glow uses the same darkness model the spots use** (VIIRS + sky-glow convolution, `build_darkness_grid`, same
  constants), computed over the **picture's** extent (`tiles_bbox`, e.g. the whole Lower Peninsula) rather than the
  spot bbox, with the existing normal and red color ramps (`tiles.py` `_COLOR_STOPS` / `RED_STOPS`). Inside the
  spot area the picture and the spot darkness numbers agree; the rest of the picture has glow from the same model.
  The VIIRS file is global, so no new data is needed. *(Builder-check call.)*
- **Pictures are rendered ahead of time, per region, in four variants:** base, base-red, glow, glow-red. Base and
  glow are separate images so the glow toggle is instant. The red base may be a build-time recolor of the base
  (luminance → red) instead of a second render; either way the red images must contain no pixel with green or blue
  above half of red (checked by a script over the pixels, so lossy compression can't sneak color in). *(Builder-check
  call.)*
- **Labels are not baked into the base picture.** Town/city names are drawn by the app as crisp text over the
  picture from a small per-region label list (name + position + rank), so they stay readable at any framing. The
  list comes from Overture divisions (`division` points of locality subtype, ranked by `population` /
  `@prominence`) over the picture extent, made by a pipeline step; a short curated override list is fine if a few
  names need adding or removing. *(Builder-check call.)* Only names
  that land inside the current framing are shown, with simple collision avoidance.
- **No live map in the app:** MapLibre, PMTiles, the tile protocol, glyphs and the dev tile middleware go away.
- **Hosting on Cloudflare R2 (user's decision, "for now"):** the pictures and label lists live in the existing R2
  bucket under `maps/<metro>/`, not in git. The app keeps reading the base URL from `VITE_TILES_URL`; the R2 CORS
  file stays (label lists are fetched). The upload script is rewritten to upload only the `maps/` output (and refuse
  anything else); the old PMTiles/US uploads go away. Rendered pictures are git-ignored pipeline output.
- **Pictures are resized before being shown (user's decision):** each variant is generated at a few sizes (e.g. full,
  ½, ¼, as a fixed set), and the app downloads the smallest size that is still sharp for the current framing and the
  screen (visible picture area × device pixel ratio), upgrading to a larger size only when a tighter framing needs
  it. A phone never downloads the full-resolution picture for a wide view.
- **The US-wide map work is dropped:** US glow/borders/state-lines outputs, `darksky_pipeline.us_glow`, and the
  related upload/README steps. (They are in git history if ever wanted again.)
- **Start comes only from search and "Use my location".** Remove tap-to-start, the drag pin, and the mobile
  confirm toast.

### 4.2 Budgets and constraints
- Each image ≤ 16 megapixels decoded (mobile Safari limit). If a region needs more for sharpness, split it into a
  small fixed grid of images rather than exceed the limit.
- Download per region in normal mode (base + glow + labels) ≤ ~6 MB at the largest size; typical phone views far
  less thanks to the resized sizes. Red mode loads its own variants only when turned on. All sizes and variants for
  both regions fit comfortably in R2's free tier (≤ ~100 MB guide).
- Sharpness target: at the framing for a 90-minute drive on a 390 px wide phone at 2× pixel density, roads and
  coastlines look crisp (no visible pixel stepping). Framings tighter than that may soften slightly; that's accepted.
- Pin and label positions must line up with the picture to within a couple of pixels at every framing (same
  projection math for the image bounds, pins and labels: Web Mercator).
- Rendering is a repeatable command (documented in the README) that a developer runs after the pipeline; the app
  never renders maps at runtime.

- **Rendering tooling:** reuse what the repo already has. The base picture is rendered with the existing web
  Playwright/Chromium and MapLibre (dev-only; not shipped in the app) from the local PMTiles extracts, with no labels
  so no glyphs are needed. The glow images are written by the Python pipeline from the darkness grid. Must run on
  the developer's Windows machine. *(Builder-check call.)*
- **Tests** use small fixture pictures and label lists served by the dev server (the real pictures are not in git).
  *(Builder-check call.)*

### 4.3 Left to the builder
- The exact base-picture render recipe (viewport tiling, zoom, device scale) and image format (WebP/AVIF/PNG),
  within the budgets above.
- The exact resolution, and whether to split a region into a grid.
- The label set (e.g. localities above a population or prominence threshold, plus county seats) and label styling,
  following the existing label colors.
- Framing details (padding, easing, minimum span) within §3.2.
- What the region chips do on Welcome now that there's no map to fly (bias search, or remove them).

## 5. Effects on existing work
- The current uncommitted changes on `master` (More filters, sky preview, red-mode glow, map fixes, Lower Peninsula
  tiles, Michigan rename) are committed first as a checkpoint on a feature branch; this redesign builds on top.
- Kept: everything outside the map (cards, verdict, night picker, controls, More filters, sky preview, states, red
  mode, URL state, API). The Michigan display name and "southeast Michigan" coverage copy stay.
- Tests: map unit tests are replaced with tests for the projection/framing math, pin rendering and interactions; the
  e2e flow drops tile assertions, asserts the pictures and labels load with no console errors, that pins open cards,
  and that red mode uses the red variants. Visual baselines no longer need the map masked (pictures are static).

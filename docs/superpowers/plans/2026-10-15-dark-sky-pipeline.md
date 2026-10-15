# Dark Sky Finder — Plan 1: Data Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An offline Python pipeline that turns a pinned Overture release plus a VIIRS night-lights GeoTIFF into per-metro data files (`spots_<metro>.json`, `darkness_<metro>.npz`, `search_<metro>.sqlite`, light-pollution and basemap PMTiles) for SE Michigan and the SF Bay Area.

**Architecture:** DuckDB reads Overture GeoParquet (S3 or a local fixture tree) clipped to a metro bbox and caches it locally. Pure-Python modules (shapely 2, numpy, scipy, rasterio, pyproj) compute a sky-glow SQM grid, candidate spots, darkest-reachable viewing points, glare, horizon, access and amenities, then write JSON/NPZ/SQLite outputs. A CLI orchestrates one metro per run; sanity checks gate the output.

**Tech Stack:** Python 3.11+, DuckDB ≥1.1 (spatial + httpfs), shapely ≥2.0, pyproj, numpy, scipy, rasterio, pandas, pyarrow, PyYAML, pytest; external CLIs `pmtiles` (go-pmtiles) and `rio pmtiles` (rio-pmtiles) for tiles.

**Spec:** `docs/superpowers/specs/2026-10-15-dark-sky-finder-design.md` (sections 4, 4.1, 5, 8 are what this plan implements). Plans 2 (API) and 3 (frontend + deploy) consume this plan's outputs.

## Global Constraints

- All map-derived features come from Overture; non-Overture inputs only: VIIRS (brightness). Weather, sky timing and routing are API concerns (Plan 2).
- Overture release is pinned per run (`--release`), never "latest" implicitly.
- Metros: `se_mi` bbox `(-84.6, 41.65, -82.4, 44.1)`, `bay_area` bbox `(-123.2, 36.4, -121.0, 38.6)` (west, south, east, north, EPSG:4326).
- Output file names exactly: `spots_<metro>.json`, `darkness_<metro>.npz`, `search_<metro>.sqlite`, `lightpollution_<metro>.pmtiles`, `basemap_<metro>_<theme>.pmtiles`.
- Darkness grid: 500 m cells; sky glow = VIIRS radiance convolved with a d^-2.5 kernel, 50 km radius, computed on a grid padded by 50 km beyond the bbox.
- Sky labels exactly: `Milky Way vivid` / `Milky Way visible` / `Milky Way faint` / `Milky Way not visible`.
- Access badges exactly: `verified` / `likely` / `check_hours`.
- Spot identity = Overture GERS ID (`id` column); curated YAML is keyed by GERS ID.
- Curated `unavailable: true` spots stay in the output with `unavailable: true` and a reason (spec §3.3, §7).
- JSON output must never contain NaN/Infinity.
- All commands below run from the `pipeline/` directory. On Windows use `.venv/Scripts/python`; on macOS/Linux `.venv/bin/python`.

## Review Focus

1. **Bright lights just outside the region** — a city 5 km past the bbox edge must still brighten the edge of the grid (padding). Test: Task 4 `test_edge_glow_from_outside_region`.
2. **VIIRS nodata and negative radiance values** — must become "no light", never NaN in the grid or a crash. Test: Task 4 `test_grid_is_finite_despite_bad_values`.
3. **Parks reachable only by private or foot roads** — must be dropped, not shipped with fake access. Test: Task 7 `test_no_viewing_point_without_drivable_road`, Task 13 golden test.
4. **Very large parks with thousands of road samples** — sampling must be capped so the run stays fast. Test: Task 7 `test_sample_points_are_capped`.
5. **Search text with apostrophes, quotes, unicode or only punctuation** — must not raise FTS5 syntax errors. Test: Task 11 `test_query_handles_punctuation`.

---

## File Structure

```
pipeline/
  pyproject.toml
  README.md                         # how to run (Task 13)
  curated/
    se_mi.yaml                      # curated spots, filled in Task 14
    bay_area.yaml
  darksky_pipeline/
    __init__.py
    config.py                       # metros + every tunable constant
    util.py                         # as_list, wkb decoding
    geo.py                          # Projector (EPSG:4326 <-> UTM)
    extract.py                      # DuckDB Overture extraction + cache
    probe.py                        # CLI: releases, categories, find, sky
    darkness.py                     # VIIRS -> sky-glow SQM grid, labels
    curated.py                      # curated YAML loader
    spots.py                        # candidate spots (places + park polygons)
    roads.py                        # road network, access, viewing point
    features.py                     # glare + horizon
    amenities.py                    # nearby restroom/fuel/food
    assemble.py                     # spot dicts, why-chips, JSON writer
    checks.py                       # sanity checks
    search_index.py                 # SQLite FTS5 search index
    tiles.py                        # basemap + light-pollution PMTiles
    build.py                        # orchestration CLI
  tests/
    conftest.py
    overture_fixture.py             # fake Overture release on disk
    viirs_fixture.py                # fake VIIRS GeoTIFF
    test_config.py  test_geo.py  test_extract.py  test_probe.py
    test_darkness.py  test_curated.py  test_spots.py  test_roads.py
    test_features.py  test_amenities.py  test_assemble.py  test_checks.py
    test_search_index.py  test_tiles.py  test_build.py
```

---

### Task 1: Package scaffold and configuration

**Files:**
- Create: `pipeline/pyproject.toml`, `pipeline/darksky_pipeline/__init__.py`, `pipeline/darksky_pipeline/config.py`, `pipeline/darksky_pipeline/util.py`, `pipeline/tests/test_config.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `config.Metro` (frozen dataclass: `key, name, bbox, utm_epsg, reference_home, reference_home_label`), `config.METROS: dict[str, Metro]`, `config.BBox`, all constants below; `util.as_list(value) -> list`, `util.wkb_to_geoms(series) -> np.ndarray[object]`.

- [ ] **Step 1: Write `pipeline/pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "darksky-pipeline"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "duckdb>=1.1",
  "shapely>=2.0",
  "pyproj>=3.6",
  "numpy>=1.26",
  "scipy>=1.11",
  "rasterio>=1.3",
  "pandas>=2.1",
  "pyarrow>=15",
  "pyyaml>=6",
]

[project.optional-dependencies]
dev = ["pytest>=8"]
tiles = ["rio-pmtiles>=1.0"]

[tool.setuptools.packages.find]
include = ["darksky_pipeline*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Append to repo-root `.gitignore`**

```
pipeline/.venv/
pipeline/data/
pipeline/out/
__pycache__/
*.egg-info/
.pytest_cache/
```

- [ ] **Step 3: Create venv and install**

Run: `cd pipeline && python -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"`
Expected: installs without errors.

- [ ] **Step 4: Write the failing test `pipeline/tests/test_config.py`**

```python
import math

import numpy as np
import pandas as pd
import shapely

from darksky_pipeline import config
from darksky_pipeline.util import as_list, wkb_to_geoms


def test_metro_bboxes_are_valid_and_contain_home():
    for metro in config.METROS.values():
        w, s, e, n = metro.bbox
        assert w < e and s < n
        lon, lat = metro.reference_home
        assert w < lon < e and s < lat < n
        assert metro.utm_epsg in (32610, 32617)


def test_sky_label_thresholds_descend():
    thresholds = [t for t, _ in config.SKY_LABELS]
    assert thresholds == sorted(thresholds, reverse=True)
    assert thresholds[-1] == -math.inf
    labels = [label for _, label in config.SKY_LABELS]
    assert labels == ["Milky Way vivid", "Milky Way visible", "Milky Way faint", "Milky Way not visible"]


def test_bortle_thresholds_descend():
    thresholds = [t for t, _ in config.BORTLE_THRESHOLDS]
    assert thresholds == sorted(thresholds, reverse=True)


def test_as_list_handles_none_nan_arrays_and_lists():
    assert as_list(None) == []
    assert as_list(float("nan")) == []
    assert as_list([{"a": 1}]) == [{"a": 1}]
    assert as_list(np.array([{"a": 1}], dtype=object)) == [{"a": 1}]


def test_wkb_to_geoms_accepts_bytearray():
    wkb = shapely.to_wkb(shapely.Point(1, 2))
    geoms = wkb_to_geoms(pd.Series([bytearray(wkb), wkb]))
    assert [g.x for g in geoms] == [1.0, 1.0]
```

- [ ] **Step 5: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline'` (or `config`).

- [ ] **Step 6: Write `pipeline/darksky_pipeline/__init__.py`**

```python
"""Dark Sky Finder offline data pipeline."""
```

- [ ] **Step 7: Write `pipeline/darksky_pipeline/config.py`**

```python
"""Static configuration for the Dark Sky Finder pipeline.

Every tunable number lives here so calibration never touches logic.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

BBox = tuple[float, float, float, float]  # west, south, east, north (EPSG:4326)


@dataclass(frozen=True)
class Metro:
    key: str
    name: str
    bbox: BBox
    utm_epsg: int
    reference_home: tuple[float, float]  # lon, lat of a typical bright home location
    reference_home_label: str


METROS: dict[str, Metro] = {
    "se_mi": Metro("se_mi", "SE Michigan", (-84.6, 41.65, -82.4, 44.1), 32617,
                   (-83.1446, 42.4895), "Royal Oak"),
    "bay_area": Metro("bay_area", "SF Bay Area", (-123.2, 36.4, -121.0, 38.6), 32610,
                      (-122.4194, 37.7749), "San Francisco"),
}

OVERTURE_S3_ROOT = "s3://overturemaps-us-west-2/release"

# --- Places -----------------------------------------------------------------
# Category names follow the Overture places taxonomy; verify with
# `python -m darksky_pipeline.probe categories` (Task 14) and adjust here.
MIN_PLACE_CONFIDENCE = 0.6
SPOT_CATEGORIES = frozenset({
    "park", "state_park", "national_park", "campground", "beach",
    "observatory", "nature_reserve", "scenic_viewpoint", "boat_launch",
})
LIKELY_CATEGORIES = frozenset({"campground", "observatory", "boat_launch"})
PARKING_CATEGORIES = frozenset({"parking", "parking_lot"})
AMENITY_CATEGORIES: dict[str, frozenset[str]] = {
    "restroom": frozenset({"public_toilet", "restroom"}),
    "fuel": frozenset({"gas_station"}),
    "food": frozenset({"restaurant", "fast_food_restaurant", "cafe", "coffee_shop", "diner"}),
}
AMENITY_RADIUS_M = 5_000

# --- Land use -----------------------------------------------------------------
PARK_SUBTYPES = frozenset({"park", "protected", "recreation"})
MIN_PARK_AREA_M2 = 20_000
PLACE_ONLY_RADIUS_M = 500  # search area for a spot place with no park polygon

# --- Roads --------------------------------------------------------------------
DRIVABLE_CLASSES = frozenset({
    "motorway", "trunk", "primary", "secondary", "tertiary", "residential",
    "living_street", "unclassified", "service", "track",
})
UNPAVED_CLASSES = frozenset({"track"})
HIGHWAY_CLASSES = frozenset({"motorway", "trunk"})
ACCESS_SEARCH_M = 300
ROAD_SAMPLE_STEP_M = 100
MAX_VIEWING_CANDIDATES = 2_000

# --- Darkness -----------------------------------------------------------------
GRID_RES_M = 500
SKYGLOW_RADIUS_M = 50_000
SKYGLOW_EXPONENT = 2.5
NATURAL_SQM = 22.0
SKYGLOW_K = 0.5  # nW/cm2/sr of weighted radiance that doubles natural sky brightness; calibrated in Task 14
DARKNESS_TIE_MAG = 0.1
SKY_LABELS: tuple[tuple[float, str], ...] = (
    (21.3, "Milky Way vivid"),
    (20.4, "Milky Way visible"),
    (19.5, "Milky Way faint"),
    (-math.inf, "Milky Way not visible"),
)
BORTLE_THRESHOLDS: tuple[tuple[float, int], ...] = (
    (21.99, 1), (21.89, 2), (21.69, 3), (20.49, 4),
    (19.50, 5), (18.94, 6), (18.38, 7), (-math.inf, 8),
)

# --- Glare --------------------------------------------------------------------
GLARE_RADIUS_M = 1_000
GLARE_BUILDINGS_SATURATION = 400
GLARE_BUILDING_WEIGHT = 0.7
HIGHWAY_NEAR_M = 1_000
HIGHWAY_MID_M = 3_000
HIGHWAY_NEAR_PENALTY = 0.3
HIGHWAY_MID_PENALTY = 0.15
LOW_GLARE_MAX = 0.2

# --- Horizon ------------------------------------------------------------------
HORIZON_RADIUS_M = 1_000
OPEN_COVER_SUBTYPES = frozenset({"grass", "crop", "shrub", "barren", "wetland", "moss", "snow"})
CLOSED_COVER_SUBTYPES = frozenset({"forest", "mangrove"})
HORIZON_OPEN_MIN = 0.5
HORIZON_CLOSED_MAX_FOR_OPEN = 0.3
HORIZON_ENCLOSED_MIN = 0.5
LAKE_CHIP_MIN_WATER = 0.2

# --- Checks -------------------------------------------------------------------
SPOT_COUNT_RANGE: dict[str, tuple[int, int]] = {"se_mi": (50, 5_000), "bay_area": (50, 5_000)}
TOP_SPOTS_MIN_MEDIAN_SQM = 20.5
VERIFIED_MIN_GAIN_MAG = 1.0
```

- [ ] **Step 8: Write `pipeline/darksky_pipeline/util.py`**

```python
"""Small helpers shared across pipeline modules."""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import shapely


def as_list(value: Any) -> list:
    """Normalize Overture nested-list values (None, NaN, list, ndarray) to a list."""
    if value is None:
        return []
    if isinstance(value, float) and np.isnan(value):
        return []
    if isinstance(value, np.ndarray):
        return list(value)
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


def wkb_to_geoms(series: pd.Series) -> np.ndarray:
    """Decode a WKB column (bytes or bytearray) into a shapely geometry array."""
    return shapely.from_wkb(np.array([bytes(b) for b in series], dtype=object))
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_config.py -v`
Expected: 5 passed.

- [ ] **Step 10: Commit**

```bash
git add .gitignore pipeline/pyproject.toml pipeline/darksky_pipeline pipeline/tests/test_config.py
git commit -m "feat(pipeline): scaffold package and configuration"
```

---

### Task 2: Projection helper

**Files:**
- Create: `pipeline/darksky_pipeline/geo.py`, `pipeline/tests/test_geo.py`

**Interfaces:**
- Produces: `geo.Projector(epsg: int)` with `.epsg`, `.to_xy(lon, lat) -> (x, y)`, `.to_lonlat(x, y) -> (lon, lat)` (scalars or numpy arrays), `.geoms_to_xy(geoms: np.ndarray) -> np.ndarray` (lon/lat shapely geoms → metres), `.bbox_xy(bbox) -> (minx, miny, maxx, maxy)`, `.bbox_lonlat(xy_bbox) -> (west, south, east, north)`.

- [ ] **Step 1: Write the failing test `pipeline/tests/test_geo.py`**

```python
import numpy as np
import shapely

from darksky_pipeline.geo import Projector


def test_round_trip_detroit():
    p = Projector(32617)
    x, y = p.to_xy(-83.0458, 42.3314)
    lon, lat = p.to_lonlat(x, y)
    assert abs(lon + 83.0458) < 1e-7 and abs(lat - 42.3314) < 1e-7


def test_distances_are_metres():
    p = Projector(32617)
    x1, y1 = p.to_xy(-83.0, 42.0)
    x2, y2 = p.to_xy(-83.0, 42.01)
    assert abs(np.hypot(x2 - x1, y2 - y1) - 1111) < 5


def test_geoms_to_xy_projects_arrays():
    p = Projector(32617)
    geoms = np.array([shapely.Point(-83.0, 42.0), shapely.LineString([(-83.0, 42.0), (-83.0, 42.01)])], dtype=object)
    out = p.geoms_to_xy(geoms)
    assert abs(out[1].length - 1111) < 5
    assert abs(out[0].x - p.to_xy(-83.0, 42.0)[0]) < 1e-6


def test_bbox_xy_contains_all_corners_and_round_trips():
    p = Projector(32617)
    bbox = (-84.6, 41.65, -82.4, 44.1)
    minx, miny, maxx, maxy = p.bbox_xy(bbox)
    for lon in (bbox[0], bbox[2]):
        for lat in (bbox[1], bbox[3]):
            x, y = p.to_xy(lon, lat)
            assert minx <= x <= maxx and miny <= y <= maxy
    w, s, e, n = p.bbox_lonlat((minx, miny, maxx, maxy))
    assert w <= bbox[0] and s <= bbox[1] and e >= bbox[2] and n >= bbox[3]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_geo.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.geo'`.

- [ ] **Step 3: Write `pipeline/darksky_pipeline/geo.py`**

```python
"""Projection between EPSG:4326 and a metro's UTM zone (metres)."""
from __future__ import annotations

import numpy as np
import shapely
from pyproj import Transformer


class Projector:
    def __init__(self, epsg: int) -> None:
        self.epsg = epsg
        self._fwd = Transformer.from_crs(4326, epsg, always_xy=True)
        self._inv = Transformer.from_crs(epsg, 4326, always_xy=True)

    def to_xy(self, lon, lat):
        return self._fwd.transform(lon, lat)

    def to_lonlat(self, x, y):
        return self._inv.transform(x, y)

    def geoms_to_xy(self, geoms: np.ndarray) -> np.ndarray:
        def fn(coords: np.ndarray) -> np.ndarray:
            x, y = self._fwd.transform(coords[:, 0], coords[:, 1])
            return np.column_stack([x, y])

        return shapely.transform(np.asarray(geoms, dtype=object), fn)

    @staticmethod
    def _edges(a0: float, b0: float, a1: float, b1: float) -> tuple[np.ndarray, np.ndarray]:
        t = np.linspace(0.0, 1.0, 21)
        xs = np.concatenate([a0 + (a1 - a0) * t, np.full(21, a1), a0 + (a1 - a0) * t, np.full(21, a0)])
        ys = np.concatenate([np.full(21, b0), b0 + (b1 - b0) * t, np.full(21, b1), b0 + (b1 - b0) * t])
        return xs, ys

    def bbox_xy(self, bbox) -> tuple[float, float, float, float]:
        w, s, e, n = bbox
        lons, lats = self._edges(w, s, e, n)
        x, y = self.to_xy(lons, lats)
        return float(np.min(x)), float(np.min(y)), float(np.max(x)), float(np.max(y))

    def bbox_lonlat(self, xy_bbox) -> tuple[float, float, float, float]:
        minx, miny, maxx, maxy = xy_bbox
        xs, ys = self._edges(minx, miny, maxx, maxy)
        lon, lat = self.to_lonlat(xs, ys)
        return float(np.min(lon)), float(np.min(lat)), float(np.max(lon)), float(np.max(lat))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_geo.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/darksky_pipeline/geo.py pipeline/tests/test_geo.py
git commit -m "feat(pipeline): add UTM projector"
```

---

### Task 3: Overture extraction, test fixture, and probe CLI

**Files:**
- Create: `pipeline/darksky_pipeline/extract.py`, `pipeline/darksky_pipeline/probe.py`, `pipeline/tests/overture_fixture.py`, `pipeline/tests/conftest.py`, `pipeline/tests/test_extract.py`, `pipeline/tests/test_probe.py`

**Interfaces:**
- Consumes: `config.OVERTURE_S3_ROOT`, `config.BBox`, `util.wkb_to_geoms`.
- Produces:
  - `extract.THEMES: dict[str, ThemeSpec]` with keys `places, land_use, land_cover, water, buildings, segments, addresses, division_areas`.
  - `extract.connect() -> duckdb.DuckDBPyConnection`
  - `extract.extract_theme(con, key, bbox, release, source_root=OVERTURE_S3_ROOT, cache_dir=None) -> pd.DataFrame`. Columns per theme:
    - `places`: `id, name, category, confidence, lon, lat`
    - `land_use`: `id, name, subtype, class, wkb`
    - `land_cover`: `id, subtype, wkb`
    - `water`: `id, subtype, class, wkb`
    - `buildings`: `id, lon, lat` (centroid)
    - `segments`: `id, subtype, class, road_surface, access_restrictions, wkb`
    - `addresses`: `id, number, street, postcode, address_levels, lon, lat`
    - `division_areas`: `id, name, subtype, country, region, wkb`
  - `probe.place_categories(places, keywords) -> pd.DataFrame[category, count]`, `probe.find_by_name(places, land_use, text) -> pd.DataFrame[id, name, kind, category, lon, lat]`, `probe.list_releases(con, root) -> list[str]`, `probe.main(argv)`.
  - Test fixtures (conftest): `overture_root` (Path), `overture_frames` (dict[str, DataFrame]); fixture constants in `tests/overture_fixture.py`: `RELEASE, REGION_BBOX, CITY, HUDSON, TEST_EPSG`.

- [ ] **Step 1: Write the fake Overture release builder `pipeline/tests/overture_fixture.py`**

```python
"""Builds a tiny fake Overture release (GeoParquet via DuckDB) for tests.

Layout mirrors S3: <root>/<release>/theme=<theme>/type=<type>/part-0.parquet
"""
from __future__ import annotations

from pathlib import Path

import duckdb

RELEASE = "2099-01-01.0"
REGION_BBOX = (-84.40, 41.75, -84.00, 42.05)
TEST_EPSG = 32617
CITY = (-84.05, 42.00)
HUDSON = (-84.25, 41.83)

PLACES = [
    # id, name, category, confidence, lon, lat
    ("pl_hudson", "Lake Hudson Recreation Area", "park", 0.95, -84.25, 41.83),
    ("pl_hudson_launch", "Lake Hudson Boat Launch", "boat_launch", 0.80, -84.24, 41.82),
    ("pl_city", "Downtown Park", "park", 0.90, -84.05, 42.00),
    ("pl_camp", "Pine Campground", "campground", 0.90, -84.15, 41.78),
    ("pl_noname", None, "park", 0.90, -84.10, 41.80),
    ("pl_lowconf", "Sketchy Park", "park", 0.30, -84.12, 41.90),
    ("pl_cafe", "Moon Cafe", "restaurant", 0.90, -84.20, 41.84),
    ("pl_gas", "Hudson Fuel", "gas_station", 0.90, -84.26, 41.86),
    ("pl_lot", "Hudson Lot", "parking", 0.90, -84.27, 41.815),
    ("pl_out", "Far Away Park", "park", 0.90, -86.00, 43.00),
]

LAND_USE = [
    # id, name, subtype, class, wkt
    ("lu_hudson", "Lake Hudson Recreation Area", "recreation", "recreation_area",
     "POLYGON((-84.28 41.81, -84.22 41.81, -84.22 41.85, -84.28 41.85, -84.28 41.81))"),
    ("lu_city", "Downtown Park", "park", "park",
     "POLYGON((-84.06 41.99, -84.04 41.99, -84.04 42.01, -84.06 42.01, -84.06 41.99))"),
    ("lu_woods", "Hidden Woods Preserve", "protected", "nature_reserve",
     "POLYGON((-84.35 41.95, -84.33 41.95, -84.33 41.97, -84.35 41.97, -84.35 41.95))"),
    ("lu_tiny", None, "park", "park",
     "POLYGON((-84.300 41.900, -84.299 41.900, -84.299 41.901, -84.300 41.901, -84.300 41.900))"),
    ("lu_out", "Far Away Forest", "protected", "forest",
     "POLYGON((-86.1 43.0, -86.0 43.0, -86.0 43.1, -86.1 43.1, -86.1 43.0))"),
]

LAND_COVER = [
    ("lc_grass", "grass", "POLYGON((-84.32 41.80, -84.18 41.80, -84.18 41.87, -84.32 41.87, -84.32 41.80))"),
    ("lc_forest", "forest", "POLYGON((-84.17 41.77, -84.13 41.77, -84.13 41.79, -84.17 41.79, -84.17 41.77))"),
]

WATER = [
    ("w_lake", "lake", "lake",
     "POLYGON((-84.255 41.825, -84.235 41.825, -84.235 41.84, -84.255 41.84, -84.255 41.825))"),
]

SEGMENTS = [
    # id, subtype, class, surface, access_type, wkt
    ("rd_hudson", "road", "tertiary", "paved", None, "LINESTRING(-84.30 41.83, -84.20 41.83)"),
    ("rd_city", "road", "residential", "paved", None, "LINESTRING(-84.07 42.00, -84.03 42.00)"),
    ("rd_camp", "road", "track", "unpaved", None, "LINESTRING(-84.16 41.78, -84.14 41.78)"),
    ("rd_highway", "road", "motorway", "paved", None, "LINESTRING(-84.10 41.75, -84.10 42.05)"),
    ("rd_footway", "road", "footway", "paved", None, "LINESTRING(-84.34 41.955, -84.34 41.965)"),
    ("rd_private", "road", "service", None, "denied", "LINESTRING(-84.345 41.96, -84.335 41.96)"),
]

ADDRESSES = [
    # id, number, street, postcode, locality, lon, lat
    ("ad_1", "101", "Main St", "49999", "Testville", -84.051, 42.001),
    ("ad_2", "7", "Lakeview Rd", "49998", "Hudson Township", -84.25, 41.86),
]

DIVISION_AREAS = [
    ("div_testville", "Testville", "locality", "US", "US-MI",
     "POLYGON((-84.08 41.98, -84.02 41.98, -84.02 42.02, -84.08 42.02, -84.08 41.98))"),
]


def _q(s: str | None) -> str:
    return "NULL::VARCHAR" if s is None else "'" + s.replace("'", "''") + "'"


def _with_bbox(inner: str) -> str:
    return (
        "SELECT *, {'xmin': ST_XMin(geometry), 'xmax': ST_XMax(geometry), "
        "'ymin': ST_YMin(geometry), 'ymax': ST_YMax(geometry)} AS bbox FROM (" + inner + ")"
    )


def _write(con: duckdb.DuckDBPyConnection, root: Path, theme: str, type_: str, inner: str) -> None:
    d = root / RELEASE / f"theme={theme}" / f"type={type_}"
    d.mkdir(parents=True, exist_ok=True)
    out = (d / "part-0.parquet").as_posix()
    con.execute(f"COPY ({_with_bbox(inner)}) TO '{out}' (FORMAT parquet)")


def build_overture_fixture(root: Path) -> None:
    con = duckdb.connect()
    con.install_extension("spatial")
    con.load_extension("spatial")

    _write(con, root, "places", "place", " UNION ALL ".join(
        f"SELECT '{i}' AS id, {{'primary': {_q(n)}}} AS names, {{'primary': '{c}'}} AS categories, "
        f"{conf}::DOUBLE AS confidence, ST_Point({lon}, {lat}) AS geometry"
        for i, n, c, conf, lon, lat in PLACES))

    _write(con, root, "base", "land_use", " UNION ALL ".join(
        f"SELECT '{i}' AS id, {{'primary': {_q(n)}}} AS names, '{st}' AS subtype, '{cl}' AS class, "
        f"ST_GeomFromText('{wkt}') AS geometry"
        for i, n, st, cl, wkt in LAND_USE))

    _write(con, root, "base", "land_cover", " UNION ALL ".join(
        f"SELECT '{i}' AS id, '{st}' AS subtype, ST_GeomFromText('{wkt}') AS geometry"
        for i, st, wkt in LAND_COVER))

    _write(con, root, "base", "water", " UNION ALL ".join(
        f"SELECT '{i}' AS id, '{st}' AS subtype, '{cl}' AS class, ST_GeomFromText('{wkt}') AS geometry"
        for i, st, cl, wkt in WATER))

    def surface_sql(v: str | None) -> str:
        return f"[{{'value': '{v}'}}]::STRUCT(value VARCHAR)[]" if v else "NULL::STRUCT(value VARCHAR)[]"

    def access_sql(v: str | None) -> str:
        return (f"[{{'access_type': '{v}'}}]::STRUCT(access_type VARCHAR)[]" if v
                else "NULL::STRUCT(access_type VARCHAR)[]")

    _write(con, root, "transportation", "segment", " UNION ALL ".join(
        f"SELECT '{i}' AS id, '{st}' AS subtype, '{cl}' AS class, {surface_sql(sf)} AS road_surface, "
        f"{access_sql(ac)} AS access_restrictions, ST_GeomFromText('{wkt}') AS geometry"
        for i, st, cl, sf, ac, wkt in SEGMENTS))

    _write(con, root, "buildings", "building",
           "SELECT 'b_city_' || i AS id, "
           "ST_Point(-84.055 + (i % 25) * 0.0004, 41.995 + (i // 25) * 0.0005) AS geometry FROM range(500) r(i) "
           "UNION ALL "
           "SELECT 'b_rural_' || i AS id, ST_Point(-84.252 + i * 0.001, 41.835) AS geometry FROM range(5) r(i)")

    _write(con, root, "addresses", "address", " UNION ALL ".join(
        f"SELECT '{i}' AS id, '{num}' AS number, '{st}' AS street, '{pc}' AS postcode, "
        f"[{{'value': 'MI'}}, {{'value': '{loc}'}}]::STRUCT(value VARCHAR)[] AS address_levels, "
        f"ST_Point({lon}, {lat}) AS geometry"
        for i, num, st, pc, loc, lon, lat in ADDRESSES))

    _write(con, root, "divisions", "division_area", " UNION ALL ".join(
        f"SELECT '{i}' AS id, {{'primary': {_q(n)}}} AS names, '{st}' AS subtype, '{c}' AS country, "
        f"'{r}' AS region, ST_GeomFromText('{wkt}') AS geometry"
        for i, n, st, c, r, wkt in DIVISION_AREAS))
    con.close()
```

- [ ] **Step 2: Write `pipeline/tests/conftest.py`**

```python
from __future__ import annotations

import pytest

from overture_fixture import REGION_BBOX, RELEASE, build_overture_fixture


@pytest.fixture(scope="session")
def overture_root(tmp_path_factory):
    root = tmp_path_factory.mktemp("overture")
    build_overture_fixture(root)
    return root


@pytest.fixture(scope="session")
def overture_frames(overture_root):
    from darksky_pipeline.extract import THEMES, connect, extract_theme

    con = connect()
    frames = {k: extract_theme(con, k, REGION_BBOX, RELEASE, source_root=overture_root.as_posix())
              for k in THEMES}
    con.close()
    return frames
```

Add `pipeline/tests/__init__.py`? **No** — keep `tests/` a plain directory so `overture_fixture` imports as a top-level module (pytest's rootdir-relative `rootdir/tests` is on `sys.path` in the default "prepend" import mode).

- [ ] **Step 3: Write the failing test `pipeline/tests/test_extract.py`**

```python
import shapely

from darksky_pipeline.extract import THEMES, build_query, extract_theme, theme_glob, connect
from darksky_pipeline.util import wkb_to_geoms
from overture_fixture import REGION_BBOX, RELEASE


def test_places_filtered_to_bbox_with_expected_columns(overture_frames):
    places = overture_frames["places"]
    assert list(places.columns) == ["id", "name", "category", "confidence", "lon", "lat"]
    assert "pl_out" not in set(places["id"])
    assert len(places) == 9
    hudson = places.set_index("id").loc["pl_hudson"]
    assert hudson["name"] == "Lake Hudson Recreation Area"
    assert abs(hudson["lon"] + 84.25) < 1e-9


def test_land_use_returns_polygons(overture_frames):
    lu = overture_frames["land_use"]
    assert set(lu["id"]) == {"lu_hudson", "lu_city", "lu_woods", "lu_tiny"}
    geoms = wkb_to_geoms(lu["wkb"])
    assert all(g.geom_type == "Polygon" for g in geoms)


def test_buildings_are_centroids(overture_frames):
    b = overture_frames["buildings"]
    assert list(b.columns) == ["id", "lon", "lat"]
    assert len(b) == 505


def test_segments_keep_nested_columns(overture_frames):
    seg = overture_frames["segments"].set_index("id")
    assert seg.loc["rd_hudson", "road_surface"][0]["value"] == "paved"
    assert seg.loc["rd_private", "access_restrictions"][0]["access_type"] == "denied"


def test_cache_round_trip(overture_root, tmp_path):
    con = connect()
    first = extract_theme(con, "places", REGION_BBOX, RELEASE,
                          source_root=overture_root.as_posix(), cache_dir=tmp_path)
    assert (tmp_path / "places.parquet").exists()
    again = extract_theme(con, "places", REGION_BBOX, RELEASE,
                          source_root="does/not/exist", cache_dir=tmp_path)
    assert sorted(again["id"]) == sorted(first["id"])


def test_query_uses_bbox_intersection_filter():
    sql = build_query(theme_glob("s3://x", "R", THEMES["places"]), THEMES["places"], (-1.0, -2.0, 3.0, 4.0))
    assert "bbox.xmax >= -1.0" in sql and "bbox.xmin <= 3.0" in sql
    assert "bbox.ymax >= -2.0" in sql and "bbox.ymin <= 4.0" in sql
```

- [ ] **Step 4: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_extract.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.extract'`. (First run downloads DuckDB's `spatial` extension; needs internet once.)

- [ ] **Step 5: Write `pipeline/darksky_pipeline/extract.py`**

```python
"""Extract Overture themes clipped to a bbox, via DuckDB, with a local parquet cache."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import duckdb
import pandas as pd

from .config import OVERTURE_S3_ROOT, BBox


@dataclass(frozen=True)
class ThemeSpec:
    theme: str
    type: str
    columns: str
    geometry: str  # "wkb" -> wkb column; "point" -> lon/lat of centroid


THEMES: dict[str, ThemeSpec] = {
    "places": ThemeSpec("places", "place",
                        "id, names.primary AS name, categories.primary AS category, confidence", "point"),
    "land_use": ThemeSpec("base", "land_use", "id, names.primary AS name, subtype, class", "wkb"),
    "land_cover": ThemeSpec("base", "land_cover", "id, subtype", "wkb"),
    "water": ThemeSpec("base", "water", "id, subtype, class", "wkb"),
    "buildings": ThemeSpec("buildings", "building", "id", "point"),
    "segments": ThemeSpec("transportation", "segment",
                          "id, subtype, class, road_surface, access_restrictions", "wkb"),
    "addresses": ThemeSpec("addresses", "address", "id, number, street, postcode, address_levels", "point"),
    "division_areas": ThemeSpec("divisions", "division_area",
                                "id, names.primary AS name, subtype, country, region", "wkb"),
}


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for ext in ("spatial", "httpfs"):
        con.install_extension(ext)
        con.load_extension(ext)
    con.execute("SET s3_region='us-west-2'")
    return con


def theme_glob(source_root: str, release: str, spec: ThemeSpec) -> str:
    return f"{source_root.rstrip('/')}/{release}/theme={spec.theme}/type={spec.type}/*"


def build_query(glob: str, spec: ThemeSpec, bbox: BBox) -> str:
    w, s, e, n = (float(v) for v in bbox)
    geom = ("ST_AsWKB(geometry) AS wkb" if spec.geometry == "wkb"
            else "ST_X(ST_Centroid(geometry)) AS lon, ST_Y(ST_Centroid(geometry)) AS lat")
    return (
        f"SELECT {spec.columns}, {geom} "
        f"FROM read_parquet('{glob}', hive_partitioning=false) "
        f"WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}"
    )


def extract_theme(con: duckdb.DuckDBPyConnection, key: str, bbox: BBox, release: str,
                  source_root: str = OVERTURE_S3_ROOT, cache_dir: Path | None = None) -> pd.DataFrame:
    spec = THEMES[key]
    cache = Path(cache_dir) / f"{key}.parquet" if cache_dir is not None else None
    if cache is not None and cache.exists():
        return pd.read_parquet(cache)
    df = con.execute(build_query(theme_glob(source_root, release, spec), spec, bbox)).df()
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(cache, index=False)
    return df
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_extract.py -v`
Expected: 6 passed.

- [ ] **Step 7: Write the failing test `pipeline/tests/test_probe.py`**

```python
from darksky_pipeline.extract import connect
from darksky_pipeline.probe import find_by_name, list_releases, place_categories
from overture_fixture import RELEASE


def test_place_categories_counts_matching_keywords(overture_frames):
    cats = place_categories(overture_frames["places"], ["park", "camp"]).set_index("category")["count"]
    assert cats["park"] == 4
    assert cats["campground"] == 1
    assert "restaurant" not in cats


def test_find_by_name_is_case_insensitive_and_covers_land_use(overture_frames):
    hits = find_by_name(overture_frames["places"], overture_frames["land_use"], "hudson")
    assert {"pl_hudson", "pl_hudson_launch", "pl_gas", "pl_lot", "lu_hudson"} <= set(hits["id"])
    assert set(hits["kind"]) == {"place", "land_use"}
    lu = hits.set_index("id").loc["lu_hudson"]
    assert abs(lu["lon"] + 84.25) < 0.02 and abs(lu["lat"] - 41.83) < 0.02


def test_list_releases_reads_directory_names(overture_root):
    assert list_releases(connect(), overture_root.as_posix()) == [RELEASE]
```

- [ ] **Step 8: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_probe.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.probe'`.

- [ ] **Step 9: Write `pipeline/darksky_pipeline/probe.py`**

```python
"""Exploration CLI: list releases, inspect categories, look up GERS IDs by name.

Usage:
  python -m darksky_pipeline.probe releases
  python -m darksky_pipeline.probe categories --metro se_mi --release <R> [--keywords park camp beach]
  python -m darksky_pipeline.probe find --metro se_mi --release <R> --name "Lake Hudson"
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

import duckdb
import pandas as pd

from .config import METROS, OVERTURE_S3_ROOT
from .extract import connect, extract_theme
from .util import wkb_to_geoms

DEFAULT_KEYWORDS = ("park", "camp", "beach", "observ", "nature", "view", "boat", "parking",
                    "toilet", "restroom", "gas", "restaurant", "cafe", "coffee", "diner")


def place_categories(places: pd.DataFrame, keywords: Iterable[str]) -> pd.DataFrame:
    kws = [k.lower() for k in keywords]
    cats = places["category"].dropna()
    cats = cats[cats.map(lambda c: any(k in c.lower() for k in kws))]
    counts = cats.value_counts()
    return pd.DataFrame({"category": counts.index, "count": counts.to_numpy()})


def find_by_name(places: pd.DataFrame, land_use: pd.DataFrame, text: str) -> pd.DataFrame:
    needle = text.lower()
    p = places[places["name"].fillna("").str.lower().str.contains(needle, regex=False)]
    rows = [{"id": r.id, "name": r.name, "kind": "place", "category": r.category, "lon": r.lon, "lat": r.lat}
            for r in p.itertuples(index=False)]
    lu = land_use[land_use["name"].fillna("").str.lower().str.contains(needle, regex=False)]
    if len(lu):
        for (i, name, subtype), g in zip(lu[["id", "name", "subtype"]].itertuples(index=False),
                                          wkb_to_geoms(lu["wkb"])):
            rp = g.representative_point()
            rows.append({"id": i, "name": name, "kind": "land_use", "category": subtype, "lon": rp.x, "lat": rp.y})
    return pd.DataFrame(rows, columns=["id", "name", "kind", "category", "lon", "lat"])


def list_releases(con: duckdb.DuckDBPyConnection, root: str = OVERTURE_S3_ROOT) -> list[str]:
    root_norm = root.replace("\\", "/").rstrip("/") + "/"
    files = con.execute(f"SELECT file FROM glob('{root_norm}*/theme=divisions/type=division_area/*')").fetchall()
    releases = set()
    for (f,) in files:
        rel = f.replace("\\", "/").split(root_norm, 1)[-1]
        releases.add(rel.split("/", 1)[0])
    return sorted(releases)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="darksky_pipeline.probe")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("releases")
    for name in ("categories", "find"):
        sp = sub.add_parser(name)
        sp.add_argument("--metro", choices=sorted(METROS), required=True)
        sp.add_argument("--release", required=True)
        sp.add_argument("--cache", default="data/raw")
        if name == "categories":
            sp.add_argument("--keywords", nargs="*", default=list(DEFAULT_KEYWORDS))
        else:
            sp.add_argument("--name", required=True)
    args = ap.parse_args(argv)
    con = connect()
    if args.cmd == "releases":
        print("\n".join(list_releases(con)))
        return
    metro = METROS[args.metro]
    cache = Path(args.cache) / metro.key / args.release
    places = extract_theme(con, "places", metro.bbox, args.release, cache_dir=cache)
    with pd.option_context("display.max_rows", 500, "display.width", 200):
        if args.cmd == "categories":
            print(place_categories(places, args.keywords).to_string(index=False))
        else:
            land_use = extract_theme(con, "land_use", metro.bbox, args.release, cache_dir=cache)
            print(find_by_name(places, land_use, args.name).to_string(index=False))


if __name__ == "__main__":
    main()
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_extract.py tests/test_probe.py -v`
Expected: 9 passed.

- [ ] **Step 11: Commit**

```bash
git add pipeline/darksky_pipeline/extract.py pipeline/darksky_pipeline/probe.py pipeline/tests
git commit -m "feat(pipeline): extract Overture themes via DuckDB with cache and probe CLI"
```

---

### Task 4: Sky-glow darkness grid

**Files:**
- Create: `pipeline/darksky_pipeline/darkness.py`, `pipeline/tests/viirs_fixture.py`, `pipeline/tests/test_darkness.py`
- Modify: `pipeline/tests/conftest.py` (append fixtures)

**Interfaces:**
- Consumes: `geo.Projector`, `config` darkness constants.
- Produces:
  - `darkness.sqm_from_glow(glow, k=SKYGLOW_K) -> np.ndarray[float32]`
  - `darkness.sky_label(sqm: float) -> str`, `darkness.bortle(sqm: float) -> int`
  - `darkness.brightness_ratio(sqm_dark: float, sqm_bright: float) -> float`
  - `darkness.skyglow_kernel(res_m, radius_m, exponent) -> np.ndarray`
  - `darkness.DarknessGrid` dataclass (`sqm: np.ndarray[float32] rows×cols, row 0 = north; x0: float west edge; y0: float north edge; res: float; epsg: int`) with `.sample(x, y) -> np.ndarray[float64]` (NaN outside), `.save(path)`, `DarknessGrid.load(path)`.
  - `darkness.build_darkness_grid(viirs_path, bbox, epsg, res_m=..., radius_m=..., exponent=..., k=...) -> DarknessGrid`
  - Test fixtures: `viirs_path`, `projector` (Projector(TEST_EPSG)), `darkness_grid`.

- [ ] **Step 1: Write `pipeline/tests/viirs_fixture.py`**

```python
"""Writes a small fake VIIRS radiance GeoTIFF (EPSG:4326) for tests."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

from overture_fixture import CITY

NODATA = -9999.0


def write_viirs_fixture(path: Path, blobs=((CITY[0], CITY[1], 0.03, 60.0),),
                        bounds=(-85.2, 41.2, -83.2, 42.6), res=0.005, base=0.2,
                        with_bad_values=True) -> Path:
    w, s, e, n = bounds
    cols, rows = round((e - w) / res), round((n - s) / res)
    lon = w + (np.arange(cols) + 0.5) * res
    lat = n - (np.arange(rows) + 0.5) * res
    LON, LAT = np.meshgrid(lon, lat)
    data = np.full((rows, cols), base, dtype=np.float32)
    for bx, by, r, v in blobs:
        data[(LON - bx) ** 2 + (LAT - by) ** 2 <= r * r] = v
    if with_bad_values:
        data[(LON >= -84.95) & (LON <= -84.90) & (LAT >= 41.90) & (LAT <= 42.00)] = NODATA
        data[(LON >= -84.60) & (LON <= -84.55) & (LAT >= 41.50) & (LAT <= 41.55)] = -1.5
    with rasterio.open(path, "w", driver="GTiff", height=rows, width=cols, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(w, n, res, res), nodata=NODATA) as dst:
        dst.write(data, 1)
    return path
```

- [ ] **Step 2: Append to `pipeline/tests/conftest.py`**

```python
@pytest.fixture(scope="session")
def viirs_path(tmp_path_factory):
    from viirs_fixture import write_viirs_fixture

    return write_viirs_fixture(tmp_path_factory.mktemp("viirs") / "viirs.tif")


@pytest.fixture(scope="session")
def projector():
    from darksky_pipeline.geo import Projector
    from overture_fixture import TEST_EPSG

    return Projector(TEST_EPSG)


@pytest.fixture(scope="session")
def darkness_grid(viirs_path):
    from darksky_pipeline.darkness import build_darkness_grid
    from overture_fixture import TEST_EPSG

    return build_darkness_grid(viirs_path, REGION_BBOX, TEST_EPSG)
```

- [ ] **Step 3: Write the failing test `pipeline/tests/test_darkness.py`**

```python
import math

import numpy as np
import pytest

from darksky_pipeline import config
from darksky_pipeline.darkness import (DarknessGrid, bortle, brightness_ratio, build_darkness_grid,
                                       skyglow_kernel, sky_label, sqm_from_glow)
from overture_fixture import CITY, HUDSON, REGION_BBOX, TEST_EPSG
from viirs_fixture import write_viirs_fixture


def test_sqm_from_glow_formula():
    assert sqm_from_glow(np.array([0.0]))[0] == pytest.approx(22.0)
    assert sqm_from_glow(np.array([config.SKYGLOW_K]))[0] == pytest.approx(22.0 - 2.5 * math.log10(2), abs=1e-5)
    assert sqm_from_glow(np.array([-5.0]))[0] == pytest.approx(22.0)


@pytest.mark.parametrize("sqm,label", [
    (21.6, "Milky Way vivid"), (21.3, "Milky Way vivid"), (20.9, "Milky Way visible"),
    (19.8, "Milky Way faint"), (18.0, "Milky Way not visible"),
])
def test_sky_label(sqm, label):
    assert sky_label(sqm) == label


@pytest.mark.parametrize("sqm,b", [(22.0, 1), (21.8, 3), (21.0, 4), (19.0, 6), (17.0, 8)])
def test_bortle(sqm, b):
    assert bortle(sqm) == b


def test_brightness_ratio():
    assert brightness_ratio(21.0, 18.5) == pytest.approx(10.0)


def test_kernel_is_normalized_and_circular():
    k = skyglow_kernel(500, 5_000, 2.5)
    assert k.shape == (21, 21)
    assert k.sum() == pytest.approx(1.0)
    assert k[0, 0] == 0.0  # corner is beyond radius
    assert k[10, 10] == k.max()


def test_city_is_much_brighter_than_hudson(darkness_grid, projector):
    city = darkness_grid.sample(*projector.to_xy(*CITY))[0]
    hudson = darkness_grid.sample(*projector.to_xy(*HUDSON))[0]
    assert hudson - city > 2.0
    assert sky_label(hudson) in ("Milky Way vivid", "Milky Way visible")
    assert sky_label(city) == "Milky Way not visible"


def test_grid_is_finite_despite_bad_values(darkness_grid):
    assert np.isfinite(darkness_grid.sqm).all()
    assert darkness_grid.sqm.max() <= config.NATURAL_SQM + 1e-6


def test_grid_covers_region(darkness_grid, projector):
    w, s, e, n = REGION_BBOX
    for lon, lat in [(w + 0.01, s + 0.01), (e - 0.01, n - 0.01), (w + 0.01, n - 0.01), (e - 0.01, s + 0.01)]:
        assert np.isfinite(darkness_grid.sample(*projector.to_xy(lon, lat))[0])


def test_sample_outside_is_nan(darkness_grid, projector):
    assert np.isnan(darkness_grid.sample(*projector.to_xy(-90.0, 30.0))[0])


def test_save_load_round_trip(darkness_grid, tmp_path):
    path = tmp_path / "g.npz"
    darkness_grid.save(path)
    loaded = DarknessGrid.load(path)
    assert loaded.epsg == darkness_grid.epsg and loaded.res == darkness_grid.res
    assert loaded.x0 == darkness_grid.x0 and loaded.y0 == darkness_grid.y0
    np.testing.assert_array_equal(loaded.sqm, darkness_grid.sqm)


def test_edge_glow_from_outside_region(tmp_path, projector):
    # Bright blob ~4 km east of the region's east edge (-84.00).
    tif = write_viirs_fixture(tmp_path / "edge.tif", blobs=((-83.95, 41.90, 0.03, 60.0),), with_bad_values=False)
    grid = build_darkness_grid(tif, REGION_BBOX, TEST_EPSG)
    east = grid.sample(*projector.to_xy(-84.01, 41.90))[0]
    west = grid.sample(*projector.to_xy(-84.39, 41.90))[0]
    assert west - east > 1.0
```

- [ ] **Step 4: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_darkness.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.darkness'`.

- [ ] **Step 5: Write `pipeline/darksky_pipeline/darkness.py`**

```python
"""Sky-brightness (SQM) grid from VIIRS night-lights radiance.

Sky glow at a cell is a distance-weighted average of surrounding radiance
(weights ∝ d^-exponent within radius), converted to SQM with
    sqm = NATURAL_SQM - 2.5 * log10(1 + glow / k).
The grid is padded by `radius` so lights just outside the region still count.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from rasterio.windows import from_bounds
from scipy.signal import fftconvolve

from . import config
from .config import BBox
from .geo import Projector


def sqm_from_glow(glow, k: float = config.SKYGLOW_K) -> np.ndarray:
    g = np.maximum(np.asarray(glow, dtype=np.float64), 0.0)
    return (config.NATURAL_SQM - 2.5 * np.log10(1.0 + g / k)).astype(np.float32)


def sky_label(sqm: float) -> str:
    for threshold, label in config.SKY_LABELS:
        if sqm >= threshold:
            return label
    return config.SKY_LABELS[-1][1]


def bortle(sqm: float) -> int:
    for threshold, value in config.BORTLE_THRESHOLDS:
        if sqm >= threshold:
            return value
    return config.BORTLE_THRESHOLDS[-1][1]


def brightness_ratio(sqm_dark: float, sqm_bright: float) -> float:
    """How many times darker the sky at `sqm_dark` is than at `sqm_bright`."""
    return float(10 ** (0.4 * (sqm_dark - sqm_bright)))


def skyglow_kernel(res_m: float, radius_m: float, exponent: float) -> np.ndarray:
    n = int(radius_m // res_m)
    yy, xx = np.mgrid[-n:n + 1, -n:n + 1]
    d = np.hypot(xx, yy) * res_m
    w = (np.maximum(d, res_m / 2.0) / 1000.0) ** -exponent
    w[d > radius_m] = 0.0
    return w / w.sum()


@dataclass
class DarknessGrid:
    sqm: np.ndarray  # float32, rows x cols, row 0 = north
    x0: float        # west edge, metres
    y0: float        # north edge, metres
    res: float
    epsg: int

    def sample(self, x, y) -> np.ndarray:
        x = np.atleast_1d(np.asarray(x, dtype=np.float64))
        y = np.atleast_1d(np.asarray(y, dtype=np.float64))
        col = np.floor((x - self.x0) / self.res).astype(np.int64)
        row = np.floor((self.y0 - y) / self.res).astype(np.int64)
        h, w = self.sqm.shape
        ok = (col >= 0) & (col < w) & (row >= 0) & (row < h)
        out = np.full(x.shape, np.nan, dtype=np.float64)
        out[ok] = self.sqm[row[ok], col[ok]]
        return out

    def save(self, path: Path) -> None:
        np.savez_compressed(path, sqm=self.sqm,
                            meta=np.array([self.x0, self.y0, self.res, self.epsg], dtype=np.float64))

    @classmethod
    def load(cls, path: Path) -> "DarknessGrid":
        with np.load(path) as z:
            meta = z["meta"]
            return cls(sqm=z["sqm"], x0=float(meta[0]), y0=float(meta[1]), res=float(meta[2]), epsg=int(meta[3]))


def build_darkness_grid(viirs_path: Path, bbox: BBox, epsg: int,
                        res_m: float = config.GRID_RES_M, radius_m: float = config.SKYGLOW_RADIUS_M,
                        exponent: float = config.SKYGLOW_EXPONENT, k: float = config.SKYGLOW_K) -> DarknessGrid:
    projector = Projector(epsg)
    minx, miny, maxx, maxy = projector.bbox_xy(bbox)
    minx, miny = math.floor(minx / res_m) * res_m, math.floor(miny / res_m) * res_m
    maxx, maxy = math.ceil(maxx / res_m) * res_m, math.ceil(maxy / res_m) * res_m
    cols, rows = round((maxx - minx) / res_m), round((maxy - miny) / res_m)
    n = int(radius_m // res_m)
    pad = n * res_m

    radiance = np.full((rows + 2 * n, cols + 2 * n), np.nan, dtype=np.float32)
    dst_transform = from_origin(minx - pad, maxy + pad, res_m, res_m)
    lon_w, lat_s, lon_e, lat_n = projector.bbox_lonlat((minx - pad, miny - pad, maxx + pad, maxy + pad))
    with rasterio.open(viirs_path) as src:
        window = from_bounds(lon_w - 0.05, lat_s - 0.05, lon_e + 0.05, lat_n + 0.05,
                             transform=src.transform).round_offsets().round_lengths()
        fill = src.nodata if src.nodata is not None else 0.0
        data = src.read(1, window=window, boundless=True, fill_value=fill).astype(np.float32)
        reproject(source=data, destination=radiance,
                  src_transform=src.window_transform(window), src_crs=src.crs, src_nodata=src.nodata,
                  dst_transform=dst_transform, dst_crs=CRS.from_epsg(epsg), dst_nodata=np.nan,
                  resampling=Resampling.average)
    radiance = np.nan_to_num(radiance, nan=0.0)
    radiance[radiance < 0] = 0.0

    glow = fftconvolve(radiance, skyglow_kernel(res_m, radius_m, exponent), mode="same")
    glow = glow[n:n + rows, n:n + cols]
    return DarknessGrid(sqm=sqm_from_glow(glow, k), x0=minx, y0=maxy, res=float(res_m), epsg=epsg)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_darkness.py -v`
Expected: all passed (16 incl. parametrized).

- [ ] **Step 7: Commit**

```bash
git add pipeline/darksky_pipeline/darkness.py pipeline/tests
git commit -m "feat(pipeline): build sky-glow SQM grid from VIIRS"
```

---

### Task 5: Curated spot data

**Files:**
- Create: `pipeline/darksky_pipeline/curated.py`, `pipeline/curated/se_mi.yaml`, `pipeline/curated/bay_area.yaml`, `pipeline/tests/test_curated.py`

**Interfaces:**
- Produces: `curated.CuratedEntry` (frozen dataclass: `id: str, label: str = "", verified: bool = False, dark_sky_place: bool = False, access_note: str | None = None, unavailable: bool = False, unavailable_reason: str | None = None`), `curated.load_curated(path: Path) -> dict[str, CuratedEntry]` (missing file → `{}`; raises `ValueError` on duplicate id, missing id, or unknown key).

- [ ] **Step 1: Write the failing test `pipeline/tests/test_curated.py`**

```python
import pytest

from darksky_pipeline.curated import CuratedEntry, load_curated


def write(tmp_path, text):
    p = tmp_path / "c.yaml"
    p.write_text(text, encoding="utf-8")
    return p


def test_loads_entries_by_id(tmp_path):
    p = write(tmp_path, """
spots:
  - id: pl_hudson
    label: Lake Hudson
    verified: true
    dark_sky_place: true
    access_note: Open 24h
  - id: pl_city
    unavailable: true
    unavailable_reason: Closed for construction
""")
    data = load_curated(p)
    assert data["pl_hudson"] == CuratedEntry(id="pl_hudson", label="Lake Hudson", verified=True,
                                             dark_sky_place=True, access_note="Open 24h")
    assert data["pl_city"].unavailable and data["pl_city"].unavailable_reason == "Closed for construction"


def test_missing_file_is_empty(tmp_path):
    assert load_curated(tmp_path / "nope.yaml") == {}


def test_empty_list_is_empty(tmp_path):
    assert load_curated(write(tmp_path, "spots: []\n")) == {}


@pytest.mark.parametrize("text,msg", [
    ("spots:\n  - id: a\n  - id: a\n", "duplicate"),
    ("spots:\n  - label: x\n", "id"),
    ("spots:\n  - id: a\n    verifed: true\n", "unknown"),
])
def test_rejects_bad_files(tmp_path, text, msg):
    with pytest.raises(ValueError, match=msg):
        load_curated(write(tmp_path, text))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_curated.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.curated'`.

- [ ] **Step 3: Write `pipeline/darksky_pipeline/curated.py`**

```python
"""Hand-curated facts about spots, keyed by Overture GERS ID."""
from __future__ import annotations

from dataclasses import dataclass, fields
from pathlib import Path

import yaml


@dataclass(frozen=True)
class CuratedEntry:
    id: str
    label: str = ""
    verified: bool = False
    dark_sky_place: bool = False
    access_note: str | None = None
    unavailable: bool = False
    unavailable_reason: str | None = None


_ALLOWED = {f.name for f in fields(CuratedEntry)}


def load_curated(path: Path) -> dict[str, CuratedEntry]:
    path = Path(path)
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    out: dict[str, CuratedEntry] = {}
    for i, raw in enumerate(data.get("spots") or []):
        if not isinstance(raw, dict) or not raw.get("id"):
            raise ValueError(f"{path}: entry {i} is missing an id")
        unknown = set(raw) - _ALLOWED
        if unknown:
            raise ValueError(f"{path}: entry {raw['id']} has unknown keys {sorted(unknown)}")
        entry = CuratedEntry(**{**raw, "id": str(raw["id"])})
        if entry.id in out:
            raise ValueError(f"{path}: duplicate id {entry.id}")
        out[entry.id] = entry
    return out
```

- [ ] **Step 4: Write `pipeline/curated/se_mi.yaml`**

```yaml
# Curated facts for SE Michigan spots, keyed by Overture GERS ID.
# Find IDs with: python -m darksky_pipeline.probe find --metro se_mi --release <R> --name "<name>"
# Keys: id, label, verified, dark_sky_place, access_note, unavailable, unavailable_reason
# Spots to add in Task 14: Lake Hudson Recreation Area, Port Crescent State Park,
# Seven Lakes State Park, Proud Lake Recreation Area, Highland Recreation Area.
spots: []
```

- [ ] **Step 5: Write `pipeline/curated/bay_area.yaml`**

```yaml
# Curated facts for SF Bay Area spots, keyed by Overture GERS ID.
# Find IDs with: python -m darksky_pipeline.probe find --metro bay_area --release <R> --name "<name>"
# Keys: id, label, verified, dark_sky_place, access_note, unavailable, unavailable_reason
# Spots to add in Task 14: Henry W. Coe State Park, Pinnacles National Park,
# Point Reyes National Seashore, Mount Tamalpais State Park, Mount Diablo State Park.
spots: []
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_curated.py -v`
Expected: 6 passed.

- [ ] **Step 7: Commit**

```bash
git add pipeline/darksky_pipeline/curated.py pipeline/curated pipeline/tests/test_curated.py
git commit -m "feat(pipeline): load curated spot facts keyed by GERS ID"
```

---

### Task 6: Candidate spots

**Files:**
- Create: `pipeline/darksky_pipeline/spots.py`, `pipeline/tests/test_spots.py`

**Interfaces:**
- Consumes: `extract` frames `places` and `land_use`, `geo.Projector`, `util.wkb_to_geoms`, `config` place/land-use constants.
- Produces: `spots.Candidate` dataclass (`id: str, name: str, category: str, lon: float, lat: float, area: shapely Polygon/MultiPolygon in UTM metres, source: "place+polygon" | "place" | "polygon"`), `spots.build_candidates(places, land_use, projector) -> list[Candidate]` sorted by `id`.

Rules: park polygons = land_use with subtype in `PARK_SUBTYPES` and area ≥ `MIN_PARK_AREA_M2`. Spot places = category in `SPOT_CATEGORIES`, confidence ≥ `MIN_PLACE_CONFIDENCE`, non-blank name. A place inside a polygon (smallest containing polygon wins) claims it; per polygon only the highest-confidence place survives. Places with no polygon get a `PLACE_ONLY_RADIUS_M` circle. Named polygons with no place become spots themselves (category = subtype).

- [ ] **Step 1: Write the failing test `pipeline/tests/test_spots.py`**

```python
import math

import pandas as pd

from darksky_pipeline import config
from darksky_pipeline.spots import build_candidates


def test_candidates_from_fixture(overture_frames, projector):
    cands = {c.id: c for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
    assert sorted(cands) == ["lu_woods", "pl_camp", "pl_city", "pl_hudson"]

    hudson = cands["pl_hudson"]
    assert hudson.source == "place+polygon"
    assert hudson.name == "Lake Hudson Recreation Area"
    assert hudson.area.area > 10_000_000  # the park polygon, ~22 km²

    camp = cands["pl_camp"]
    assert camp.source == "place"
    assert math.isclose(camp.area.area, math.pi * config.PLACE_ONLY_RADIUS_M ** 2, rel_tol=0.01)

    woods = cands["lu_woods"]
    assert woods.source == "polygon" and woods.category == "protected"
    assert -84.35 < woods.lon < -84.33 and 41.95 < woods.lat < 41.97


def test_duplicate_place_in_same_park_is_dropped(overture_frames, projector):
    ids = {c.id for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
    assert "pl_hudson_launch" not in ids and "lu_hudson" not in ids


def test_nameless_lowconf_and_non_spot_places_are_dropped(overture_frames, projector):
    ids = {c.id for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
    assert not ids & {"pl_noname", "pl_lowconf", "pl_cafe", "pl_gas", "pl_lot", "lu_tiny"}


def test_works_without_land_use(overture_frames, projector):
    empty = overture_frames["land_use"].iloc[0:0]
    cands = build_candidates(overture_frames["places"], empty, projector)
    assert {c.id for c in cands} == {"pl_hudson", "pl_hudson_launch", "pl_city", "pl_camp"}
    assert all(c.source == "place" for c in cands)


def test_blank_name_is_dropped(projector):
    places = pd.DataFrame([{"id": "p", "name": "   ", "category": "park", "confidence": 0.9,
                            "lon": -84.2, "lat": 41.9}])
    land_use = pd.DataFrame(columns=["id", "name", "subtype", "class", "wkb"])
    assert build_candidates(places, land_use, projector) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_spots.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.spots'`.

- [ ] **Step 3: Write `pipeline/darksky_pipeline/spots.py`**

```python
"""Candidate stargazing spots from Overture places and park polygons."""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
import shapely
from shapely.geometry.base import BaseGeometry

from . import config
from .geo import Projector
from .util import wkb_to_geoms


@dataclass
class Candidate:
    id: str
    name: str
    category: str
    lon: float
    lat: float
    area: BaseGeometry  # UTM metres; where to look for a viewing point
    source: str         # "place+polygon" | "place" | "polygon"


def _polygonal(geom: BaseGeometry) -> BaseGeometry | None:
    geom = shapely.make_valid(geom)
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else None


def _park_polygons(land_use: pd.DataFrame, projector: Projector) -> tuple[list[BaseGeometry], list[tuple]]:
    lu = land_use[land_use["subtype"].isin(config.PARK_SUBTYPES)].reset_index(drop=True)
    if len(lu) == 0:
        return [], []
    polys, rows = [], []
    geoms = projector.geoms_to_xy(wkb_to_geoms(lu["wkb"]))
    for row, g in zip(lu[["id", "name", "subtype"]].itertuples(index=False), geoms):
        g = _polygonal(g)
        if g is None or g.area < config.MIN_PARK_AREA_M2:
            continue
        polys.append(g)
        rows.append(tuple(row))
    return polys, rows


def build_candidates(places: pd.DataFrame, land_use: pd.DataFrame, projector: Projector) -> list[Candidate]:
    polys, poly_rows = _park_polygons(land_use, projector)
    tree = shapely.STRtree(polys) if polys else None

    sel = places[places["category"].isin(config.SPOT_CATEGORIES)
                 & (places["confidence"] >= config.MIN_PLACE_CONFIDENCE)
                 & places["name"].notna()]
    sel = sel[sel["name"].str.strip() != ""]
    sel = sel.sort_values(["confidence", "id"], ascending=[False, True])

    claimed: dict[int, tuple] = {}
    lone: list[tuple] = []
    for row in sel[["id", "name", "category", "lon", "lat"]].itertuples(index=False):
        x, y = projector.to_xy(row.lon, row.lat)
        pt = shapely.Point(x, y)
        hits = tree.query(pt, predicate="within") if tree is not None else []
        if len(hits):
            i = int(min(hits, key=lambda j: polys[j].area))
            claimed.setdefault(i, (row, pt))  # rows are sorted best-first
        else:
            lone.append((row, pt))

    out: list[Candidate] = []
    for i, (row, _) in claimed.items():
        out.append(Candidate(row.id, row.name.strip(), row.category, float(row.lon), float(row.lat),
                             polys[i], "place+polygon"))
    for row, pt in lone:
        out.append(Candidate(row.id, row.name.strip(), row.category, float(row.lon), float(row.lat),
                             pt.buffer(config.PLACE_ONLY_RADIUS_M), "place"))
    for i, ((pid, name, subtype), g) in enumerate(zip(poly_rows, polys)):
        if i in claimed or not isinstance(name, str) or not name.strip():
            continue
        rp = g.representative_point()
        lon, lat = projector.to_lonlat(rp.x, rp.y)
        out.append(Candidate(pid, name.strip(), str(subtype), float(lon), float(lat), g, "polygon"))
    return sorted(out, key=lambda c: c.id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_spots.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/darksky_pipeline/spots.py pipeline/tests/test_spots.py
git commit -m "feat(pipeline): build candidate spots from places and park polygons"
```

---

### Task 7: Road network, access, and viewing point

**Files:**
- Create: `pipeline/darksky_pipeline/roads.py`, `pipeline/tests/test_roads.py`
- Modify: `pipeline/tests/conftest.py` (append `road_network`, `candidates` fixtures)

**Interfaces:**
- Consumes: `extract` frames `segments`, `places`; `darkness.DarknessGrid`; `spots.Candidate`; `util.as_list`, `util.wkb_to_geoms`.
- Produces:
  - `roads.is_private(access_restrictions) -> bool` (any restriction with `access_type == "denied"` and no `when`)
  - `roads.is_paved(road_class, road_surface) -> bool`
  - `roads.RoadNetwork` dataclass: `geoms: np.ndarray[object]`, `classes: np.ndarray[object]`, `paved: np.ndarray[bool]`, `tree: STRtree | None`, `highway_geoms: np.ndarray[object]`, `highway_tree: STRtree | None`
  - `roads.build_road_network(segments, projector) -> RoadNetwork`
  - `roads.parking_points(places, projector) -> np.ndarray` shape (N, 2)
  - `roads.ViewingPoint` dataclass: `x, y, lon, lat, sqm: float, road_class: str, paved: bool`
  - `roads.sample_points(area, roads, parking_xy) -> tuple[np.ndarray (N,2), np.ndarray (N,) int road index]`
  - `roads.find_viewing_point(area, roads, grid, projector, parking_xy) -> ViewingPoint | None`

- [ ] **Step 1: Append to `pipeline/tests/conftest.py`**

```python
@pytest.fixture(scope="session")
def road_network(overture_frames, projector):
    from darksky_pipeline.roads import build_road_network

    return build_road_network(overture_frames["segments"], projector)


@pytest.fixture(scope="session")
def candidates(overture_frames, projector):
    from darksky_pipeline.spots import build_candidates

    return {c.id: c for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
```

- [ ] **Step 2: Write the failing test `pipeline/tests/test_roads.py`**

```python
import numpy as np
import pytest
import shapely

from darksky_pipeline import config
from darksky_pipeline.roads import (RoadNetwork, build_road_network, find_viewing_point, is_paved,
                                    is_private, parking_points, sample_points)


@pytest.mark.parametrize("value,expected", [
    (None, False),
    ([], False),
    ([{"access_type": "denied"}], True),
    ([{"access_type": "denied", "when": {"mode": ["hgv"]}}], False),
    ([{"access_type": "allowed"}], False),
    (np.array([{"access_type": "denied", "when": None}], dtype=object), True),
])
def test_is_private(value, expected):
    assert is_private(value) is expected


@pytest.mark.parametrize("cls,surface,expected", [
    ("tertiary", [{"value": "paved"}], True),
    ("tertiary", None, True),
    ("tertiary", [{"value": "unpaved"}], False),
    ("track", [{"value": "paved"}], False),
])
def test_is_paved(cls, surface, expected):
    assert is_paved(cls, surface) is expected


def test_network_excludes_private_and_non_drivable(road_network):
    assert sorted(road_network.classes) == sorted(["tertiary", "residential", "track", "motorway"])
    assert len(road_network.highway_geoms) == 1


def test_hudson_viewing_point_near_park_center(candidates, road_network, darkness_grid, projector, overture_frames):
    vp = find_viewing_point(candidates["pl_hudson"].area, road_network, darkness_grid, projector,
                            parking_points(overture_frames["places"], projector))
    assert vp is not None
    assert abs(vp.lon + 84.25) < 0.002 and abs(vp.lat - 41.83) < 0.001
    assert vp.road_class == "tertiary" and vp.paved is True
    assert vp.sqm > 21.0


def test_camp_viewing_point_is_unpaved_track(candidates, road_network, darkness_grid, projector):
    vp = find_viewing_point(candidates["pl_camp"].area, road_network, darkness_grid, projector, np.empty((0, 2)))
    assert vp is not None and vp.road_class == "track" and vp.paved is False


def test_no_viewing_point_without_drivable_road(candidates, road_network, darkness_grid, projector):
    # Hidden Woods only has a private service road and a footway.
    assert find_viewing_point(candidates["lu_woods"].area, road_network, darkness_grid, projector,
                              np.empty((0, 2))) is None


def test_parking_points_selects_parking_places(overture_frames, projector):
    pts = parking_points(overture_frames["places"], projector)
    assert pts.shape == (1, 2)


def test_sample_points_are_capped():
    line = shapely.LineString([(0, 500), (300_000, 500)])
    net = RoadNetwork(geoms=np.array([line], dtype=object), classes=np.array(["primary"], dtype=object),
                      paved=np.array([True]), tree=shapely.STRtree([line]),
                      highway_geoms=np.array([], dtype=object), highway_tree=None)
    xy, road_idx = sample_points(shapely.box(0, 0, 300_000, 1_000), net, np.empty((0, 2)))
    assert len(xy) == config.MAX_VIEWING_CANDIDATES == len(road_idx)


def test_empty_network_returns_none(candidates, darkness_grid, projector):
    net = RoadNetwork(geoms=np.array([], dtype=object), classes=np.array([], dtype=object),
                      paved=np.array([], dtype=bool), tree=None,
                      highway_geoms=np.array([], dtype=object), highway_tree=None)
    assert find_viewing_point(candidates["pl_hudson"].area, net, darkness_grid, projector, np.empty((0, 2))) is None
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_roads.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.roads'`.

- [ ] **Step 4: Write `pipeline/darksky_pipeline/roads.py`**

```python
"""Drivable road network, access checks, and darkest-reachable viewing point."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import shapely
from shapely.geometry.base import BaseGeometry

from . import config
from .darkness import DarknessGrid
from .geo import Projector
from .util import as_list, wkb_to_geoms


def is_private(access_restrictions) -> bool:
    return any(isinstance(r, dict) and r.get("access_type") == "denied" and not r.get("when")
               for r in as_list(access_restrictions))


def is_paved(road_class: str, road_surface) -> bool:
    if road_class in config.UNPAVED_CLASSES:
        return False
    values = [r.get("value") for r in as_list(road_surface) if isinstance(r, dict)]
    return "unpaved" not in values


@dataclass
class RoadNetwork:
    geoms: np.ndarray
    classes: np.ndarray
    paved: np.ndarray
    tree: shapely.STRtree | None
    highway_geoms: np.ndarray
    highway_tree: shapely.STRtree | None


def build_road_network(segments: pd.DataFrame, projector: Projector) -> RoadNetwork:
    df = segments[(segments["subtype"] == "road") & segments["class"].isin(config.DRIVABLE_CLASSES)]
    df = df[~df["access_restrictions"].map(is_private)].reset_index(drop=True)
    geoms = projector.geoms_to_xy(wkb_to_geoms(df["wkb"])) if len(df) else np.array([], dtype=object)
    classes = df["class"].to_numpy(dtype=object)
    paved = np.array([is_paved(c, s) for c, s in zip(df["class"], df["road_surface"])], dtype=bool)
    hw = geoms[np.isin(classes, list(config.HIGHWAY_CLASSES))] if len(geoms) else np.array([], dtype=object)
    return RoadNetwork(geoms=geoms, classes=classes, paved=paved,
                       tree=shapely.STRtree(geoms) if len(geoms) else None,
                       highway_geoms=hw, highway_tree=shapely.STRtree(hw) if len(hw) else None)


def parking_points(places: pd.DataFrame, projector: Projector) -> np.ndarray:
    p = places[places["category"].isin(config.PARKING_CATEGORIES)]
    if len(p) == 0:
        return np.empty((0, 2))
    x, y = projector.to_xy(p["lon"].to_numpy(), p["lat"].to_numpy())
    return np.column_stack([x, y])


@dataclass(frozen=True)
class ViewingPoint:
    x: float
    y: float
    lon: float
    lat: float
    sqm: float
    road_class: str
    paved: bool


def sample_points(area: BaseGeometry, roads: RoadNetwork, parking_xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    empty = (np.empty((0, 2)), np.empty(0, dtype=np.int64))
    if roads.tree is None:
        return empty
    zone = area.buffer(config.ACCESS_SEARCH_M)
    idx = roads.tree.query(zone, predicate="intersects")
    xy_parts, road_parts = [], []
    for i in idx:
        part = roads.geoms[i].intersection(zone)
        if part.is_empty:
            continue
        coords = shapely.get_coordinates(shapely.segmentize(part, config.ROAD_SAMPLE_STEP_M))
        xy_parts.append(coords)
        road_parts.append(np.full(len(coords), i, dtype=np.int64))
    if len(idx) and len(parking_xy):
        inside = shapely.contains_xy(zone, parking_xy[:, 0], parking_xy[:, 1])
        for x, y in parking_xy[inside]:
            p = shapely.Point(x, y)
            nearest = min(idx, key=lambda j: roads.geoms[j].distance(p))
            xy_parts.append(np.array([[x, y]]))
            road_parts.append(np.array([nearest], dtype=np.int64))
    if not xy_parts:
        return empty
    xy, road_idx = np.vstack(xy_parts), np.concatenate(road_parts)
    if len(xy) > config.MAX_VIEWING_CANDIDATES:
        keep = np.linspace(0, len(xy) - 1, config.MAX_VIEWING_CANDIDATES).astype(np.int64)
        xy, road_idx = xy[keep], road_idx[keep]
    return xy, road_idx


def find_viewing_point(area: BaseGeometry, roads: RoadNetwork, grid: DarknessGrid,
                       projector: Projector, parking_xy: np.ndarray) -> ViewingPoint | None:
    xy, road_idx = sample_points(area, roads, parking_xy)
    if len(xy) == 0:
        return None
    sqm = grid.sample(xy[:, 0], xy[:, 1])
    finite = np.isfinite(sqm)
    if not finite.any():
        return None
    ok = finite & (sqm >= np.nanmax(sqm) - config.DARKNESS_TIE_MAG)
    c = area.centroid
    dist = np.hypot(xy[:, 0] - c.x, xy[:, 1] - c.y)
    dist[~ok] = np.inf
    k = int(np.argmin(dist))
    lon, lat = projector.to_lonlat(xy[k, 0], xy[k, 1])
    r = int(road_idx[k])
    return ViewingPoint(float(xy[k, 0]), float(xy[k, 1]), float(lon), float(lat), float(sqm[k]),
                        str(roads.classes[r]), bool(roads.paved[r]))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_roads.py -v`
Expected: all passed (17 incl. parametrized).

- [ ] **Step 6: Commit**

```bash
git add pipeline/darksky_pipeline/roads.py pipeline/tests
git commit -m "feat(pipeline): road access checks and darkest-reachable viewing point"
```

---

### Task 8: Glare and horizon features

**Files:**
- Create: `pipeline/darksky_pipeline/features.py`, `pipeline/tests/test_features.py`

**Interfaces:**
- Consumes: `roads.RoadNetwork` (`highway_geoms`, `highway_tree`), `extract` frames `buildings`, `land_cover`, `water`.
- Produces:
  - `features.Glare` (frozen: `buildings_1km: int, highway_m: float | None, penalty: float`), `features.glare_penalty(buildings: int, highway_m: float | None) -> float`, `features.building_points(buildings_df, projector) -> np.ndarray (N,2)`, `features.GlareModel(buildings_xy, roads)` with `.at(x, y) -> Glare`.
  - `features.Horizon` (frozen: `cls: str ("open"|"partial"|"enclosed"), open_frac, closed_frac, water_frac: float`), `features.classify_horizon(open_frac, closed_frac) -> str`, `features.HorizonModel(land_cover_df, water_df, projector)` with `.at(x, y) -> Horizon`.

- [ ] **Step 1: Write the failing test `pipeline/tests/test_features.py`**

```python
import pytest

from darksky_pipeline.features import (GlareModel, HorizonModel, building_points, classify_horizon,
                                       glare_penalty)
from overture_fixture import CITY, HUDSON


@pytest.mark.parametrize("b,hw,expected", [
    (0, None, 0.0), (400, None, 0.7), (800, None, 0.7), (200, None, 0.35),
    (0, 500.0, 0.3), (0, 2000.0, 0.15), (0, 5000.0, 0.0), (400, 500.0, 1.0),
])
def test_glare_penalty(b, hw, expected):
    assert glare_penalty(b, hw) == pytest.approx(expected)


@pytest.mark.parametrize("o,c,expected", [
    (0.9, 0.0, "open"), (0.6, 0.35, "partial"), (0.1, 0.8, "enclosed"), (0.3, 0.3, "partial"),
])
def test_classify_horizon(o, c, expected):
    assert classify_horizon(o, c) == expected


def test_glare_city_vs_hudson(overture_frames, road_network, projector):
    model = GlareModel(building_points(overture_frames["buildings"], projector), road_network)
    city = model.at(*projector.to_xy(*CITY))
    hudson = model.at(*projector.to_xy(*HUDSON))
    assert city.buildings_1km >= 400 and city.penalty >= 0.5
    assert hudson.buildings_1km == 5 and hudson.penalty < 0.2
    assert 3_000 < city.highway_m < 5_000
    assert hudson.highway_m > 10_000


def test_horizon_hudson_open_with_lake_and_camp_enclosed(overture_frames, projector):
    model = HorizonModel(overture_frames["land_cover"], overture_frames["water"], projector)
    hudson = model.at(*projector.to_xy(*HUDSON))
    assert hudson.cls == "open" and hudson.water_frac > 0.2
    camp = model.at(*projector.to_xy(-84.15, 41.78))
    assert camp.cls == "enclosed" and camp.closed_frac > 0.9


def test_horizon_with_no_layers(overture_frames, projector):
    model = HorizonModel(overture_frames["land_cover"].iloc[0:0], overture_frames["water"].iloc[0:0], projector)
    h = model.at(*projector.to_xy(*HUDSON))
    assert (h.open_frac, h.closed_frac, h.water_frac, h.cls) == (0.0, 0.0, 0.0, "partial")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_features.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.features'`.

- [ ] **Step 3: Write `pipeline/darksky_pipeline/features.py`**

```python
"""Per-viewing-point site features: local glare and horizon openness."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import shapely
from scipy.spatial import cKDTree

from . import config
from .geo import Projector
from .roads import RoadNetwork
from .util import wkb_to_geoms


@dataclass(frozen=True)
class Glare:
    buildings_1km: int
    highway_m: float | None
    penalty: float


def glare_penalty(buildings: int, highway_m: float | None) -> float:
    p = min(1.0, buildings / config.GLARE_BUILDINGS_SATURATION) * config.GLARE_BUILDING_WEIGHT
    if highway_m is not None:
        if highway_m < config.HIGHWAY_NEAR_M:
            p += config.HIGHWAY_NEAR_PENALTY
        elif highway_m < config.HIGHWAY_MID_M:
            p += config.HIGHWAY_MID_PENALTY
    return round(min(p, 1.0), 3)


def building_points(buildings: pd.DataFrame, projector: Projector) -> np.ndarray:
    if len(buildings) == 0:
        return np.empty((0, 2))
    x, y = projector.to_xy(buildings["lon"].to_numpy(), buildings["lat"].to_numpy())
    return np.column_stack([x, y])


class GlareModel:
    def __init__(self, buildings_xy: np.ndarray, roads: RoadNetwork) -> None:
        self._tree = cKDTree(buildings_xy) if len(buildings_xy) else None
        self._roads = roads

    def at(self, x: float, y: float) -> Glare:
        count = len(self._tree.query_ball_point([x, y], r=config.GLARE_RADIUS_M)) if self._tree is not None else 0
        hw = None
        if self._roads.highway_tree is not None:
            p = shapely.Point(x, y)
            i = int(self._roads.highway_tree.nearest(p))
            hw = float(self._roads.highway_geoms[i].distance(p))
        return Glare(count, hw, glare_penalty(count, hw))


@dataclass(frozen=True)
class Horizon:
    cls: str
    open_frac: float
    closed_frac: float
    water_frac: float


def classify_horizon(open_frac: float, closed_frac: float) -> str:
    if open_frac >= config.HORIZON_OPEN_MIN and closed_frac < config.HORIZON_CLOSED_MAX_FOR_OPEN:
        return "open"
    if closed_frac >= config.HORIZON_ENCLOSED_MIN:
        return "enclosed"
    return "partial"


def _polygons(df: pd.DataFrame, projector: Projector) -> np.ndarray:
    if len(df) == 0:
        return np.array([], dtype=object)
    geoms = shapely.make_valid(projector.geoms_to_xy(wkb_to_geoms(df["wkb"])))
    return geoms[np.isin(shapely.get_type_id(geoms), [3, 6])]  # Polygon, MultiPolygon


class _Layer:
    def __init__(self, geoms: np.ndarray) -> None:
        self.geoms = geoms
        self.tree = shapely.STRtree(geoms) if len(geoms) else None

    def fraction(self, circle) -> float:
        if self.tree is None:
            return 0.0
        idx = self.tree.query(circle, predicate="intersects")
        if len(idx) == 0:
            return 0.0
        covered = shapely.union_all(shapely.intersection(self.geoms[idx], circle))
        return float(min(1.0, covered.area / circle.area))


class HorizonModel:
    def __init__(self, land_cover: pd.DataFrame, water: pd.DataFrame, projector: Projector) -> None:
        open_lc = _polygons(land_cover[land_cover["subtype"].isin(config.OPEN_COVER_SUBTYPES)], projector)
        closed_lc = _polygons(land_cover[land_cover["subtype"].isin(config.CLOSED_COVER_SUBTYPES)], projector)
        water_p = _polygons(water, projector)
        self._open = _Layer(np.concatenate([open_lc, water_p]))
        self._closed = _Layer(closed_lc)
        self._water = _Layer(water_p)

    def at(self, x: float, y: float) -> Horizon:
        circle = shapely.Point(x, y).buffer(config.HORIZON_RADIUS_M, quad_segs=16)
        o, c, w = self._open.fraction(circle), self._closed.fraction(circle), self._water.fraction(circle)
        return Horizon(classify_horizon(o, c), o, c, w)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_features.py -v`
Expected: all passed (15 incl. parametrized).

- [ ] **Step 5: Commit**

```bash
git add pipeline/darksky_pipeline/features.py pipeline/tests/test_features.py
git commit -m "feat(pipeline): glare and horizon features"
```

---

### Task 9: Nearby amenities

**Files:**
- Create: `pipeline/darksky_pipeline/amenities.py`, `pipeline/tests/test_amenities.py`

**Interfaces:**
- Consumes: `extract` frame `places`, `config.AMENITY_CATEGORIES`, `config.AMENITY_RADIUS_M`.
- Produces: `amenities.Amenity` (frozen: `name: str, km: float` straight-line, 1 decimal), `amenities.AmenityFinder(places, projector)` with `.near(x, y) -> dict[str, Amenity | None]` keyed `restroom, fuel, food`.

- [ ] **Step 1: Write the failing test `pipeline/tests/test_amenities.py`**

```python
import pytest

from darksky_pipeline.amenities import AmenityFinder
from overture_fixture import CITY, HUDSON


def test_hudson_has_fuel_and_food_but_no_restroom(overture_frames, projector):
    near = AmenityFinder(overture_frames["places"], projector).near(*projector.to_xy(*HUDSON))
    assert set(near) == {"restroom", "fuel", "food"}
    assert near["restroom"] is None
    assert near["fuel"].name == "Hudson Fuel" and near["fuel"].km == pytest.approx(3.4, abs=0.2)
    assert near["food"].name == "Moon Cafe" and near["food"].km == pytest.approx(4.3, abs=0.2)


def test_city_has_nothing_within_radius(overture_frames, projector):
    near = AmenityFinder(overture_frames["places"], projector).near(*projector.to_xy(*CITY))
    assert near == {"restroom": None, "fuel": None, "food": None}


def test_empty_places(overture_frames, projector):
    near = AmenityFinder(overture_frames["places"].iloc[0:0], projector).near(*projector.to_xy(*CITY))
    assert near == {"restroom": None, "fuel": None, "food": None}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_amenities.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.amenities'`.

- [ ] **Step 3: Write `pipeline/darksky_pipeline/amenities.py`**

```python
"""Nearest restroom / fuel / food to a viewing point (straight-line)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import config
from .geo import Projector


@dataclass(frozen=True)
class Amenity:
    name: str
    km: float


class AmenityFinder:
    def __init__(self, places: pd.DataFrame, projector: Projector) -> None:
        named = places[places["name"].notna()]
        self._kinds: dict[str, tuple[cKDTree, np.ndarray] | None] = {}
        for kind, cats in config.AMENITY_CATEGORIES.items():
            sub = named[named["category"].isin(cats)]
            if len(sub) == 0:
                self._kinds[kind] = None
                continue
            x, y = projector.to_xy(sub["lon"].to_numpy(), sub["lat"].to_numpy())
            self._kinds[kind] = (cKDTree(np.column_stack([x, y])), sub["name"].to_numpy(dtype=object))

    def near(self, x: float, y: float) -> dict[str, Amenity | None]:
        out: dict[str, Amenity | None] = {}
        for kind, entry in self._kinds.items():
            if entry is None:
                out[kind] = None
                continue
            tree, names = entry
            dist, i = tree.query([x, y])
            out[kind] = (Amenity(str(names[i]), round(float(dist) / 1000.0, 1))
                         if dist <= config.AMENITY_RADIUS_M else None)
        return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_amenities.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add pipeline/darksky_pipeline/amenities.py pipeline/tests/test_amenities.py
git commit -m "feat(pipeline): nearest amenities per viewing point"
```

---

### Task 10: Spot assembly, JSON output, and sanity checks

**Files:**
- Create: `pipeline/darksky_pipeline/assemble.py`, `pipeline/darksky_pipeline/checks.py`, `pipeline/tests/test_assemble.py`, `pipeline/tests/test_checks.py`

**Interfaces:**
- Consumes: `spots.Candidate`, `roads.ViewingPoint`, `features.Glare`, `features.Horizon`, `amenities.Amenity`, `curated.CuratedEntry`, `darkness.sky_label/bortle/DarknessGrid`, `config.Metro`.
- Produces:
  - `assemble.access_badge(category: str, curated: CuratedEntry | None) -> "verified" | "likely" | "check_hours"`
  - `assemble.why_chips(horizon, glare, paved: bool, dark_sky_place: bool) -> list[str]`
  - `assemble.assemble_spot(candidate, vp, glare, horizon, amenities, curated) -> dict` — the **spot JSON schema** (consumed by Plan 2):
    ```
    {id, name, category, lon, lat, sqm, bortle, sky_label,
     glare: {buildings_1km, highway_m, penalty},
     horizon: {class, open_frac, closed_frac, water_frac},
     access: {badge, road_class, paved, note},
     dark_sky_place, unavailable, unavailable_reason,
     amenities: {restroom|fuel|food: {name, km} | null},
     why: [str]}
    ```
  - `assemble.build_spots_document(metro_key, release, spots, generated_at=None) -> dict` (`{schema_version: 1, metro, release, generated_at, spots}` sorted by id)
  - `assemble.write_spots_json(doc, path)` (raises `ValueError` on NaN)
  - `checks.CheckResult(name, ok, detail)`, `checks.PipelineCheckError`, `checks.run_checks(doc, grid, metro, projector, count_range) -> list[CheckResult]`, `checks.assert_checks(results)`

- [ ] **Step 1: Write the failing test `pipeline/tests/test_assemble.py`**

```python
import json
import math

import pytest
import shapely

from darksky_pipeline.amenities import Amenity
from darksky_pipeline.assemble import (access_badge, assemble_spot, build_spots_document, why_chips,
                                       write_spots_json)
from darksky_pipeline.curated import CuratedEntry
from darksky_pipeline.features import Glare, Horizon
from darksky_pipeline.roads import ViewingPoint
from darksky_pipeline.spots import Candidate

CAND = Candidate("pl_x", "Lake X", "park", -84.25, 41.83, shapely.Point(0, 0).buffer(10), "place+polygon")
VP = ViewingPoint(0.0, 0.0, -84.2501234567, 41.8301234567, 21.6234, "tertiary", True)
GLARE = Glare(5, 12_000.0, 0.009)
HORIZON = Horizon("open", 0.95, 0.0, 0.45)
AMEN = {"restroom": None, "fuel": Amenity("Fuel", 3.4), "food": None}


def test_access_badge_priority():
    assert access_badge("park", CuratedEntry(id="a", verified=True)) == "verified"
    assert access_badge("campground", None) == "likely"
    assert access_badge("campground", CuratedEntry(id="a")) == "likely"
    assert access_badge("park", None) == "check_hours"


def test_why_chips():
    assert why_chips(HORIZON, GLARE, True, True) == ["Open lake horizon", "Low glare", "Paved access", "Dark Sky Place"]
    assert why_chips(Horizon("open", 0.9, 0.0, 0.0), Glare(500, None, 0.7), False, False) == ["Open horizon"]
    assert why_chips(Horizon("enclosed", 0.0, 1.0, 0.0), GLARE, False, False) == ["Low glare"]


def test_assemble_spot_schema_and_rounding():
    s = assemble_spot(CAND, VP, GLARE, HORIZON, AMEN, CuratedEntry(id="pl_x", verified=True, dark_sky_place=True,
                                                                     access_note="Open 24h"))
    assert s["id"] == "pl_x" and s["name"] == "Lake X" and s["category"] == "park"
    assert s["lon"] == -84.250123 and s["lat"] == 41.830123
    assert s["sqm"] == 21.62 and s["bortle"] == 4 and s["sky_label"] == "Milky Way vivid"
    assert s["glare"] == {"buildings_1km": 5, "highway_m": 12000.0, "penalty": 0.009}
    assert s["horizon"] == {"class": "open", "open_frac": 0.95, "closed_frac": 0.0, "water_frac": 0.45}
    assert s["access"] == {"badge": "verified", "road_class": "tertiary", "paved": True, "note": "Open 24h"}
    assert s["dark_sky_place"] is True and s["unavailable"] is False and s["unavailable_reason"] is None
    assert s["amenities"] == {"restroom": None, "fuel": {"name": "Fuel", "km": 3.4}, "food": None}
    assert "Dark Sky Place" in s["why"]


def test_unavailable_curated_spot_is_kept_and_flagged():
    s = assemble_spot(CAND, VP, GLARE, HORIZON, AMEN,
                      CuratedEntry(id="pl_x", unavailable=True, unavailable_reason="Closed for repairs"))
    assert s["unavailable"] is True and s["unavailable_reason"] == "Closed for repairs"


def test_document_sorted_and_written(tmp_path):
    a = assemble_spot(CAND, VP, GLARE, HORIZON, AMEN, None)
    b = {**a, "id": "pl_a"}
    doc = build_spots_document("se_mi", "R1", [a, b], generated_at="2026-10-15T00:00:00Z")
    assert [s["id"] for s in doc["spots"]] == ["pl_a", "pl_x"]
    assert doc["schema_version"] == 1 and doc["metro"] == "se_mi" and doc["release"] == "R1"
    path = tmp_path / "spots.json"
    write_spots_json(doc, path)
    assert json.loads(path.read_text(encoding="utf-8")) == doc


def test_write_rejects_nan(tmp_path):
    doc = build_spots_document("se_mi", "R1", [{"id": "x", "sqm": math.nan}], generated_at="t")
    with pytest.raises(ValueError):
        write_spots_json(doc, tmp_path / "bad.json")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_assemble.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.assemble'`.

- [ ] **Step 3: Write `pipeline/darksky_pipeline/assemble.py`**

```python
"""Turn computed features into spot records and the spots JSON document."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .amenities import Amenity
from .curated import CuratedEntry
from .darkness import bortle, sky_label
from .features import Glare, Horizon
from .roads import ViewingPoint
from .spots import Candidate

SCHEMA_VERSION = 1


def access_badge(category: str, curated: CuratedEntry | None) -> str:
    if curated is not None and curated.verified:
        return "verified"
    if category in config.LIKELY_CATEGORIES:
        return "likely"
    return "check_hours"


def why_chips(horizon: Horizon, glare: Glare, paved: bool, dark_sky_place: bool) -> list[str]:
    chips: list[str] = []
    if horizon.cls == "open":
        chips.append("Open lake horizon" if horizon.water_frac >= config.LAKE_CHIP_MIN_WATER else "Open horizon")
    if glare.penalty < config.LOW_GLARE_MAX:
        chips.append("Low glare")
    if paved:
        chips.append("Paved access")
    if dark_sky_place:
        chips.append("Dark Sky Place")
    return chips


def _amenity(a: Amenity | None) -> dict | None:
    return None if a is None else {"name": a.name, "km": a.km}


def assemble_spot(c: Candidate, vp: ViewingPoint, glare: Glare, horizon: Horizon,
                  amenities: dict[str, Amenity | None], curated: CuratedEntry | None) -> dict:
    dark_sky = bool(curated and curated.dark_sky_place)
    return {
        "id": c.id,
        "name": c.name,
        "category": c.category,
        "lon": round(vp.lon, 6),
        "lat": round(vp.lat, 6),
        "sqm": round(vp.sqm, 2),
        "bortle": bortle(vp.sqm),
        "sky_label": sky_label(vp.sqm),
        "glare": {"buildings_1km": glare.buildings_1km,
                  "highway_m": None if glare.highway_m is None else round(glare.highway_m, 0),
                  "penalty": glare.penalty},
        "horizon": {"class": horizon.cls, "open_frac": round(horizon.open_frac, 2),
                    "closed_frac": round(horizon.closed_frac, 2), "water_frac": round(horizon.water_frac, 2)},
        "access": {"badge": access_badge(c.category, curated), "road_class": vp.road_class,
                   "paved": vp.paved, "note": curated.access_note if curated else None},
        "dark_sky_place": dark_sky,
        "unavailable": bool(curated and curated.unavailable),
        "unavailable_reason": curated.unavailable_reason if curated and curated.unavailable else None,
        "amenities": {k: _amenity(v) for k, v in amenities.items()},
        "why": why_chips(horizon, glare, vp.paved, dark_sky),
    }


def build_spots_document(metro_key: str, release: str, spots: list[dict], generated_at: str | None = None) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "metro": metro_key,
        "release": release,
        "generated_at": generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "spots": sorted(spots, key=lambda s: s["id"]),
    }


def write_spots_json(doc: dict, path: Path) -> None:
    text = json.dumps(doc, allow_nan=False, ensure_ascii=False, separators=(",", ":"))
    Path(path).write_text(text, encoding="utf-8")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_assemble.py -v`
Expected: 6 passed.

- [ ] **Step 5: Write the failing test `pipeline/tests/test_checks.py`**

```python
import pytest

from darksky_pipeline.checks import PipelineCheckError, assert_checks, run_checks
from darksky_pipeline.config import Metro
from overture_fixture import CITY, REGION_BBOX, TEST_EPSG

METRO = Metro("test", "Test", REGION_BBOX, TEST_EPSG, CITY, "Testville")


def spot(i, lon=-84.25, lat=41.83, sqm=21.6, badge="check_hours"):
    return {"id": i, "lon": lon, "lat": lat, "sqm": sqm, "access": {"badge": badge}}


def by_name(results):
    return {r.name: r for r in results}


def test_good_document_passes(darkness_grid, projector):
    doc = {"spots": [spot("a", badge="verified"), spot("b"), spot("c", sqm=17.0)]}
    results = run_checks(doc, darkness_grid, METRO, projector, (1, 10))
    assert all(r.ok for r in results), [r for r in results if not r.ok]
    assert_checks(results)


def test_failures_are_reported(darkness_grid, projector):
    doc = {"spots": [spot("a", lon=-90.0), spot("a", sqm=float("nan")), spot("b", sqm=17.0, badge="verified")]}
    r = by_name(run_checks(doc, darkness_grid, METRO, projector, (5, 10)))
    assert not r["spot_count"].ok
    assert not r["within_region"].ok
    assert not r["unique_ids"].ok
    assert not r["finite_sqm"].ok
    assert not r["verified_darker_than_home"].ok
    with pytest.raises(PipelineCheckError, match="spot_count"):
        assert_checks(list(r.values()))


def test_bright_top_spots_fail(darkness_grid, projector):
    doc = {"spots": [spot(str(i), sqm=18.0) for i in range(12)]}
    assert not by_name(run_checks(doc, darkness_grid, METRO, projector, (1, 100)))["top_spots_dark"].ok


def test_no_verified_spots_is_ok(darkness_grid, projector):
    doc = {"spots": [spot("a")]}
    assert by_name(run_checks(doc, darkness_grid, METRO, projector, (1, 10)))["verified_darker_than_home"].ok
```

- [ ] **Step 6: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_checks.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.checks'`.

- [ ] **Step 7: Write `pipeline/darksky_pipeline/checks.py`**

```python
"""Sanity checks over a finished spots document."""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass

import numpy as np

from . import config
from .config import Metro
from .darkness import DarknessGrid
from .geo import Projector


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str


class PipelineCheckError(RuntimeError):
    pass


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and math.isfinite(v)


def run_checks(doc: dict, grid: DarknessGrid, metro: Metro, projector: Projector,
               count_range: tuple[int, int]) -> list[CheckResult]:
    spots = doc["spots"]
    out: list[CheckResult] = []

    lo, hi = count_range
    out.append(CheckResult("spot_count", lo <= len(spots) <= hi, f"{len(spots)} spots (expected {lo}-{hi})"))

    w, s, e, n = metro.bbox
    outside = [sp["id"] for sp in spots if not (w <= sp["lon"] <= e and s <= sp["lat"] <= n)]
    out.append(CheckResult("within_region", not outside, f"outside region: {outside[:5]}"))

    dups = sorted(i for i, c in Counter(sp["id"] for sp in spots).items() if c > 1)
    out.append(CheckResult("unique_ids", not dups, f"duplicate ids: {dups[:5]}"))

    bad = [sp["id"] for sp in spots if not _finite(sp["sqm"])]
    out.append(CheckResult("finite_sqm", not bad, f"non-finite sqm: {bad[:5]}"))

    darkest = sorted((sp["sqm"] for sp in spots if _finite(sp["sqm"])), reverse=True)[:10]
    med = float(np.median(darkest)) if darkest else math.nan
    out.append(CheckResult("top_spots_dark", bool(darkest) and med >= config.TOP_SPOTS_MIN_MEDIAN_SQM,
                           f"median sqm of darkest {len(darkest)}: {med:.2f}"))

    home = float(grid.sample(*projector.to_xy(*metro.reference_home))[0])
    verified = [sp for sp in spots if sp["access"]["badge"] == "verified"]
    too_bright = [sp["id"] for sp in verified
                  if not (_finite(sp["sqm"]) and sp["sqm"] > home + config.VERIFIED_MIN_GAIN_MAG)]
    detail = f"home {metro.reference_home_label} sqm {home:.2f}; {len(verified)} verified"
    if too_bright:
        detail += f"; not darker than home: {too_bright[:5]}"
    out.append(CheckResult("verified_darker_than_home", math.isfinite(home) and not too_bright, detail))
    return out


def assert_checks(results: list[CheckResult]) -> None:
    failed = [r for r in results if not r.ok]
    if failed:
        raise PipelineCheckError("; ".join(f"{r.name}: {r.detail}" for r in failed))
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_assemble.py tests/test_checks.py -v`
Expected: 10 passed.

- [ ] **Step 9: Commit**

```bash
git add pipeline/darksky_pipeline/assemble.py pipeline/darksky_pipeline/checks.py pipeline/tests/test_assemble.py pipeline/tests/test_checks.py
git commit -m "feat(pipeline): assemble spot records, write JSON, sanity checks"
```

---

### Task 11: Search index

**Files:**
- Create: `pipeline/darksky_pipeline/search_index.py`, `pipeline/tests/test_search_index.py`

**Interfaces:**
- Consumes: `extract` frames `places`, `addresses`, `division_areas`; `util.as_list`, `util.wkb_to_geoms`.
- Produces:
  - `search_index.format_address(number, street, address_levels) -> str | None`
  - `search_index.search_rows(places, addresses, divisions) -> list[tuple[name: str, kind: str, lat: float, lon: float]]` — kinds: `"place"`, `"address"`, division subtype (e.g. `"locality"`)
  - `search_index.build_search_index(rows, path)` — SQLite FTS5 table `search(name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED)`; overwrites existing file
  - `search_index.query(path, text, limit=10) -> list[dict(name, kind, lat, lon)]` (Plan 2 reuses this query shape)

- [ ] **Step 1: Write the failing test `pipeline/tests/test_search_index.py`**

```python
import pytest

from darksky_pipeline.search_index import build_search_index, format_address, query, search_rows


@pytest.fixture(scope="module")
def index_path(overture_frames, tmp_path_factory):
    path = tmp_path_factory.mktemp("search") / "search.sqlite"
    rows = search_rows(overture_frames["places"], overture_frames["addresses"], overture_frames["division_areas"])
    build_search_index(rows, path)
    return path


def test_format_address():
    assert format_address("101", "Main St", [{"value": "MI"}, {"value": "Testville"}]) == "101 Main St, Testville"
    assert format_address(None, "Main St", None) == "Main St"
    assert format_address("5", None, None) is None


def test_rows_include_all_kinds(overture_frames):
    rows = search_rows(overture_frames["places"], overture_frames["addresses"], overture_frames["division_areas"])
    kinds = {k for _, k, _, _ in rows}
    assert kinds == {"place", "address", "locality"}
    names = {n for n, _, _, _ in rows}
    assert "Sketchy Park" not in names  # confidence 0.3 < 0.5
    assert None not in names


def test_query_address_prefix(index_path):
    hits = query(index_path, "101 mai")
    assert hits[0]["name"] == "101 Main St, Testville" and hits[0]["kind"] == "address"
    assert abs(hits[0]["lon"] + 84.051) < 1e-6


def test_query_prefix_matches_multiple(index_path):
    names = {h["name"] for h in query(index_path, "hud")}
    assert {"Lake Hudson Recreation Area", "Hudson Fuel"} <= names


def test_query_division(index_path):
    hits = query(index_path, "Testville")
    assert any(h["kind"] == "locality" for h in hits)


@pytest.mark.parametrize("text", ["O'Neill", '"quoted"', "Café*", "   ", "!!!", "AND OR NOT"])
def test_query_handles_punctuation(index_path, text):
    assert isinstance(query(index_path, text), list)


def test_rebuild_overwrites(tmp_path):
    path = tmp_path / "s.sqlite"
    build_search_index([("Alpha", "place", 1.0, 2.0)], path)
    build_search_index([("Beta", "place", 1.0, 2.0)], path)
    assert query(path, "alpha") == [] and query(path, "beta")[0]["name"] == "Beta"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_search_index.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.search_index'`.

- [ ] **Step 3: Write `pipeline/darksky_pipeline/search_index.py`**

```python
"""SQLite FTS5 index for start-point search (places, addresses, areas)."""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Iterable

import pandas as pd

from .util import as_list, wkb_to_geoms

MIN_SEARCH_PLACE_CONFIDENCE = 0.5
DIVISION_SUBTYPES = frozenset({"locality", "localadmin", "county", "neighborhood", "macrohood", "microhood"})

Row = tuple[str, str, float, float]  # name, kind, lat, lon


def format_address(number, street, address_levels) -> str | None:
    if not isinstance(street, str) or not street.strip():
        return None
    head = f"{number.strip()} {street.strip()}" if isinstance(number, str) and number.strip() else street.strip()
    levels = [lv.get("value") for lv in as_list(address_levels) if isinstance(lv, dict) and lv.get("value")]
    return f"{head}, {levels[-1]}" if levels else head


def search_rows(places: pd.DataFrame, addresses: pd.DataFrame, divisions: pd.DataFrame) -> list[Row]:
    rows: list[Row] = []
    p = places[places["name"].notna() & (places["confidence"] >= MIN_SEARCH_PLACE_CONFIDENCE)]
    rows += [(str(n), "place", float(lat), float(lon)) for n, lat, lon in p[["name", "lat", "lon"]].itertuples(index=False)]
    for number, street, levels, lat, lon in addresses[["number", "street", "address_levels", "lat", "lon"]].itertuples(index=False):
        text = format_address(number, street, levels)
        if text:
            rows.append((text, "address", float(lat), float(lon)))
    d = divisions[divisions["name"].notna() & divisions["subtype"].isin(DIVISION_SUBTYPES)].reset_index(drop=True)
    if len(d):
        for (name, subtype), g in zip(d[["name", "subtype"]].itertuples(index=False), wkb_to_geoms(d["wkb"])):
            rp = g.representative_point()
            rows.append((str(name), str(subtype), float(rp.y), float(rp.x)))
    return rows


def build_search_index(rows: Iterable[Row], path: Path) -> None:
    path = Path(path)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    try:
        con.execute("CREATE VIRTUAL TABLE search USING fts5("
                    "name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED, "
                    "tokenize='unicode61 remove_diacritics 2')")
        con.executemany("INSERT INTO search (name, kind, lat, lon) VALUES (?, ?, ?, ?)", rows)
        con.commit()
    finally:
        con.close()


def query(path: Path, text: str, limit: int = 10) -> list[dict]:
    tokens = re.findall(r"\w+", text.lower())
    if not tokens:
        return []
    match = " ".join(f'"{t}"*' for t in tokens)
    con = sqlite3.connect(path)
    try:
        cur = con.execute("SELECT name, kind, lat, lon FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?",
                          (match, limit))
        return [{"name": n, "kind": k, "lat": float(la), "lon": float(lo)} for n, k, la, lo in cur.fetchall()]
    finally:
        con.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_search_index.py -v`
Expected: all passed (14 incl. parametrized).

- [ ] **Step 5: Commit**

```bash
git add pipeline/darksky_pipeline/search_index.py pipeline/tests/test_search_index.py
git commit -m "feat(pipeline): FTS5 search index for start points"
```

---

### Task 12: Tiles (basemap extract + light-pollution raster)

**Files:**
- Create: `pipeline/darksky_pipeline/tiles.py`, `pipeline/tests/test_tiles.py`
- Modify: `pipeline/darksky_pipeline/config.py` (append tile constants)

**Interfaces:**
- Consumes: `darkness.DarknessGrid`, `config.NATURAL_SQM`.
- Produces:
  - config: `OVERTURE_TILES_URL`, `OVERTURE_TILE_THEMES`, `LIGHTPOLLUTION_BRIGHT_SQM`
  - `tiles.basemap_extract_commands(tiles_release, bbox, out_dir, metro_key, maxzoom=14, url_template=OVERTURE_TILES_URL) -> list[list[str]]`
  - `tiles.sqm_to_rgba(sqm: np.ndarray) -> np.ndarray[uint8] (..., 4)`
  - `tiles.write_lightpollution_tif(grid, path)`
  - `tiles.lightpollution_pmtiles_command(tif, out, minzoom=6, maxzoom=11) -> list[str]`
  - `tiles.run_commands(cmds)` (subprocess, check=True)

- [ ] **Step 1: Append to `pipeline/darksky_pipeline/config.py`**

```python

# --- Tiles --------------------------------------------------------------------
# Overture publishes per-theme PMTiles; confirm the URL for the pinned release in Task 14.
OVERTURE_TILES_URL = "https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/{release}/{theme}.pmtiles"
OVERTURE_TILE_THEMES = ("base", "transportation", "buildings", "divisions")
LIGHTPOLLUTION_BRIGHT_SQM = 17.0  # SQM rendered at full brightness in the overlay
```

- [ ] **Step 2: Write the failing test `pipeline/tests/test_tiles.py`**

```python
from pathlib import Path

import numpy as np
import rasterio

from darksky_pipeline.tiles import (basemap_extract_commands, lightpollution_pmtiles_command, sqm_to_rgba,
                                    write_lightpollution_tif)


def test_basemap_commands(tmp_path):
    cmds = basemap_extract_commands("2026-09-17", (-84.6, 41.65, -82.4, 44.1), tmp_path, "se_mi")
    assert len(cmds) == 4
    first = cmds[0]
    assert first[:2] == ["pmtiles", "extract"]
    assert first[2].endswith("/2026-09-17/base.pmtiles")
    assert first[3] == str(tmp_path / "basemap_se_mi_base.pmtiles")
    assert "--bbox=-84.6,41.65,-82.4,44.1" in first and "--maxzoom=14" in first


def test_sqm_to_rgba_endpoints_and_monotonic_alpha():
    rgba = sqm_to_rgba(np.array([22.0, 21.0, 19.0, 17.0, 15.0, np.nan]))
    assert rgba.dtype == np.uint8 and rgba.shape == (6, 4)
    assert tuple(rgba[0]) == (0, 0, 0, 0)
    assert tuple(rgba[3]) == (255, 244, 214, 220) == tuple(rgba[4])
    assert rgba[0, 3] < rgba[1, 3] < rgba[2, 3] < rgba[3, 3]
    assert tuple(rgba[5]) == (0, 0, 0, 0)


def test_write_lightpollution_tif(darkness_grid, tmp_path):
    path = tmp_path / "lp.tif"
    write_lightpollution_tif(darkness_grid, path)
    with rasterio.open(path) as src:
        assert src.count == 4 and src.dtypes[0] == "uint8"
        assert src.crs.to_epsg() == darkness_grid.epsg
        assert (src.height, src.width) == darkness_grid.sqm.shape


def test_lightpollution_command():
    cmd = lightpollution_pmtiles_command(Path("a.tif"), Path("b.pmtiles"))
    assert cmd == ["rio", "pmtiles", "a.tif", "b.pmtiles", "--format", "PNG", "--zoom-levels", "6..11", "--rgba"]
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_tiles.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.tiles'`.

- [ ] **Step 4: Write `pipeline/darksky_pipeline/tiles.py`**

```python
"""Basemap PMTiles extraction (Overture) and light-pollution overlay raster."""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import ColorInterp
from rasterio.transform import from_origin

from . import config
from .config import BBox
from .darkness import DarknessGrid

# t (0 = natural sky, 1 = city) -> RGBA. Indigo/violet/amber palette from the spec.
_COLOR_STOPS = np.array([
    [0.0, 0, 0, 0, 0],
    [0.2, 58, 47, 110, 90],
    [0.5, 165, 139, 224, 140],
    [0.8, 245, 201, 107, 190],
    [1.0, 255, 244, 214, 220],
], dtype=np.float64)


def basemap_extract_commands(tiles_release: str, bbox: BBox, out_dir: Path, metro_key: str, maxzoom: int = 14,
                             url_template: str = config.OVERTURE_TILES_URL) -> list[list[str]]:
    w, s, e, n = bbox
    return [["pmtiles", "extract", url_template.format(release=tiles_release, theme=theme),
             str(Path(out_dir) / f"basemap_{metro_key}_{theme}.pmtiles"),
             f"--bbox={w},{s},{e},{n}", f"--maxzoom={maxzoom}"]
            for theme in config.OVERTURE_TILE_THEMES]


def sqm_to_rgba(sqm: np.ndarray) -> np.ndarray:
    sqm = np.asarray(sqm, dtype=np.float64)
    span = config.NATURAL_SQM - config.LIGHTPOLLUTION_BRIGHT_SQM
    t = np.clip((config.NATURAL_SQM - np.nan_to_num(sqm, nan=config.NATURAL_SQM)) / span, 0.0, 1.0)
    out = np.empty(sqm.shape + (4,), dtype=np.uint8)
    for ch in range(4):
        out[..., ch] = np.round(np.interp(t, _COLOR_STOPS[:, 0], _COLOR_STOPS[:, ch + 1])).astype(np.uint8)
    return out


def write_lightpollution_tif(grid: DarknessGrid, path: Path) -> None:
    rgba = sqm_to_rgba(grid.sqm)
    h, w = grid.sqm.shape
    with rasterio.open(path, "w", driver="GTiff", height=h, width=w, count=4, dtype="uint8",
                       crs=CRS.from_epsg(grid.epsg), transform=from_origin(grid.x0, grid.y0, grid.res, grid.res),
                       photometric="RGB") as dst:
        dst.write(np.moveaxis(rgba, -1, 0))
        dst.colorinterp = [ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha]


def lightpollution_pmtiles_command(tif: Path, out: Path, minzoom: int = 6, maxzoom: int = 11) -> list[str]:
    return ["rio", "pmtiles", str(tif), str(out), "--format", "PNG", "--zoom-levels", f"{minzoom}..{maxzoom}", "--rgba"]


def run_commands(cmds: list[list[str]]) -> None:
    for cmd in cmds:
        subprocess.run(cmd, check=True)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_tiles.py -v`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add pipeline/darksky_pipeline/tiles.py pipeline/darksky_pipeline/config.py pipeline/tests/test_tiles.py
git commit -m "feat(pipeline): basemap extract commands and light-pollution raster"
```

---

### Task 13: Build orchestration CLI, golden test, README

**Files:**
- Create: `pipeline/darksky_pipeline/build.py`, `pipeline/tests/test_build.py`, `pipeline/README.md`
- Modify: `pipeline/darksky_pipeline/probe.py` (add `sky` subcommand + `sky_at` function), `pipeline/tests/test_probe.py` (add test)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `build.BuildSummary` (dataclass: `metro: str, spots: int, dropped_no_access: list[str], curated_unknown_ids: list[str], checks: list[CheckResult], out_dir: Path`)
  - `build.run_build(metro, release, viirs_path, out_dir, curated_path=None, source_root=OVERTURE_S3_ROOT, cache_dir=None, count_range=None, skip_tiles=False, strict=True, tiles_release=None) -> BuildSummary`
  - `build.main(argv)` — `python -m darksky_pipeline.build --metro se_mi --release R --viirs path.tif [--out out] [--cache data/raw] [--curated curated/se_mi.yaml] [--skip-tiles] [--no-strict] [--tiles-release R]`; writes into `<out>/<metro>/`
  - `probe.sky_at(npz_path, points: list[tuple[str, float, float]]) -> list[tuple[str, float, str]]` (name, sqm, label)

- [ ] **Step 1: Write the failing golden test `pipeline/tests/test_build.py`**

```python
import json

import pytest

from darksky_pipeline.build import run_build
from darksky_pipeline.config import Metro
from darksky_pipeline.search_index import query
from overture_fixture import CITY, REGION_BBOX, RELEASE, TEST_EPSG

METRO = Metro("test", "Test", REGION_BBOX, TEST_EPSG, CITY, "Testville")


@pytest.fixture(scope="module")
def built(overture_root, viirs_path, tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    curated = out / "curated.yaml"
    curated.write_text(
        "spots:\n"
        "  - id: pl_hudson\n    verified: true\n    dark_sky_place: true\n    access_note: Open 24h\n"
        "  - id: pl_ghost\n    verified: true\n",
        encoding="utf-8")
    summary = run_build(METRO, RELEASE, viirs_path, out, curated_path=curated,
                        source_root=overture_root.as_posix(), count_range=(1, 10), skip_tiles=True)
    doc = json.loads((out / "spots_test.json").read_text(encoding="utf-8"))
    return summary, {s["id"]: s for s in doc["spots"]}, out


def test_outputs_exist(built):
    _, _, out = built
    for name in ("spots_test.json", "darkness_test.npz", "search_test.sqlite", "lightpollution_test.tif"):
        assert (out / name).exists(), name


def test_summary(built):
    summary, spots, _ = built
    assert summary.spots == 3
    assert summary.dropped_no_access == ["lu_woods"]
    assert summary.curated_unknown_ids == ["pl_ghost"]
    assert all(c.ok for c in summary.checks)


def test_spot_set(built):
    _, spots, _ = built
    assert sorted(spots) == ["pl_camp", "pl_city", "pl_hudson"]


def test_hudson(built):
    _, spots, _ = built
    h = spots["pl_hudson"]
    assert h["access"] == {"badge": "verified", "road_class": "tertiary", "paved": True, "note": "Open 24h"}
    assert h["dark_sky_place"] is True
    assert h["horizon"]["class"] == "open"
    assert h["why"] == ["Open lake horizon", "Low glare", "Paved access", "Dark Sky Place"]
    assert h["sky_label"] in ("Milky Way vivid", "Milky Way visible")
    assert h["amenities"]["fuel"]["name"] == "Hudson Fuel"


def test_camp_and_city(built):
    _, spots, _ = built
    camp, city = spots["pl_camp"], spots["pl_city"]
    assert camp["access"]["badge"] == "likely" and camp["access"]["paved"] is False
    assert camp["horizon"]["class"] == "enclosed"
    assert city["access"]["badge"] == "check_hours"
    assert city["glare"]["penalty"] >= 0.5
    assert spots["pl_hudson"]["sqm"] - city["sqm"] > 2.0


def test_search_index_built(built):
    _, _, out = built
    assert query(out / "search_test.sqlite", "main st")[0]["kind"] == "address"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_build.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'darksky_pipeline.build'`.

- [ ] **Step 3: Write `pipeline/darksky_pipeline/build.py`**

```python
"""Run the whole pipeline for one metro.

python -m darksky_pipeline.build --metro se_mi --release <R> --viirs <path.tif>
"""
from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass, field
from pathlib import Path

from . import config
from .amenities import AmenityFinder
from .assemble import assemble_spot, build_spots_document, write_spots_json
from .checks import CheckResult, assert_checks, run_checks
from .config import METROS, OVERTURE_S3_ROOT, Metro
from .curated import load_curated
from .darkness import build_darkness_grid
from .extract import THEMES, connect, extract_theme
from .features import GlareModel, HorizonModel, building_points
from .geo import Projector
from .roads import build_road_network, find_viewing_point, parking_points
from .search_index import build_search_index, search_rows
from .spots import build_candidates
from .tiles import (basemap_extract_commands, lightpollution_pmtiles_command, run_commands,
                    write_lightpollution_tif)

log = logging.getLogger("darksky_pipeline")


@dataclass
class BuildSummary:
    metro: str
    spots: int
    dropped_no_access: list[str] = field(default_factory=list)
    curated_unknown_ids: list[str] = field(default_factory=list)
    checks: list[CheckResult] = field(default_factory=list)
    out_dir: Path | None = None


def run_build(metro: Metro, release: str, viirs_path: Path, out_dir: Path, curated_path: Path | None = None,
              source_root: str = OVERTURE_S3_ROOT, cache_dir: Path | None = None,
              count_range: tuple[int, int] | None = None, skip_tiles: bool = False, strict: bool = True,
              tiles_release: str | None = None) -> BuildSummary:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    projector = Projector(metro.utm_epsg)

    log.info("extracting Overture %s for %s", release, metro.key)
    con = connect()
    frames = {k: extract_theme(con, k, metro.bbox, release, source_root=source_root, cache_dir=cache_dir)
              for k in THEMES}
    con.close()

    log.info("building darkness grid")
    grid = build_darkness_grid(Path(viirs_path), metro.bbox, metro.utm_epsg)
    grid.save(out_dir / f"darkness_{metro.key}.npz")

    curated = load_curated(curated_path) if curated_path else {}
    candidates = build_candidates(frames["places"], frames["land_use"], projector)
    log.info("%d candidate spots", len(candidates))

    roads = build_road_network(frames["segments"], projector)
    parking_xy = parking_points(frames["places"], projector)
    glare_model = GlareModel(building_points(frames["buildings"], projector), roads)
    horizon_model = HorizonModel(frames["land_cover"], frames["water"], projector)
    amenity_finder = AmenityFinder(frames["places"], projector)

    spots, dropped = [], []
    for c in candidates:
        vp = find_viewing_point(c.area, roads, grid, projector, parking_xy)
        if vp is None:
            dropped.append(c.id)
            continue
        spots.append(assemble_spot(c, vp, glare_model.at(vp.x, vp.y), horizon_model.at(vp.x, vp.y),
                                   amenity_finder.near(vp.x, vp.y), curated.get(c.id)))
    log.info("%d spots, %d dropped (no drivable access)", len(spots), len(dropped))

    doc = build_spots_document(metro.key, release, spots)
    write_spots_json(doc, out_dir / f"spots_{metro.key}.json")

    rows = search_rows(frames["places"], frames["addresses"], frames["division_areas"])
    build_search_index(rows, out_dir / f"search_{metro.key}.sqlite")
    log.info("search index: %d rows", len(rows))

    tif = out_dir / f"lightpollution_{metro.key}.tif"
    write_lightpollution_tif(grid, tif)
    if not skip_tiles:
        run_commands([lightpollution_pmtiles_command(tif, out_dir / f"lightpollution_{metro.key}.pmtiles"),
                      *basemap_extract_commands(tiles_release or release.split(".")[0], metro.bbox,
                                                out_dir, metro.key)])

    results = run_checks(doc, grid, metro, projector, count_range or config.SPOT_COUNT_RANGE[metro.key])
    for r in results:
        log.info("check %-26s %s  %s", r.name, "OK  " if r.ok else "FAIL", r.detail)
    summary = BuildSummary(metro=metro.key, spots=len(spots), dropped_no_access=sorted(dropped),
                           curated_unknown_ids=sorted(set(curated) - {c.id for c in candidates}),
                           checks=results, out_dir=out_dir)
    if summary.curated_unknown_ids:
        log.warning("curated ids not found in candidates: %s", summary.curated_unknown_ids)
    if strict:
        assert_checks(results)
    return summary


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="darksky_pipeline.build")
    ap.add_argument("--metro", choices=sorted(METROS), required=True)
    ap.add_argument("--release", required=True, help="Overture release, e.g. 2026-09-17.0")
    ap.add_argument("--viirs", required=True, help="VIIRS annual radiance GeoTIFF (EPSG:4326)")
    ap.add_argument("--out", default="out")
    ap.add_argument("--cache", default="data/raw")
    ap.add_argument("--curated", default=None, help="default: curated/<metro>.yaml")
    ap.add_argument("--skip-tiles", action="store_true")
    ap.add_argument("--no-strict", action="store_true", help="report failed checks without failing")
    ap.add_argument("--tiles-release", default=None, help="Overture tiles release folder if it differs")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    metro = METROS[args.metro]
    summary = run_build(metro, args.release, Path(args.viirs), Path(args.out) / metro.key,
                        curated_path=Path(args.curated or f"curated/{metro.key}.yaml"),
                        cache_dir=Path(args.cache) / metro.key / args.release,
                        skip_tiles=args.skip_tiles, strict=not args.no_strict, tiles_release=args.tiles_release)
    print(f"{summary.metro}: {summary.spots} spots -> {summary.out_dir}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/Scripts/python -m pytest tests/test_build.py -v`
Expected: 6 passed.

- [ ] **Step 5: Add the `sky` probe — append test to `pipeline/tests/test_probe.py`**

```python
def test_sky_at_reads_grid(darkness_grid, tmp_path):
    from darksky_pipeline.probe import sky_at
    from overture_fixture import CITY, HUDSON

    path = tmp_path / "g.npz"
    darkness_grid.save(path)
    rows = dict((name, (sqm, label)) for name, sqm, label in
                sky_at(path, [("city", *CITY), ("hudson", *HUDSON)]))
    assert rows["hudson"][0] - rows["city"][0] > 2.0
    assert rows["city"][1] == "Milky Way not visible"
```

- [ ] **Step 6: Run it to verify it fails**

Run: `.venv/Scripts/python -m pytest tests/test_probe.py::test_sky_at_reads_grid -v`
Expected: FAIL with `ImportError: cannot import name 'sky_at'`.

- [ ] **Step 7: Modify `pipeline/darksky_pipeline/probe.py`**

Add imports after the existing imports:

```python
from .darkness import DarknessGrid, sky_label
from .geo import Projector
```

Add this function above `main`:

```python
def sky_at(npz_path: Path, points: list[tuple[str, float, float]]) -> list[tuple[str, float, str]]:
    grid = DarknessGrid.load(Path(npz_path))
    projector = Projector(grid.epsg)
    out = []
    for name, lon, lat in points:
        sqm = float(grid.sample(*projector.to_xy(lon, lat))[0])
        out.append((name, round(sqm, 2), sky_label(sqm)))
    return out
```

In `main`, after `sub.add_parser("releases")`, add:

```python
    sp_sky = sub.add_parser("sky")
    sp_sky.add_argument("--npz", required=True)
    sp_sky.add_argument("--point", action="append", required=True, help='"Name,lon,lat" (repeatable)')
```

and replace

```python
    con = connect()
    if args.cmd == "releases":
```

with

```python
    if args.cmd == "sky":
        pts = [(p.split(",")[0], float(p.split(",")[1]), float(p.split(",")[2])) for p in args.point]
        for name, sqm, label in sky_at(Path(args.npz), pts):
            print(f"{name:30s} {sqm:6.2f}  {label}")
        return
    con = connect()
    if args.cmd == "releases":
```

- [ ] **Step 8: Write `pipeline/README.md`**

````markdown
# Dark Sky Finder — data pipeline

Turns a pinned Overture release + a VIIRS night-lights GeoTIFF into per-metro data files.

## Setup

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev,tiles]"   # macOS/Linux: .venv/bin/python
```

Also install the `pmtiles` CLI (https://github.com/protomaps/go-pmtiles/releases) and put it on PATH.

## Inputs

- **Overture release** — list available releases:
  `python -m darksky_pipeline.probe releases`
- **VIIRS** — annual VIIRS Nighttime Lights (VNL v2, "average-masked" GeoTIFF, EPSG:4326) from
  https://eogdata.mines.edu/products/vnl/ (free account required; download manually).
  Place it at `data/viirs/vnl_annual.tif`. The pipeline reads only a window around each metro.

## Run

```bash
python -m darksky_pipeline.build --metro se_mi --release <R> --viirs data/viirs/vnl_annual.tif
python -m darksky_pipeline.build --metro bay_area --release <R> --viirs data/viirs/vnl_annual.tif
```

Outputs land in `out/<metro>/`: `spots_<metro>.json`, `darkness_<metro>.npz`, `search_<metro>.sqlite`,
`lightpollution_<metro>.pmtiles`, `basemap_<metro>_<theme>.pmtiles`.
Use `--skip-tiles` for fast iterations and `--no-strict` to see failing checks without aborting.

## Tools

- `python -m darksky_pipeline.probe categories --metro se_mi --release <R>` — place categories present
- `python -m darksky_pipeline.probe find --metro se_mi --release <R> --name "Lake Hudson"` — GERS IDs for curation
- `python -m darksky_pipeline.probe sky --npz out/se_mi/darkness_se_mi.npz --point "Royal Oak,-83.1446,42.4895"`

## Curation

`curated/<metro>.yaml` — keyed by GERS ID: `verified`, `dark_sky_place`, `access_note`,
`unavailable` + `unavailable_reason`. Unknown IDs are reported after each build.

## Tests

```bash
.venv/Scripts/python -m pytest
```
````

- [ ] **Step 9: Run full test suite**

Run: `.venv/Scripts/python -m pytest -v`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add pipeline/darksky_pipeline/build.py pipeline/darksky_pipeline/probe.py pipeline/tests/test_build.py pipeline/tests/test_probe.py pipeline/README.md
git commit -m "feat(pipeline): build CLI with golden test, sky probe, README"
```

---

### Task 14: Real-data run, calibration, and curation

This task runs against real Overture and VIIRS data. Its deliverable is passing strict builds for both metros plus committed config/curation changes. Data outputs stay out of git (`pipeline/out/` is ignored).

**Files:**
- Modify: `pipeline/darksky_pipeline/config.py` (category names, `SKYGLOW_K`, `OVERTURE_TILES_URL` if needed), `pipeline/curated/se_mi.yaml`, `pipeline/curated/bay_area.yaml`

**Interfaces:**
- Consumes: all CLIs from Tasks 3, 13.
- Produces: `pipeline/out/se_mi/*` and `pipeline/out/bay_area/*` (consumed by Plans 2 and 3).

- [ ] **Step 1: Get inputs (human step)**

Ask the user to (a) create a free EOG account and download the latest VNL v2 annual average-masked GeoTIFF to `pipeline/data/viirs/vnl_annual.tif`, and (b) install the `pmtiles` CLI. Do not handle their credentials.

- [ ] **Step 2: Pin the release**

Run: `.venv/Scripts/python -m darksky_pipeline.probe releases`
Expected: a sorted list of release folders. Use the newest as `<R>` for every command below and record it in the commit message.

- [ ] **Step 3: Verify category names**

Run: `.venv/Scripts/python -m darksky_pipeline.probe categories --metro se_mi --release <R>`
Expected: category/count table. For each name in `SPOT_CATEGORIES`, `LIKELY_CATEGORIES`, `PARKING_CATEGORIES`, `AMENITY_CATEGORIES` that does not appear, replace it in `config.py` with the matching category shown (e.g. if the table shows `public_restroom` rather than `public_toilet`, use that). Re-run `.venv/Scripts/python -m pytest` (fixture categories are independent of these changes only if you keep `park`, `campground`, `boat_launch`, `parking`, `gas_station`, `restaurant`; if you remove any of those, update `tests/overture_fixture.py` to the new names in the same commit).

Also check, from the cached parquet in `data/raw/se_mi/<R>/` (e.g. `duckdb -c "SELECT subtype, class, count(*) FROM 'land_use.parquet' GROUP BY ALL ORDER BY 3 DESC"`):
- land-use `class` values inside `PARK_SUBTYPES` — extend `LAND_USE_CLASS_DENYLIST` with floodlit/closed classes (sports pitches, stadiums, etc.) under their real names;
- whether land cover contains overlapping per-zoom generalizations (cartography min/max zoom columns). If so, restrict the land-cover extract to the highest-detail band so horizon fractions are not double-counted.

- [ ] **Step 4: First non-strict build for SE MI (no tiles)**

Run: `.venv/Scripts/python -m darksky_pipeline.build --metro se_mi --release <R> --viirs data/viirs/vnl_annual.tif --skip-tiles --no-strict`
Expected: completes; prints spot count and check table. First run downloads Overture data (minutes) and caches it in `data/raw/se_mi/<R>/`.

- [ ] **Step 5: Calibrate `SKYGLOW_K`**

Run:
```
.venv/Scripts/python -m darksky_pipeline.probe sky --npz out/se_mi/darkness_se_mi.npz --point "Royal Oak,-83.1446,42.4895" --point "Detroit downtown,-83.0458,42.3314" --point "Lake Hudson,-84.25,41.83" --point "Port Crescent,-83.06,44.00"
```
Target (approximate published SQM; cross-check against lightpollutionmap.info): Detroit downtown ≈ 17.5–18.0, Royal Oak ≈ 18.2–18.8, Lake Hudson ≥ 21.2, Port Crescent ≥ 21.2. If city values are too low (too bright), increase `SKYGLOW_K`; if too high, decrease it. Rebuild with `--skip-tiles --no-strict` (Overture cache makes reruns fast) until within targets. Then check Bay Area with the same procedure after Step 8's build: San Francisco ≈ 17.0–17.8, Henry Coe (-121.55, 37.19) ≥ 21.0. Keep one `SKYGLOW_K` for both metros; if both can't be met, prefer the dark-site targets.

- [ ] **Step 6: Curate SE MI spots**

For each of: Lake Hudson Recreation Area, Port Crescent State Park, Seven Lakes State Park, Proud Lake Recreation Area, Highland Recreation Area:
Run: `.venv/Scripts/python -m darksky_pipeline.probe find --metro se_mi --release <R> --name "<name>"`
Pick the id of the row that is a spot (place in a spot category, or a park land_use polygon); confirm it is in `out/se_mi/spots_se_mi.json`. Add entries to `curated/se_mi.yaml`. Set `verified: true` only for spots with documented 24h/night access (check the park's official page). Set `dark_sky_place: true` only if the site is listed as a designated dark sky preserve/park (Lake Hudson and Port Crescent are Michigan-designated dark sky preserves — confirm on michigan.gov/dnr). Example entry shape:

```yaml
spots:
  - id: <GERS id from probe>
    label: Lake Hudson Recreation Area
    verified: true
    dark_sky_place: true
    access_note: Dark Sky Preserve, open 24h. Recreation Passport required.
```

- [ ] **Step 7: Strict SE MI build with tiles**

Confirm the tiles URL: `pmtiles show https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/<R-date>/base.pmtiles` (where `<R-date>` is `<R>` without `.0`). If it fails, find the current URL in Overture's docs (docs.overturemaps.org, "PMTiles"), update `OVERTURE_TILES_URL` (or pass `--tiles-release`), and retry.
Also confirm the rio-pmtiles flags: `rio pmtiles --help` shows `--format`, `--zoom-levels`, `--rgba`; if a flag differs, update `lightpollution_pmtiles_command` and its test in the same commit.
Run: `.venv/Scripts/python -m darksky_pipeline.build --metro se_mi --release <R> --viirs data/viirs/vnl_annual.tif`
Expected: all checks OK, no unknown curated ids, all five output kinds in `out/se_mi/`.

- [ ] **Step 8: Bay Area: build, calibrate check, curate, strict build**

Repeat Steps 4–7 for `bay_area` with spots: Henry W. Coe State Park, Pinnacles National Park, Point Reyes National Seashore, Mount Tamalpais State Park, Mount Diablo State Park. Pinnacles is an International Dark Sky Park — confirm each designation on darksky.org before setting `dark_sky_place: true`. Mount Tamalpais and Mount Diablo have gate closing hours — leave them unverified unless an official source documents night access.
Expected: strict build passes for `bay_area`.

- [ ] **Step 9: Spot-check output**

Open `out/se_mi/spots_se_mi.json`, sort by `sqm` descending, and confirm the top 10 are rural parks/campgrounds (not city parks), Lake Hudson shows `"why"` including `"Dark Sky Place"`, and no spot has `lon/lat` in a lake. Note any bad spot by GERS id and mark it `unavailable: true` with a reason in curated YAML, then rebuild.

- [ ] **Step 10: Commit**

```bash
git add pipeline/darksky_pipeline/config.py pipeline/curated pipeline/tests pipeline/darksky_pipeline/tiles.py
git commit -m "chore(pipeline): calibrate sky glow, verify categories, curate spots for release <R>"
```

---

## Self-Review Notes

- **Spec coverage (§4, §4.1, §5, §8 pipeline):** extract all 8 themes (T3); candidate spots incl. place/polygon merge (T6); curated YAML by GERS ID incl. unavailable (T5, T10); darkness w/ padding, SQM, labels, Bortle (T4); viewing point near road/parking (T7); glare (T8); horizon (T8); access badge (T10); amenities (T9); outputs spots/npz/sqlite/basemap/lightpollution (T10–T13); golden test, sanity checks, known-spot check (T10, T13, T14). OSM hours intentionally excluded per spec.
- **Deferred to Plan 2:** routing, weather, sky timing, scoring, endpoints. **Plan 3:** R2 upload, frontend, Render deploy.
````

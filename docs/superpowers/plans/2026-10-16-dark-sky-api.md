# Dark Sky Finder — Plan 2: API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A FastAPI service that, for a start point and night, returns a night verdict and ranked stargazing spots (drive time, darkness, hourly weather/moon quality, scores), plus start-point search and region metadata, built on the pipeline's outputs.

**Architecture:** Pure core modules (`grid`, `data`, `search`, `sky`, `forecast`, `routing`, `scoring`, `service`) with no web code; thin FastAPI routes in `app.py` with pydantic response models in `schemas.py`. Outbound HTTP (OpenRouteService, Open-Meteo) goes through injectable `httpx.Client`s with TTL caches and graceful fallbacks; tests use fakes or `httpx.MockTransport` and never hit the network.

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, httpx, astral 3.2, numpy, pyproj, pydantic v2, pytest.

**Spec:** `docs/superpowers/specs/2026-10-16-dark-sky-api-design.md` (binding), parent `docs/superpowers/specs/2026-10-15-dark-sky-finder-design.md` §6–§8.

## Global Constraints

- Package `darksky_api` in `api/`; Python ≥ 3.11; run commands from `api/` with `.venv/Scripts/python` (Windows) / `.venv/bin/python`.
- Data layout: `DATA_DIR/<metro>/spots_<metro>.json` (schema_version 2), `darkness_<metro>.npz` (`sqm`, `meta=[x0, y0, res, epsg]`), `search_<metro>.sqlite` (FTS5 `search(name, kind, lat, lon)`).
- Metros: `se_mi` bbox `(-84.6, 41.65, -82.4, 44.1)` tz `America/Detroit`; `bay_area` bbox `(-123.2, 36.4, -121.0, 38.6)` tz `America/Los_Angeles`.
- Env: `ORS_API_KEY` (optional → estimates), `ALLOWED_ORIGINS` (comma list), `DATA_DIR` (default `./data`). The key is never returned or logged.
- Night must be today…today+6 in the metro timezone; night = evening of that date.
- Ratings exactly `good|marginal|poor|unknown`; forecast_status `ok|partial|unavailable`; drive_status `ok|approx`; dark kind `astronomical|nautical`.
- Darker-than-home strings exactly `"about the same"` or `"~N× darker"` (× is U+00D7).
- Outbound failures never produce 5xx; error bodies are `{"error": code, ...}`; no stack traces to clients.
- Scoring constants exactly as spec §5 (copied into `config.py` in Task 2).
- Commit messages end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Start point outside both metros or in open water** — must return `out_of_coverage` (or a valid result with NaN-safe start SQM), never 500. Tests: Task 9 `test_out_of_coverage`, Task 3 `test_sample_outside_grid_is_nan`, Task 9 `test_start_sqm_nan_is_safe`.
2. **No spots within max_drive** — 200 with empty `spots`, verdict `unknown`, not an error. Test: Task 9 `test_no_spots_in_range`.
3. **ORS returns null durations for some destinations (unroutable)** — those spots are dropped, others kept; no crash. Test: Task 7 `test_null_duration_drops_spot`.
4. **Night with no astronomical darkness / tiny window** — nautical fallback with at least one slot. Test: Task 5 `test_slots_never_empty`.
5. **Search text with only punctuation or quotes** — returns `[]` / safe results, never FTS5 syntax errors. Test: Task 4 `test_query_handles_punctuation`.

---

## File Structure

```
pipeline/darksky_pipeline/{config.py,search_index.py,build.py}   # Task 1 (slim search)
api/
  pyproject.toml
  README.md
  data/<metro>/...                 # synced pipeline outputs (Task 11)
  darksky_api/
    __init__.py
    config.py      metros, constants, Settings
    cache.py       TTLCache
    ratelimit.py   SlidingWindowLimiter
    grid.py        DarknessGrid (npz loader + lon/lat sampling)
    data.py        MetroData, DataStore, DataError
    search.py      FTS5 search
    sky.py         dark window, slots, moon
    forecast.py    Open-Meteo client
    routing.py     ORS client + fallback
    scoring.py     quality, window, scores, verdict
    service.py     find_spots orchestration, QueryError
    schemas.py     pydantic response models
    app.py         FastAPI app factory
    sync_data.py   copy pipeline outputs into data/
  tests/
    conftest.py  fixtures.py  fakes.py
    test_config.py test_cache_ratelimit.py test_data.py test_search.py test_sky.py
    test_forecast.py test_routing.py test_scoring.py test_service.py test_app.py test_sync_data.py
```

---

### Task 1: Slim search index (pipeline)

**Files:**
- Modify: `pipeline/darksky_pipeline/config.py` (add constant), `pipeline/darksky_pipeline/search_index.py` (`search_rows`), `pipeline/tests/test_search_index.py`, `pipeline/tests/test_build.py`

**Interfaces:**
- Produces: `config.SEARCH_INCLUDE_ADDRESSES = False`; `search_rows(places, addresses, divisions, include_addresses: bool = SEARCH_INCLUDE_ADDRESSES)`. `build.py` keeps calling `search_rows(...)` with defaults → slim index.

- [ ] **Step 1: Write failing tests**

In `pipeline/tests/test_search_index.py`, change the `index_path` fixture's rows line and `test_rows_include_all_kinds` to pass `include_addresses=True`, and add:

```python
def test_default_rows_exclude_addresses(overture_frames):
    rows = search_rows(overture_frames["places"], overture_frames["addresses"], overture_frames["division_areas"])
    assert {k for _, k, _, _ in rows} == {"place", "locality"}
```

In `pipeline/tests/test_build.py`, replace the body of `test_search_index_built` with:

```python
def test_search_index_built(built):
    _, _, out = built
    assert query(out / "search_test.sqlite", "main st") == []
    assert query(out / "search_test.sqlite", "testville")[0]["kind"] == "locality"
```

- [ ] **Step 2: Run to verify failure**

Run (from `pipeline/`): `.venv/Scripts/python -m pytest tests/test_search_index.py tests/test_build.py -q`
Expected: FAIL — `search_rows() got an unexpected keyword argument 'include_addresses'` and the build test still finding an address.

- [ ] **Step 3: Implement**

Append to `pipeline/darksky_pipeline/config.py`:

```python

# --- Search -------------------------------------------------------------------
# Street addresses are excluded so each metro's index stays small enough to ship
# with the API (git + Render); users can still drop a pin for an exact start.
SEARCH_INCLUDE_ADDRESSES = False
```

In `pipeline/darksky_pipeline/search_index.py` change the import and `search_rows`:

```python
from .config import DIVISION_SUBTYPES, SEARCH_INCLUDE_ADDRESSES
```

```python
def search_rows(places: pd.DataFrame, addresses: pd.DataFrame, divisions: pd.DataFrame,
                include_addresses: bool = SEARCH_INCLUDE_ADDRESSES) -> list[Row]:
    rows: list[Row] = []
    p = places[places["name"].notna() & (places["confidence"] >= MIN_SEARCH_PLACE_CONFIDENCE)]
    rows += [(str(n), "place", float(lat), float(lon)) for n, lat, lon in p[["name", "lat", "lon"]].itertuples(index=False)]
    if include_addresses:
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
```

- [ ] **Step 4: Run tests**

Run: `.venv/Scripts/python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Regenerate real search indexes**

Run (from `pipeline/`, uses the Overture cache, ~3 min each):
```
.venv/Scripts/python -m darksky_pipeline.build --metro se_mi --release 2026-09-23.1 --viirs data/viirs/vnl_annual.tif --skip-tiles
.venv/Scripts/python -m darksky_pipeline.build --metro bay_area --release 2026-09-23.1 --viirs data/viirs/vnl_annual.tif --skip-tiles
```
Then: `ls -la out/se_mi/search_se_mi.sqlite out/bay_area/search_bay_area.sqlite`
Expected: both builds pass checks; each sqlite < 50 MB. If either is ≥ 50 MB, report the sizes (do not change other filters).

- [ ] **Step 6: Commit**

```bash
git add pipeline/darksky_pipeline/config.py pipeline/darksky_pipeline/search_index.py pipeline/tests/test_search_index.py pipeline/tests/test_build.py
git commit -m "feat(pipeline): slim search index without street addresses"
```

---

### Task 2: API scaffold, config, TTL cache, rate limiter

**Files:**
- Create: `api/pyproject.toml`, `api/darksky_api/__init__.py`, `api/darksky_api/config.py`, `api/darksky_api/cache.py`, `api/darksky_api/ratelimit.py`, `api/tests/test_config.py`, `api/tests/test_cache_ratelimit.py`
- Modify: `.gitignore` (add `api/.venv/`)

**Interfaces:**
- Produces:
  - `config.MetroInfo` (frozen: `key, name, bbox, center: (lon, lat), zoom, timezone, home_label`), `config.METROS: dict[str, MetroInfo]`, all constants below, `config.Settings` (frozen: `ors_api_key: str | None, allowed_origins: tuple[str, ...], data_dir: Path`), `config.load_settings(env: Mapping[str, str]) -> Settings`.
  - `cache.TTLCache(ttl_s: float, maxsize: int = 2048, clock=time.monotonic)` with `.get(key) -> Any | None`, `.set(key, value) -> None`, `__len__`.
  - `ratelimit.SlidingWindowLimiter(limit: int, window_s: float = 60.0, clock=time.monotonic)` with `.allow(key: str) -> bool`.

- [ ] **Step 1: Write `api/pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "darksky-api"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.110",
  "uvicorn[standard]>=0.29",
  "httpx>=0.27",
  "astral>=3.2",
  "numpy>=1.26",
  "pyproj>=3.6",
  "pydantic>=2.6",
  "tzdata>=2024.1",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[tool.setuptools.packages.find]
include = ["darksky_api*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Write `api/darksky_api/__init__.py`** (`"""Dark Sky Finder API."""`), append `api/.venv/` to repo `.gitignore`, create venv and install after the package directory exists:

Run (from `api/`): `python -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"`

- [ ] **Step 3: Write failing tests `api/tests/test_config.py`**

```python
from pathlib import Path

from darksky_api import config
from darksky_api.config import load_settings


def test_metros():
    assert set(config.METROS) == {"se_mi", "bay_area"}
    se = config.METROS["se_mi"]
    assert se.bbox == (-84.6, 41.65, -82.4, 44.1) and se.timezone == "America/Detroit"
    assert config.METROS["bay_area"].timezone == "America/Los_Angeles"
    for m in config.METROS.values():
        w, s, e, n = m.bbox
        assert w < m.center[0] < e and s < m.center[1] < n


def test_scoring_constants_match_spec():
    assert config.GOOD_HOUR_QUALITY == 0.6
    assert config.FOG_LOW_CLOUD_PCT == 70 and config.FOG_VISIBILITY_M == 2000 and config.FOG_CLEAR_FACTOR == 0.3
    assert config.MOON_MAX_PENALTY == 0.8
    assert config.HORIZON_BONUS == {"open": 5, "partial": 0, "enclosed": -5}
    assert config.BADGE_BONUS == {"verified": 5, "likely": 2, "check_hours": 0}
    assert config.DRIVE_PENALTY == 25 and config.GLARE_SITE_WEIGHT == 20
    assert (config.VERDICT_GOOD, config.VERDICT_MARGINAL, config.VERDICT_TOP_N) == (60, 35, 3)
    assert config.ORS_DAILY_BUDGET == 450 and config.RATE_LIMIT_PER_MIN == 20


def test_load_settings_defaults():
    s = load_settings({})
    assert s.ors_api_key is None
    assert s.allowed_origins == (config.DEV_ORIGIN,)
    assert s.data_dir == Path("data")


def test_load_settings_values():
    s = load_settings({"ORS_API_KEY": " k ", "ALLOWED_ORIGINS": "https://a.app, https://b.app ,",
                       "DATA_DIR": "/srv/data"})
    assert s.ors_api_key == "k"
    assert s.allowed_origins == ("https://a.app", "https://b.app", config.DEV_ORIGIN)
    assert s.data_dir == Path("/srv/data")


def test_blank_key_is_none():
    assert load_settings({"ORS_API_KEY": "  "}).ors_api_key is None
```

`api/tests/test_cache_ratelimit.py`:

```python
from darksky_api.cache import TTLCache
from darksky_api.ratelimit import SlidingWindowLimiter


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_ttl_cache_expires():
    clock = Clock()
    c = TTLCache(10, clock=clock)
    c.set("a", 1)
    assert c.get("a") == 1
    clock.t = 10.5
    assert c.get("a") is None


def test_ttl_cache_evicts_oldest_when_full():
    c = TTLCache(100, maxsize=2, clock=Clock())
    c.set("a", 1)
    c.set("b", 2)
    c.set("c", 3)
    assert c.get("a") is None and c.get("b") == 2 and c.get("c") == 3
    assert len(c) == 2


def test_limiter_allows_then_blocks_then_recovers():
    clock = Clock()
    lim = SlidingWindowLimiter(2, window_s=60, clock=clock)
    assert lim.allow("ip") and lim.allow("ip")
    assert not lim.allow("ip")
    assert lim.allow("other")
    clock.t = 61
    assert lim.allow("ip")
```

- [ ] **Step 4: Run to verify failure**

Run: `.venv/Scripts/python -m pytest -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'darksky_api.config'`.

- [ ] **Step 5: Write `api/darksky_api/config.py`**

```python
"""Metros, tuning constants (spec §5) and environment settings."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

BBox = tuple[float, float, float, float]  # west, south, east, north


@dataclass(frozen=True)
class MetroInfo:
    key: str
    name: str
    bbox: BBox
    center: tuple[float, float]  # lon, lat
    zoom: float
    timezone: str
    home_label: str


METROS: dict[str, MetroInfo] = {
    "se_mi": MetroInfo("se_mi", "SE Michigan", (-84.6, 41.65, -82.4, 44.1), (-83.15, 42.48), 8.5,
                       "America/Detroit", "Royal Oak"),
    "bay_area": MetroInfo("bay_area", "SF Bay Area", (-123.2, 36.4, -121.0, 38.6), (-122.27, 37.80), 8.5,
                          "America/Los_Angeles", "San Francisco"),
}

SCHEMA_VERSION = 2
NIGHT_DAYS_AHEAD = 6

# Spots query
DEFAULT_MAX_DRIVE = 90
MIN_MAX_DRIVE, MAX_MAX_DRIVE = 15, 240
DEFAULT_LIMIT, MAX_LIMIT = 25, 50
PREFILTER_KM_PER_MIN = 1.2
PREFILTER_MAX_SPOTS = 50
MAX_UNAVAILABLE_SHOWN = 10

# Routing (OpenRouteService)
ORS_URL = "https://api.openrouteservice.org/v2/matrix/driving-car"
ORS_TIMEOUT_S = 5.0
ORS_DAILY_BUDGET = 450
ROUTE_CACHE_TTL_S = 24 * 3600
ROUTE_CACHE_ROUND = 2  # decimal places of start lon/lat (~1 km)
FALLBACK_ROAD_FACTOR = 1.35
FALLBACK_SPEED_KMH = 60.0

# Forecast (Open-Meteo)
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
FORECAST_TIMEOUT_S = 5.0
FORECAST_CACHE_TTL_S = 3600
FORECAST_DAYS = 8

# Scoring (spec §5)
FOG_LOW_CLOUD_PCT = 70
FOG_VISIBILITY_M = 2000
FOG_CLEAR_FACTOR = 0.3
MOON_MAX_PENALTY = 0.8
GOOD_HOUR_QUALITY = 0.6
SITE_SQM_FLOOR = 18.0
SITE_SQM_SPAN = 4.0
GLARE_SITE_WEIGHT = 20
HORIZON_BONUS = {"open": 5, "partial": 0, "enclosed": -5}
DRIVE_PENALTY = 25
BADGE_BONUS = {"verified": 5, "likely": 2, "check_hours": 0}
VERDICT_GOOD = 60
VERDICT_MARGINAL = 35
VERDICT_TOP_N = 3
BRIGHT_MOON_ILLUMINATION = 0.85
NO_MOON_ILLUMINATION = 0.1

# Protection
RATE_LIMIT_PER_MIN = 20
DEV_ORIGIN = "http://localhost:5173"


@dataclass(frozen=True)
class Settings:
    ors_api_key: str | None
    allowed_origins: tuple[str, ...]
    data_dir: Path


def load_settings(env: Mapping[str, str]) -> Settings:
    key = (env.get("ORS_API_KEY") or "").strip() or None
    origins = [o.strip() for o in (env.get("ALLOWED_ORIGINS") or "").split(",") if o.strip()]
    if DEV_ORIGIN not in origins:
        origins.append(DEV_ORIGIN)
    return Settings(ors_api_key=key, allowed_origins=tuple(origins), data_dir=Path(env.get("DATA_DIR") or "data"))
```

- [ ] **Step 6: Write `api/darksky_api/cache.py`**

```python
"""Tiny in-memory TTL cache (resets when the process restarts)."""
from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Callable, Hashable


class TTLCache:
    def __init__(self, ttl_s: float, maxsize: int = 2048, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_s
        self._max = maxsize
        self._clock = clock
        self._items: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()

    def get(self, key: Hashable) -> Any | None:
        item = self._items.get(key)
        if item is None:
            return None
        expires, value = item
        if self._clock() >= expires:
            del self._items[key]
            return None
        return value

    def set(self, key: Hashable, value: Any) -> None:
        self._items.pop(key, None)
        self._items[key] = (self._clock() + self._ttl, value)
        while len(self._items) > self._max:
            self._items.popitem(last=False)

    def __len__(self) -> int:
        return len(self._items)
```

- [ ] **Step 7: Write `api/darksky_api/ratelimit.py`**

```python
"""Per-key sliding-window rate limiter (in memory)."""
from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Callable


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_s: float = 60.0, clock: Callable[[], float] = time.monotonic) -> None:
        self._limit = limit
        self._window = window_s
        self._clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = self._clock()
        hits = self._hits[key]
        while hits and now - hits[0] >= self._window:
            hits.popleft()
        if len(hits) >= self._limit:
            return False
        hits.append(now)
        return True
```

- [ ] **Step 8: Run tests** — `.venv/Scripts/python -m pytest -q` → all pass.

- [ ] **Step 9: Commit**

```bash
git add .gitignore api/pyproject.toml api/darksky_api api/tests
git commit -m "feat(api): scaffold with config, TTL cache, rate limiter"
```

---

### Task 3: Darkness grid, data store, and test fixtures

**Files:**
- Create: `api/darksky_api/grid.py`, `api/darksky_api/data.py`, `api/tests/fixtures.py`, `api/tests/conftest.py`, `api/tests/test_data.py`

**Interfaces:**
- Consumes: `config.MetroInfo`, `config.METROS`, `config.SCHEMA_VERSION`.
- Produces:
  - `grid.DarknessGrid` (`sqm: np.ndarray, x0, y0, res: float, epsg: int`), `DarknessGrid.load(path) -> DarknessGrid`, `.sample_lonlat(lon: float, lat: float) -> float` (NaN outside).
  - `data.DataError(Exception)`, `data.MetroData` (`info: MetroInfo, release: str, spots: list[dict], grid: DarknessGrid, search_path: Path`), `data.DataStore(metros: dict[str, MetroData])` with `.metros`, `.release: str`, `.metro_for(lon, lat) -> MetroData | None`, classmethod `DataStore.load(data_dir: Path, metros: dict[str, MetroInfo] = METROS) -> DataStore`.
  - Test fixtures (`tests/fixtures.py`): `TEST_METRO: MetroInfo` (key `"test"`), `CITY = (-84.05, 42.00)`, `HUDSON = (-84.25, 41.83)`, `make_spot(...) -> dict`, `build_data_dir(root: Path) -> Path`; conftest fixtures `data_dir`, `store`.

- [ ] **Step 1: Write `api/tests/fixtures.py`**

```python
"""Builds a tiny fake data directory (one metro, 'test') for API tests."""
from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path

import numpy as np
from pyproj import Transformer

from darksky_api.config import MetroInfo

TEST_METRO = MetroInfo("test", "Test Metro", (-84.40, 41.75, -84.00, 42.05), (-84.20, 41.90), 9.0,
                       "America/Detroit", "Testville")
CITY = (-84.05, 42.00)
HUDSON = (-84.25, 41.83)
EPSG = 32617
RES = 500.0


def make_spot(id_, name, lon, lat, sqm, badge="check_hours", horizon="partial", penalty=0.0,
              unavailable=False, display_name=None, area=None):
    return {
        "id": id_, "name": name, "display_name": display_name or name, "area": area,
        "category": "park", "lon": lon, "lat": lat, "sqm": sqm, "bortle": 4,
        "sky_label": "Milky Way vivid" if sqm >= 21.3 else "Milky Way not visible",
        "radiance": 0.2,
        "glare": {"buildings_1km": 0, "highway_m": None, "penalty": penalty},
        "horizon": {"class": horizon, "open_frac": 0.5, "closed_frac": 0.1, "water_frac": 0.0},
        "access": {"badge": badge, "road_class": "tertiary", "paved": True, "parking": False, "note": None},
        "dark_sky_place": False, "unavailable": unavailable,
        "unavailable_reason": "Closed for repairs" if unavailable else None,
        "amenities": {"restroom": None, "fuel": None, "food": None},
        "why": [],
    }


SPOTS = [
    make_spot("sp_hudson", "Lake Hudson", -84.25, 41.83, 21.6, "verified", "open", 0.01),
    make_spot("sp_camp", "Pine Campground", -84.15, 41.78, 21.4, "likely", "enclosed", 0.0),
    make_spot("sp_city", "Downtown Park", -84.05, 42.00, 18.2, "check_hours", "partial", 0.7),
    make_spot("sp_closed", "Closed Preserve", -84.30, 41.95, 21.5, "check_hours", "open", 0.0, unavailable=True),
    make_spot("sp_far", "Far Ridge", -84.39, 42.04, 21.7, "check_hours", "open", 0.0),
]

SEARCH_ROWS = [
    ("Testville", "locality", 42.00, -84.05),
    ("Lake Hudson Recreation Area", "place", 41.83, -84.25),
    ("O'Neill Park", "place", 41.90, -84.10),
]


def _write_grid(path: Path) -> None:
    fwd = Transformer.from_crs(4326, EPSG, always_xy=True)
    w, s, e, n = TEST_METRO.bbox
    xs, ys = fwd.transform([w, e, w, e], [s, s, n, n])
    x0, y0 = math.floor(min(xs) / RES) * RES, math.ceil(max(ys) / RES) * RES
    cols = math.ceil((max(xs) - x0) / RES)
    rows = math.ceil((y0 - min(ys)) / RES)
    sqm = np.full((rows, cols), 21.5, dtype=np.float32)
    cx, cy = fwd.transform(*CITY)
    yy, xx = np.mgrid[0:rows, 0:cols]
    cell_x = x0 + (xx + 0.5) * RES
    cell_y = y0 - (yy + 0.5) * RES
    sqm[np.hypot(cell_x - cx, cell_y - cy) <= 3_000] = 18.0
    np.savez_compressed(path, sqm=sqm, meta=np.array([x0, y0, RES, EPSG], dtype=np.float64))


def _write_search(path: Path) -> None:
    con = sqlite3.connect(path)
    con.execute("CREATE VIRTUAL TABLE search USING fts5(name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED, "
                "tokenize='unicode61 remove_diacritics 2')")
    con.executemany("INSERT INTO search (name, kind, lat, lon) VALUES (?, ?, ?, ?)", SEARCH_ROWS)
    con.commit()
    con.close()


def build_data_dir(root: Path, spots=None, schema_version: int = 2) -> Path:
    d = root / TEST_METRO.key
    d.mkdir(parents=True, exist_ok=True)
    doc = {"schema_version": schema_version, "metro": "test", "release": "2099-01-01.0",
           "generated_at": "2026-10-16T00:00:00Z", "spots": SPOTS if spots is None else spots}
    (d / "spots_test.json").write_text(json.dumps(doc), encoding="utf-8")
    _write_grid(d / "darkness_test.npz")
    _write_search(d / "search_test.sqlite")
    return root
```

- [ ] **Step 2: Write `api/tests/conftest.py`**

```python
from __future__ import annotations

import pytest

from fixtures import TEST_METRO, build_data_dir


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory):
    return build_data_dir(tmp_path_factory.mktemp("data"))


@pytest.fixture(scope="session")
def store(data_dir):
    from darksky_api.data import DataStore

    return DataStore.load(data_dir, {"test": TEST_METRO})
```

- [ ] **Step 3: Write failing tests `api/tests/test_data.py`**

```python
import math

import pytest

from darksky_api.data import DataError, DataStore
from darksky_api.grid import DarknessGrid
from fixtures import CITY, HUDSON, TEST_METRO, build_data_dir


def test_store_loads_metro(store):
    m = store.metros["test"]
    assert m.info is TEST_METRO
    assert len(m.spots) == 5 and m.release == "2099-01-01.0"
    assert store.release == "2099-01-01.0"
    assert m.search_path.name == "search_test.sqlite"


def test_grid_samples_city_and_dark(store):
    g = store.metros["test"].grid
    assert g.sample_lonlat(*CITY) == pytest.approx(18.0)
    assert g.sample_lonlat(*HUDSON) == pytest.approx(21.5)


def test_sample_outside_grid_is_nan(store):
    assert math.isnan(store.metros["test"].grid.sample_lonlat(-90.0, 30.0))


def test_metro_for(store):
    assert store.metro_for(*CITY).info.key == "test"
    assert store.metro_for(-100.0, 40.0) is None


def test_missing_metro_dir_fails_fast(tmp_path):
    with pytest.raises(DataError, match="test"):
        DataStore.load(tmp_path, {"test": TEST_METRO})


def test_wrong_schema_version_fails_fast(tmp_path):
    build_data_dir(tmp_path, schema_version=1)
    with pytest.raises(DataError, match="schema"):
        DataStore.load(tmp_path, {"test": TEST_METRO})


def test_grid_load_round_trip(data_dir):
    g = DarknessGrid.load(data_dir / "test" / "darkness_test.npz")
    assert g.epsg == 32617 and g.res == 500.0 and g.sqm.ndim == 2
```

- [ ] **Step 4: Run to verify failure** — `.venv/Scripts/python -m pytest tests/test_data.py -q` → `ModuleNotFoundError: darksky_api.data`.

- [ ] **Step 5: Write `api/darksky_api/grid.py`**

```python
"""Sky-brightness (SQM) grid written by the pipeline (darkness_<metro>.npz)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from pyproj import Transformer


@dataclass
class DarknessGrid:
    sqm: np.ndarray
    x0: float
    y0: float
    res: float
    epsg: int

    def __post_init__(self) -> None:
        self._fwd = Transformer.from_crs(4326, self.epsg, always_xy=True)

    @classmethod
    def load(cls, path: Path) -> "DarknessGrid":
        with np.load(path) as z:
            meta = z["meta"]
            return cls(sqm=np.array(z["sqm"]), x0=float(meta[0]), y0=float(meta[1]), res=float(meta[2]),
                       epsg=int(meta[3]))

    def sample_lonlat(self, lon: float, lat: float) -> float:
        x, y = self._fwd.transform(lon, lat)
        col = math.floor((x - self.x0) / self.res)
        row = math.floor((self.y0 - y) / self.res)
        h, w = self.sqm.shape
        if not (0 <= row < h and 0 <= col < w):
            return float("nan")
        return float(self.sqm[row, col])
```

- [ ] **Step 6: Write `api/darksky_api/data.py`**

```python
"""Load pipeline outputs per metro at startup."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .config import METROS, SCHEMA_VERSION, MetroInfo
from .grid import DarknessGrid


class DataError(RuntimeError):
    pass


@dataclass
class MetroData:
    info: MetroInfo
    release: str
    spots: list[dict]
    grid: DarknessGrid
    search_path: Path


class DataStore:
    def __init__(self, metros: dict[str, MetroData]) -> None:
        self.metros = metros

    @property
    def release(self) -> str:
        releases = sorted({m.release for m in self.metros.values()})
        return ",".join(releases)

    def metro_for(self, lon: float, lat: float) -> MetroData | None:
        for key in sorted(self.metros):
            w, s, e, n = self.metros[key].info.bbox
            if w <= lon <= e and s <= lat <= n:
                return self.metros[key]
        return None

    @classmethod
    def load(cls, data_dir: Path, metros: dict[str, MetroInfo] = METROS) -> "DataStore":
        loaded: dict[str, MetroData] = {}
        for key, info in metros.items():
            d = Path(data_dir) / key
            files = {k: d / f"{k}_{key}.{ext}" for k, ext in
                     (("spots", "json"), ("darkness", "npz"), ("search", "sqlite"))}
            missing = [str(p) for p in files.values() if not p.exists()]
            if missing:
                raise DataError(f"metro {key}: missing data files {missing}")
            doc = json.loads(files["spots"].read_text(encoding="utf-8"))
            if doc.get("schema_version") != SCHEMA_VERSION:
                raise DataError(f"metro {key}: spots schema_version {doc.get('schema_version')} != {SCHEMA_VERSION}")
            loaded[key] = MetroData(info=info, release=str(doc.get("release", "")), spots=list(doc["spots"]),
                                    grid=DarknessGrid.load(files["darkness"]), search_path=files["search"])
        return cls(loaded)
```

- [ ] **Step 7: Run tests** — `.venv/Scripts/python -m pytest -q` → all pass.

- [ ] **Step 8: Commit**

```bash
git add api/darksky_api/grid.py api/darksky_api/data.py api/tests
git commit -m "feat(api): load spots, darkness grid and search paths per metro"
```

---

### Task 4: Search

**Files:**
- Create: `api/darksky_api/search.py`, `api/tests/test_search.py`

**Interfaces:**
- Consumes: `data.DataStore`, `MetroData.search_path`.
- Produces: `search.query_index(path: Path, text: str, limit: int) -> list[dict]` (`name, kind, lat, lon`), `search.search(store, text: str, metro: str | None = None, limit: int = 8) -> list[dict]` (adds `metro`; unknown metro → `[]`).

- [ ] **Step 1: Write failing tests `api/tests/test_search.py`**

```python
import pytest

from darksky_api.search import search


def test_prefix_match(store):
    hits = search(store, "lake hud")
    assert hits[0]["name"] == "Lake Hudson Recreation Area"
    assert hits[0]["metro"] == "test" and hits[0]["kind"] == "place"
    assert hits[0]["lat"] == pytest.approx(41.83)


def test_locality(store):
    assert search(store, "testv")[0]["kind"] == "locality"


@pytest.mark.parametrize("text", ["O'Neill", '"', "***", "   ", "AND OR NOT", "Café"])
def test_query_handles_punctuation(store, text):
    assert isinstance(search(store, text), list)


def test_apostrophe_name_found(store):
    assert search(store, "O'Neill")[0]["name"] == "O'Neill Park"


def test_metro_filter_and_limit(store):
    assert search(store, "park", metro="nope") == []
    assert len(search(store, "a", limit=1)) <= 1
```

- [ ] **Step 2: Run to verify failure** → `ModuleNotFoundError: darksky_api.search`.

- [ ] **Step 3: Write `api/darksky_api/search.py`**

```python
"""Start-point search over each metro's FTS5 index (read-only)."""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from .data import DataStore


def query_index(path: Path, text: str, limit: int) -> list[dict]:
    tokens = re.findall(r"\w+", text.lower())
    if not tokens:
        return []
    match = " ".join(f'"{t}"*' for t in tokens)
    con = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT name, kind, lat, lon FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?",
                           (match, limit)).fetchall()
    finally:
        con.close()
    return [{"name": n, "kind": k, "lat": float(la), "lon": float(lo)} for n, k, la, lo in rows]


def search(store: DataStore, text: str, metro: str | None = None, limit: int = 8) -> list[dict]:
    keys = [metro] if metro is not None else sorted(store.metros)
    out: list[dict] = []
    for key in keys:
        m = store.metros.get(key)
        if m is None:
            continue
        out += [{**hit, "metro": key} for hit in query_index(m.search_path, text, limit)]
    return out[:limit]
```

- [ ] **Step 4: Run tests** → pass. **Step 5: Commit**

```bash
git add api/darksky_api/search.py api/tests/test_search.py
git commit -m "feat(api): read-only FTS5 start-point search"
```

---

### Task 5: Sky timing (dark window, hourly slots, moon)

**Files:**
- Create: `api/darksky_api/sky.py`, `api/tests/test_sky.py`

**Interfaces:**
- Produces:
  - `sky.DarkWindow` (frozen: `start: datetime, end: datetime, kind: str`)
  - `sky.dark_window(lat, lon, night: date, tz: str) -> DarkWindow` (astronomical; nautical fallback; tz-aware datetimes)
  - `sky.hourly_slots(window: DarkWindow) -> list[datetime]` (each full hour in [start, end); never empty)
  - `sky.moon_illumination(night: date) -> float` (0–1)
  - `sky.MoonInfo` (frozen: `illumination: float, rise: datetime | None, set: datetime | None`)
  - `sky.moon_info(lat, lon, night: date, tz: str, window: DarkWindow) -> MoonInfo` (rise/set falling inside the window)
  - `sky.moon_up(lat, lon, when: datetime) -> bool` (elevation > 0)

- [ ] **Step 1: Write failing tests `api/tests/test_sky.py`**

Reference values: Detroit (42.3314, −83.0458), Oct 16 2026 sunset 6:50 PM EDT; astral gives astronomical dusk 20:21 and dawn 06:13 next day; full moon Oct 26 2026 (Old Farmer's Almanac, 12:11 AM ET); new moon around Nov 9 2026; on Oct 16 the moon sets 22:27.

```python
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from darksky_api.sky import DarkWindow, dark_window, hourly_slots, moon_illumination, moon_info, moon_up

DET = (42.3314, -83.0458)
TZ = "America/Detroit"


def test_detroit_october_window():
    w = dark_window(*DET, date(2026, 10, 16), TZ)
    assert w.kind == "astronomical"
    assert w.start.tzinfo is not None
    assert datetime(2026, 10, 16, 20, 10, tzinfo=ZoneInfo(TZ)) <= w.start <= datetime(2026, 10, 16, 20, 35, tzinfo=ZoneInfo(TZ))
    assert datetime(2026, 10, 17, 6, 0, tzinfo=ZoneInfo(TZ)) <= w.end <= datetime(2026, 10, 17, 6, 25, tzinfo=ZoneInfo(TZ))


def test_slots_are_full_hours_inside_window():
    w = dark_window(*DET, date(2026, 10, 16), TZ)
    slots = hourly_slots(w)
    assert slots[0].hour == 21 and slots[0].minute == 0
    assert all(w.start <= s < w.end for s in slots)
    assert all(b - a == timedelta(hours=1) for a, b in zip(slots, slots[1:]))


def test_slots_never_empty():
    tz = ZoneInfo(TZ)
    tiny = DarkWindow(datetime(2026, 6, 21, 23, 27, tzinfo=tz), datetime(2026, 6, 21, 23, 50, tzinfo=tz), "nautical")
    assert hourly_slots(tiny) == [datetime(2026, 6, 21, 23, 0, tzinfo=tz)]


def test_june_window_is_short_but_astronomical():
    w = dark_window(*DET, date(2026, 6, 21), TZ)
    assert w.kind == "astronomical"
    assert timedelta(hours=3) < w.end - w.start < timedelta(hours=5)


def test_far_north_summer_falls_back_to_nautical():
    w = dark_window(58.5, -3.0, date(2026, 6, 21), "Europe/London")
    assert w.kind == "nautical" and w.end > w.start


def test_moon_illumination_phases():
    assert moon_illumination(date(2026, 10, 26)) > 0.97
    assert moon_illumination(date(2026, 11, 9)) < 0.03
    assert 0.2 < moon_illumination(date(2026, 10, 16)) < 0.35


def test_moon_info_and_up():
    w = dark_window(*DET, date(2026, 10, 16), TZ)
    m = moon_info(*DET, date(2026, 10, 16), TZ, w)
    assert m.rise is None
    assert m.set is not None and 22 <= m.set.hour <= 22
    tz = ZoneInfo(TZ)
    assert moon_up(*DET, datetime(2026, 10, 16, 21, 0, tzinfo=tz)) is True
    assert moon_up(*DET, datetime(2026, 10, 17, 1, 0, tzinfo=tz)) is False
```

- [ ] **Step 2: Run to verify failure** → `ModuleNotFoundError: darksky_api.sky`.

- [ ] **Step 3: Write `api/darksky_api/sky.py`**

```python
"""Sun/moon timing for a night (astral 3.2)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from astral import Observer, moon
from astral.sun import dawn, dusk

SYNODIC_MONTH = 29.53


@dataclass(frozen=True)
class DarkWindow:
    start: datetime
    end: datetime
    kind: str


@dataclass(frozen=True)
class MoonInfo:
    illumination: float
    rise: datetime | None
    set: datetime | None


def dark_window(lat: float, lon: float, night: date, tz: str) -> DarkWindow:
    obs = Observer(latitude=lat, longitude=lon)
    zone = ZoneInfo(tz)
    for depression, kind in ((18, "astronomical"), (12, "nautical")):
        try:
            start = dusk(obs, night, tzinfo=zone, depression=depression)
            end = dawn(obs, night + timedelta(days=1), tzinfo=zone, depression=depression)
        except ValueError:
            continue
        if end > start:
            return DarkWindow(start, end, kind)
    # Sun never reaches -12° (very high latitude summer): use local 23:00-01:00.
    start = datetime(night.year, night.month, night.day, 23, tzinfo=zone)
    return DarkWindow(start, start + timedelta(hours=2), "nautical")


def hourly_slots(window: DarkWindow) -> list[datetime]:
    first = window.start.replace(minute=0, second=0, microsecond=0)
    if first < window.start:
        first += timedelta(hours=1)
    slots = []
    t = first
    while t < window.end:
        slots.append(t)
        t += timedelta(hours=1)
    return slots or [window.start.replace(minute=0, second=0, microsecond=0)]


def moon_illumination(night: date) -> float:
    p = moon.phase(night)
    return float((1 - math.cos(2 * math.pi * p / SYNODIC_MONTH)) / 2)


def _event(fn, obs: Observer, day: date, zone: ZoneInfo) -> datetime | None:
    try:
        return fn(obs, day, tzinfo=zone)
    except ValueError:
        return None


def moon_info(lat: float, lon: float, night: date, tz: str, window: DarkWindow) -> MoonInfo:
    obs = Observer(latitude=lat, longitude=lon)
    zone = ZoneInfo(tz)
    days = (night, night + timedelta(days=1))

    def inside(fn) -> datetime | None:
        hits = [e for d in days if (e := _event(fn, obs, d, zone)) is not None and window.start <= e <= window.end]
        return min(hits) if hits else None

    return MoonInfo(illumination=moon_illumination(night), rise=inside(moon.moonrise), set=inside(moon.moonset))


def moon_up(lat: float, lon: float, when: datetime) -> bool:
    return bool(moon.elevation(Observer(latitude=lat, longitude=lon), when) > 0)
```

- [ ] **Step 4: Run tests** → pass. If a reference assertion fails, report the actual value (do not loosen beyond the spec's ±3 min around astral's values unless the published reference disagrees).

- [ ] **Step 5: Commit**

```bash
git add api/darksky_api/sky.py api/tests/test_sky.py
git commit -m "feat(api): dark window, hourly slots and moon timing"
```

---

### Task 6: Forecast client (Open-Meteo)

**Files:**
- Create: `api/darksky_api/forecast.py`, `api/tests/test_forecast.py`

**Interfaces:**
- Consumes: `cache.TTLCache`, config constants.
- Produces:
  - `forecast.HourWeather` (frozen: `cloud: float, cloud_low: float, visibility: float | None`)
  - `forecast.cell_of(lat, lon) -> tuple[float, float]` (rounded to 0.1°)
  - `forecast.ForecastClient(http: httpx.Client, cache: TTLCache | None = None)` with `.get(cells: list[tuple[float, float]], tz: str) -> dict[tuple[float, float], dict[str, HourWeather]]` — hour keys are local `"YYYY-MM-DDTHH:00"`; cells that failed are absent.
  - `forecast.hour_key(dt: datetime) -> str`

- [ ] **Step 1: Write failing tests `api/tests/test_forecast.py`**

```python
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

from darksky_api.cache import TTLCache
from darksky_api.forecast import ForecastClient, HourWeather, cell_of, hour_key

TIMES = ["2026-10-16T21:00", "2026-10-16T22:00"]


def payload(cloud=10):
    return {"hourly": {"time": TIMES, "cloud_cover": [cloud, cloud], "cloud_cover_low": [0, 80],
                       "visibility": [24000, None]}}


def client_with(handler, cache=None):
    return ForecastClient(httpx.Client(transport=httpx.MockTransport(handler)), cache=cache)


def test_cell_and_hour_key():
    assert cell_of(41.8349, -84.2512) == (41.8, -84.3)
    assert hour_key(datetime(2026, 10, 16, 21, 0, tzinfo=ZoneInfo("America/Detroit"))) == "2026-10-16T21:00"


def test_single_cell_parses():
    calls = []

    def handler(req):
        calls.append(req)
        assert req.url.params["hourly"] == "cloud_cover,cloud_cover_low,visibility"
        assert req.url.params["timezone"] == "America/Detroit"
        return httpx.Response(200, json=payload())

    out = client_with(handler).get([(41.8, -84.3)], "America/Detroit")
    assert out[(41.8, -84.3)]["2026-10-16T21:00"] == HourWeather(10, 0, 24000)
    assert out[(41.8, -84.3)]["2026-10-16T22:00"].visibility is None
    assert len(calls) == 1


def test_multi_cell_list_response():
    def handler(req):
        assert req.url.params["latitude"] == "41.8,42.0"
        return httpx.Response(200, json=[payload(10), payload(90)])

    out = client_with(handler).get([(41.8, -84.3), (42.0, -84.1)], "America/Detroit")
    assert out[(42.0, -84.1)]["2026-10-16T21:00"].cloud == 90


def test_cache_avoids_second_call():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(200, json=payload())

    c = client_with(handler, cache=TTLCache(3600))
    c.get([(41.8, -84.3)], "America/Detroit")
    c.get([(41.8, -84.3)], "America/Detroit")
    assert len(calls) == 1


def test_failure_returns_empty():
    def handler(req):
        return httpx.Response(503)

    assert client_with(handler).get([(41.8, -84.3)], "America/Detroit") == {}


def test_timeout_returns_empty():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    assert client_with(handler).get([(41.8, -84.3)], "America/Detroit") == {}
```

- [ ] **Step 2: Run to verify failure** → `ModuleNotFoundError: darksky_api.forecast`.

- [ ] **Step 3: Write `api/darksky_api/forecast.py`**

```python
"""Hourly cloud / low cloud / visibility from Open-Meteo, cached per 0.1° cell."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

import httpx

from . import config
from .cache import TTLCache

log = logging.getLogger("darksky_api.forecast")

Cell = tuple[float, float]


@dataclass(frozen=True)
class HourWeather:
    cloud: float
    cloud_low: float
    visibility: float | None


def cell_of(lat: float, lon: float) -> Cell:
    return (round(lat, 1), round(lon, 1))


def hour_key(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:00")


def _parse(block: dict) -> dict[str, HourWeather]:
    h = block["hourly"]
    out = {}
    for t, c, cl, v in zip(h["time"], h["cloud_cover"], h["cloud_cover_low"], h["visibility"]):
        if c is None:
            continue
        out[t] = HourWeather(float(c), float(cl or 0.0), None if v is None else float(v))
    return out


class ForecastClient:
    def __init__(self, http: httpx.Client, cache: TTLCache | None = None) -> None:
        self._http = http
        self._cache = cache or TTLCache(config.FORECAST_CACHE_TTL_S)

    def get(self, cells: list[Cell], tz: str) -> dict[Cell, dict[str, HourWeather]]:
        result: dict[Cell, dict[str, HourWeather]] = {}
        todo: list[Cell] = []
        for cell in dict.fromkeys(cells):
            cached = self._cache.get((cell, tz))
            if cached is not None:
                result[cell] = cached
            else:
                todo.append(cell)
        if not todo:
            return result
        params = {
            "latitude": ",".join(str(c[0]) for c in todo),
            "longitude": ",".join(str(c[1]) for c in todo),
            "hourly": "cloud_cover,cloud_cover_low,visibility",
            "timezone": tz,
            "forecast_days": str(config.FORECAST_DAYS),
        }
        try:
            resp = self._http.get(config.OPEN_METEO_URL, params=params, timeout=config.FORECAST_TIMEOUT_S)
            resp.raise_for_status()
            body = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("open-meteo failed: %s", exc)
            return result
        blocks = body if isinstance(body, list) else [body]
        for cell, block in zip(todo, blocks):
            try:
                hours = _parse(block)
            except (KeyError, TypeError, ValueError):
                continue
            self._cache.set((cell, tz), hours)
            result[cell] = hours
        return result
```

- [ ] **Step 4: Run tests** → pass. **Step 5: Commit**

```bash
git add api/darksky_api/forecast.py api/tests/test_forecast.py
git commit -m "feat(api): Open-Meteo forecast client with per-cell cache"
```

---

### Task 7: Routing client (OpenRouteService + fallback)

**Files:**
- Create: `api/darksky_api/routing.py`, `api/tests/test_routing.py`

**Interfaces:**
- Consumes: `cache.TTLCache`, config constants.
- Produces:
  - `routing.haversine_km(lon1, lat1, lon2, lat2) -> float`
  - `routing.estimate_minutes(km: float) -> float` (`km × 1.35 / 60 × 60`)
  - `routing.Dest = tuple[str, float, float]` (id, lon, lat)
  - `routing.RoutingClient(http: httpx.Client, api_key: str | None, cache: TTLCache | None = None, budget: int = ORS_DAILY_BUDGET, today=lambda: datetime.now(timezone.utc).date())` with `.drive_minutes(start: tuple[float, float], dests: list[Dest]) -> tuple[dict[str, float], bool]` — returns minutes per reachable id and `is_estimate`. ORS-unroutable (null) ids are omitted. Estimates include every id.
  - `.calls_today: int`

- [ ] **Step 1: Write failing tests `api/tests/test_routing.py`**

```python
import json
from datetime import date

import httpx
import pytest

from darksky_api.cache import TTLCache
from darksky_api.routing import RoutingClient, estimate_minutes, haversine_km

START = (-84.05, 42.00)
DESTS = [("a", -84.25, 41.83), ("b", -84.15, 41.78)]


def make(handler, key="k", budget=450, today=lambda: date(2026, 10, 16), cache=None):
    return RoutingClient(httpx.Client(transport=httpx.MockTransport(handler)), key, cache=cache,
                         budget=budget, today=today)


def ok(durations):
    def handler(req):
        body = json.loads(req.content)
        assert req.headers["Authorization"] == "k"
        assert body["sources"] == [0] and body["destinations"] == [1, 2]
        assert body["locations"][0] == list(START)
        return httpx.Response(200, json={"durations": [durations]})
    return handler


def test_haversine_and_estimate():
    km = haversine_km(-84.05, 42.00, -84.25, 41.83)
    assert 24 < km < 27
    assert estimate_minutes(60.0) == pytest.approx(81.0)


def test_ors_durations_to_minutes():
    minutes, est = make(ok([1800.0, 2400.0])).drive_minutes(START, DESTS)
    assert est is False and minutes == {"a": 30.0, "b": 40.0}


def test_null_duration_drops_spot():
    minutes, est = make(ok([1800.0, None])).drive_minutes(START, DESTS)
    assert est is False and minutes == {"a": 30.0}


@pytest.mark.parametrize("handler", [
    lambda req: httpx.Response(429, json={"error": "quota"}),
    lambda req: httpx.Response(500),
])
def test_http_errors_fall_back(handler):
    minutes, est = make(handler).drive_minutes(START, DESTS)
    assert est is True and set(minutes) == {"a", "b"}
    assert minutes["a"] == pytest.approx(estimate_minutes(haversine_km(*START, -84.25, 41.83)))


def test_timeout_falls_back():
    def handler(req):
        raise httpx.ConnectTimeout("slow", request=req)
    assert make(handler).drive_minutes(START, DESTS)[1] is True


def test_missing_key_never_calls():
    def handler(req):
        raise AssertionError("must not call ORS without a key")
    assert make(handler, key=None).drive_minutes(START, DESTS)[1] is True


def test_cache_hit_avoids_call():
    calls = []

    def handler(req):
        calls.append(1)
        return ok([60.0, 120.0])(req)

    c = make(handler, cache=TTLCache(3600))
    c.drive_minutes(START, DESTS)
    c.drive_minutes((-84.0501, 42.0003), list(reversed(DESTS)))  # same rounded start, same id set
    assert len(calls) == 1


def test_budget_switches_to_estimates_and_resets_daily():
    day = {"d": date(2026, 10, 16)}
    c = make(lambda req: httpx.Response(200, json={"durations": [[60.0, 120.0]]}), budget=1,
             today=lambda: day["d"])
    assert c.drive_minutes(START, DESTS)[1] is False
    assert c.drive_minutes((-83.0, 42.3), DESTS)[1] is True
    day["d"] = date(2026, 10, 17)
    assert c.drive_minutes((-83.1, 42.4), DESTS)[1] is False


def test_empty_dests():
    assert make(ok([])).drive_minutes(START, []) == ({}, False)
```

- [ ] **Step 2: Run to verify failure** → `ModuleNotFoundError: darksky_api.routing`.

- [ ] **Step 3: Write `api/darksky_api/routing.py`**

```python
"""Drive times via OpenRouteService matrix, with straight-line fallback."""
from __future__ import annotations

import logging
import math
from datetime import date, datetime, timezone
from typing import Callable

import httpx

from . import config
from .cache import TTLCache

log = logging.getLogger("darksky_api.routing")

Dest = tuple[str, float, float]  # id, lon, lat


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


def estimate_minutes(km: float) -> float:
    return km * config.FALLBACK_ROAD_FACTOR / config.FALLBACK_SPEED_KMH * 60.0


class RoutingClient:
    def __init__(self, http: httpx.Client, api_key: str | None, cache: TTLCache | None = None,
                 budget: int = config.ORS_DAILY_BUDGET,
                 today: Callable[[], date] = lambda: datetime.now(timezone.utc).date()) -> None:
        self._http = http
        self._key = api_key
        self._cache = cache or TTLCache(config.ROUTE_CACHE_TTL_S)
        self._budget = budget
        self._today = today
        self._day: date | None = None
        self.calls_today = 0

    def _estimate(self, start: tuple[float, float], dests: list[Dest]) -> dict[str, float]:
        return {i: estimate_minutes(haversine_km(start[0], start[1], lon, lat)) for i, lon, lat in dests}

    def _spend(self) -> bool:
        today = self._today()
        if today != self._day:
            self._day, self.calls_today = today, 0
        if self.calls_today >= self._budget:
            return False
        self.calls_today += 1
        return True

    def drive_minutes(self, start: tuple[float, float], dests: list[Dest]) -> tuple[dict[str, float], bool]:
        if not dests:
            return {}, False
        r = config.ROUTE_CACHE_ROUND
        key = (round(start[0], r), round(start[1], r), tuple(sorted(i for i, _, _ in dests)))
        cached = self._cache.get(key)
        if cached is not None:
            return dict(cached), False
        if self._key is None or not self._spend():
            return self._estimate(start, dests), True
        body = {"locations": [list(start)] + [[lon, lat] for _, lon, lat in dests],
                "sources": [0], "destinations": list(range(1, len(dests) + 1)), "metrics": ["duration"]}
        try:
            resp = self._http.post(config.ORS_URL, json=body, headers={"Authorization": self._key},
                                   timeout=config.ORS_TIMEOUT_S)
            resp.raise_for_status()
            row = resp.json()["durations"][0]
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
            log.warning("ors failed (%s); using estimates", type(exc).__name__)
            return self._estimate(start, dests), True
        minutes = {i: float(sec) / 60.0 for (i, _, _), sec in zip(dests, row) if sec is not None}
        self._cache.set(key, minutes)
        return dict(minutes), False
```

- [ ] **Step 4: Run tests** → pass. **Step 5: Commit**

```bash
git add api/darksky_api/routing.py api/tests/test_routing.py
git commit -m "feat(api): ORS drive-time client with cache, budget and fallback"
```

---

### Task 8: Scoring

**Files:**
- Create: `api/darksky_api/scoring.py`, `api/tests/test_scoring.py`

**Interfaces:**
- Consumes: config constants.
- Produces:
  - `scoring.Slot` (frozen: `time: datetime, quality: float, cloud: float | None, fog: bool, moon_up: bool`)
  - `scoring.hour_quality(cloud: float | None, cloud_low: float | None, visibility: float | None, moon_is_up: bool, illumination: float) -> tuple[float, bool]` (quality, fog)
  - `scoring.best_window(slots: list[Slot]) -> tuple[int, int] | None` (start index, end index exclusive)
  - `scoring.site_score(spot: dict) -> float`, `scoring.conditions_score(slots, window) -> float`, `scoring.relevant_score(best_view: float, drive: float, max_drive: int, badge: str) -> float`
  - `scoring.darker_than_home(spot_sqm: float, home_sqm: float) -> str`
  - `scoring.format_time(dt: datetime) -> str` (e.g. `"9:30 PM"`)
  - `scoring.verdict(conditions: list[float], window: tuple[datetime, datetime] | None, illumination: float, moon_rise: datetime | None, moon_set: datetime | None, mean_cloud: float | None) -> dict` (`rating`, `sentence`)

- [ ] **Step 1: Write failing tests `api/tests/test_scoring.py`**

```python
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from darksky_api.scoring import (Slot, best_window, conditions_score, darker_than_home, format_time, hour_quality,
                                 relevant_score, site_score, verdict)
from fixtures import make_spot

TZ = ZoneInfo("America/Detroit")
T0 = datetime(2026, 10, 16, 21, tzinfo=TZ)


def slots(qualities):
    return [Slot(T0 + timedelta(hours=i), q, None, False, False) for i, q in enumerate(qualities)]


@pytest.mark.parametrize("args,expected", [
    ((0, 0, 24000, False, 0.0), (1.0, False)),
    ((50, 0, 24000, False, 0.0), (0.5, False)),
    ((0, 80, 24000, False, 0.0), (0.3, True)),
    ((0, 0, 1500, False, 0.0), (0.3, True)),
    ((0, 0, None, True, 1.0), (pytest.approx(0.2), False)),
    ((None, None, None, True, 0.5), (pytest.approx(0.6), False)),
])
def test_hour_quality(args, expected):
    assert hour_quality(*args) == expected


def test_best_window_longest_then_earliest():
    assert best_window(slots([0.7, 0.2, 0.8, 0.9, 0.1, 0.9, 0.9])) == (2, 4)
    assert best_window(slots([0.1, 0.2])) is None
    assert best_window([]) is None


def test_conditions_score():
    s = slots([0.9, 0.9, 0.1])
    assert conditions_score(s, (0, 2)) == pytest.approx(90.0)
    assert conditions_score(slots([0.8, 0.1]), (0, 1)) == pytest.approx(40.0)
    assert conditions_score(slots([0.5, 0.3]), None) == pytest.approx(25.0)
    assert conditions_score([], None) == 0.0


def test_site_score():
    assert site_score(make_spot("a", "A", 0, 0, 22.0, horizon="open", penalty=0.0)) == 100.0
    assert site_score(make_spot("b", "B", 0, 0, 20.0, horizon="enclosed", penalty=0.5)) == pytest.approx(35.0)
    assert site_score(make_spot("c", "C", 0, 0, 17.0, horizon="partial", penalty=1.0)) == 0.0


def test_relevant_score():
    assert relevant_score(80.0, 45.0, 90, "verified") == pytest.approx(72.5)
    assert relevant_score(80.0, 0.0, 90, "check_hours") == pytest.approx(80.0)


@pytest.mark.parametrize("spot,home,text", [
    (18.3, 18.0, "about the same"),
    (20.0, 18.0, "~6× darker"),
    (21.9, 18.25, "~30× darker"),
    (19.0, 18.0, "~3× darker"),
])
def test_darker_than_home(spot, home, text):
    assert darker_than_home(spot, home) == text


def test_darker_than_home_nan_home():
    assert darker_than_home(21.0, float("nan")) == "about the same"


def test_format_time():
    assert format_time(datetime(2026, 10, 16, 21, 30, tzinfo=TZ)) == "9:30 PM"
    assert format_time(datetime(2026, 10, 17, 0, 5, tzinfo=TZ)) == "12:05 AM"


def test_verdicts():
    w = (datetime(2026, 10, 16, 21, 30, tzinfo=TZ), datetime(2026, 10, 17, 0, 30, tzinfo=TZ))
    s = datetime(2026, 10, 16, 22, 40, tzinfo=TZ)
    good = verdict([80, 70, 65], w, 0.3, None, s, 10.0)
    assert good["rating"] == "good"
    assert good["sentence"] == "Good night to go — clear 9:30 PM–12:30 AM, moon sets 10:40 PM."
    assert verdict([50, 40, 30], w, 0.05, None, None, 30.0)["rating"] == "marginal"
    assert verdict([50, 40, 30], w, 0.05, None, None, 30.0)["sentence"] == "Possible — best 9:30 PM–12:30 AM, no moon."
    cloudy = verdict([10, 5, 0], None, 0.1, None, None, 90.0)
    assert cloudy == {"rating": "poor", "sentence": "Not great — clouds most of the night."}
    bright = verdict([20, 20, 20], None, 0.98, None, None, 5.0)
    assert bright["sentence"] == "Bright moon — bright stars and planets only."
    assert verdict([], None, 0.3, None, None, None) == {"rating": "unknown", "sentence": "No spots within reach."}
```

- [ ] **Step 2: Run to verify failure** → `ModuleNotFoundError: darksky_api.scoring`.

- [ ] **Step 3: Write `api/darksky_api/scoring.py`**

```python
"""Hourly sky quality, best window, scores and the night verdict (spec §5)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

from . import config


@dataclass(frozen=True)
class Slot:
    time: datetime
    quality: float
    cloud: float | None
    fog: bool
    moon_up: bool


def hour_quality(cloud: float | None, cloud_low: float | None, visibility: float | None,
                 moon_is_up: bool, illumination: float) -> tuple[float, bool]:
    clear = 1.0 if cloud is None else max(0.0, 1.0 - cloud / 100.0)
    fog = (cloud_low is not None and cloud_low >= config.FOG_LOW_CLOUD_PCT) or \
          (visibility is not None and visibility < config.FOG_VISIBILITY_M)
    if fog:
        clear *= config.FOG_CLEAR_FACTOR
    moon = 1.0 - config.MOON_MAX_PENALTY * illumination if moon_is_up else 1.0
    return clear * moon, fog


def best_window(slots: list[Slot]) -> tuple[int, int] | None:
    best: tuple[int, int] | None = None
    i = 0
    while i < len(slots):
        if slots[i].quality >= config.GOOD_HOUR_QUALITY:
            j = i
            while j < len(slots) and slots[j].quality >= config.GOOD_HOUR_QUALITY:
                j += 1
            if best is None or (j - i) > (best[1] - best[0]):
                best = (i, j)
            i = j
        else:
            i += 1
    return best


def conditions_score(slots: list[Slot], window: tuple[int, int] | None) -> float:
    if not slots:
        return 0.0
    if window is None:
        return 50.0 * max(s.quality for s in slots)
    qs = [s.quality for s in slots[window[0]:window[1]]]
    return 100.0 * (sum(qs) / len(qs)) * min(1.0, len(qs) / 2.0)


def site_score(spot: dict) -> float:
    dark = (spot["sqm"] - config.SITE_SQM_FLOOR) / config.SITE_SQM_SPAN * 100.0
    raw = dark - config.GLARE_SITE_WEIGHT * spot["glare"]["penalty"] + config.HORIZON_BONUS[spot["horizon"]["class"]]
    return max(0.0, min(100.0, raw))


def relevant_score(best_view: float, drive: float, max_drive: int, badge: str) -> float:
    return best_view - config.DRIVE_PENALTY * drive / max_drive + config.BADGE_BONUS.get(badge, 0)


def darker_than_home(spot_sqm: float, home_sqm: float) -> str:
    if math.isnan(home_sqm) or math.isnan(spot_sqm):
        return "about the same"
    ratio = 10 ** (0.4 * (spot_sqm - home_sqm))
    if ratio < 1.5:
        return "about the same"
    n = round(ratio) if ratio < 10 else int(5 * round(ratio / 5))
    return f"~{n}× darker"


def format_time(dt: datetime) -> str:
    return f"{dt.hour % 12 or 12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"


def _moon_phrase(illumination: float, rise: datetime | None, set_: datetime | None) -> str:
    if illumination < config.NO_MOON_ILLUMINATION:
        return ", no moon"
    if set_ is not None:
        return f", moon sets {format_time(set_)}"
    if rise is not None:
        return f", moon rises {format_time(rise)}"
    return ""


def verdict(conditions: list[float], window: tuple[datetime, datetime] | None, illumination: float,
            moon_rise: datetime | None, moon_set: datetime | None, mean_cloud: float | None) -> dict:
    if not conditions:
        return {"rating": "unknown", "sentence": "No spots within reach."}
    top = conditions[:config.VERDICT_TOP_N]
    mean = sum(top) / len(top)
    span = f"{format_time(window[0])}–{format_time(window[1])}" if window else ""
    moon = _moon_phrase(illumination, moon_rise, moon_set)
    if mean >= config.VERDICT_GOOD and window:
        return {"rating": "good", "sentence": f"Good night to go — clear {span}{moon}."}
    if mean >= config.VERDICT_MARGINAL and window:
        return {"rating": "marginal", "sentence": f"Possible — best {span}{moon}."}
    if illumination >= config.BRIGHT_MOON_ILLUMINATION and (mean_cloud is None or mean_cloud < 40):
        return {"rating": "poor", "sentence": "Bright moon — bright stars and planets only."}
    return {"rating": "poor", "sentence": "Not great — clouds most of the night."}
```

- [ ] **Step 4: Run tests** → pass. **Step 5: Commit**

```bash
git add api/darksky_api/scoring.py api/tests/test_scoring.py
git commit -m "feat(api): hourly quality, best window, scores and verdict"
```

---

### Task 9: Spots service (orchestration)

**Files:**
- Create: `api/darksky_api/service.py`, `api/tests/fakes.py`, `api/tests/test_service.py`

**Interfaces:**
- Consumes: `DataStore`, `MetroData`, `RoutingClient.drive_minutes`, `ForecastClient.get`, `forecast.cell_of/hour_key`, `sky.*`, `scoring.*`, `routing.haversine_km`.
- Produces:
  - `service.QueryError(Exception)` with `.code: str`, `.detail: dict`
  - `service.SpotsQuery` (dataclass: `lat, lon: float; night: date | None = None; max_drive: int = 90; access: str = "all"; sort: str = "relevant"; limit: int = 25`)
  - `service.find_spots(store, routing, forecast, q: SpotsQuery, today: Callable[[str], date] | None = None) -> dict` — the spec §4 response dict (datetimes as ISO strings).
  - Test fakes (`tests/fakes.py`): `FakeRouting(minutes: dict[str, float] | None = None, estimate=False)`, `FakeForecast(cloud=10.0, low=0.0, vis=24000.0, fail=False)`.

- [ ] **Step 1: Write `api/tests/fakes.py`**

```python
from datetime import date, datetime, timedelta

from darksky_api.forecast import HourWeather
from darksky_api.routing import estimate_minutes, haversine_km


class FakeRouting:
    def __init__(self, minutes=None, estimate=False):
        self.minutes = minutes
        self.estimate = estimate
        self.calls = []

    def drive_minutes(self, start, dests):
        self.calls.append((start, [d[0] for d in dests]))
        if self.minutes is None:
            return {i: estimate_minutes(haversine_km(start[0], start[1], lon, lat)) for i, lon, lat in dests}, self.estimate
        return {i: self.minutes[i] for i, _, _ in dests if i in self.minutes}, self.estimate


class FakeForecast:
    def __init__(self, cloud=10.0, low=0.0, vis=24000.0, fail=False, fail_cells=()):
        self.cloud, self.low, self.vis, self.fail, self.fail_cells = cloud, low, vis, fail, set(fail_cells)

    def get(self, cells, tz):
        if self.fail:
            return {}
        hours = {}
        t = datetime(2026, 10, 10, 0, 0)
        while t < datetime(2026, 10, 25, 0, 0):
            hours[t.strftime("%Y-%m-%dT%H:00")] = HourWeather(self.cloud, self.low, self.vis)
            t += timedelta(hours=1)
        return {c: hours for c in cells if c not in self.fail_cells}


def fixed_today(_tz):
    return date(2026, 10, 16)
```

- [ ] **Step 2: Write failing tests `api/tests/test_service.py`**

```python
from datetime import date

import pytest

from darksky_api.service import QueryError, SpotsQuery, find_spots
from fakes import FakeForecast, FakeRouting, fixed_today
from fixtures import CITY, SPOTS, TEST_METRO, build_data_dir

MINUTES = {"sp_hudson": 30.0, "sp_camp": 40.0, "sp_city": 5.0, "sp_closed": 20.0, "sp_far": 70.0}


def run(store, routing=None, forecast=None, **kw):
    q = SpotsQuery(lat=CITY[1], lon=CITY[0], **kw)
    return find_spots(store, routing or FakeRouting(MINUTES), forecast or FakeForecast(), q, today=fixed_today)


def test_happy_path_shape(store):
    r = run(store)
    assert r["metro"] == "test" and r["night"] == "2026-10-16" and r["timezone"] == "America/Detroit"
    assert r["start"]["sqm"] == pytest.approx(18.0)
    assert r["forecast_status"] == "ok" and r["drive_status"] == "ok"
    assert r["verdict"]["rating"] == "good"
    assert r["verdict"]["dark"]["kind"] == "astronomical"
    assert r["verdict"]["moon"]["set"] is not None
    ranked = [s for s in r["spots"] if not s["unavailable"]]
    top = ranked[0]
    assert top["id"] == "sp_hudson"
    assert top["drive_minutes"] == 30 and top["drive_is_estimate"] is False
    assert top["darker_than_home"] == "~30× darker"
    assert set(top["scores"]) == {"site", "conditions", "best_view", "relevant"}
    assert top["timeline"][0]["time"].startswith("2026-10-16T21:00")
    assert top["best_window"] is not None


def test_unavailable_last_and_unscored(store):
    r = run(store)
    assert r["spots"][-1]["id"] == "sp_closed"
    assert r["spots"][-1]["scores"] is None and r["spots"][-1]["timeline"] == []


@pytest.mark.parametrize("sort,first", [("closest", "sp_city"), ("best_view", "sp_far"), ("relevant", "sp_hudson")])
def test_sorts(store, sort, first):
    assert run(store, sort=sort)["spots"][0]["id"] == first


def test_access_filter(store):
    ids = {s["id"] for s in run(store, access="likely")["spots"]}
    assert ids == {"sp_hudson", "sp_camp"}
    assert {s["id"] for s in run(store, access="verified")["spots"]} == {"sp_hudson"}


def test_max_drive_filter(store):
    ids = {s["id"] for s in run(store, max_drive=35)["spots"]}
    assert ids == {"sp_hudson", "sp_city", "sp_closed"}


def test_limit(store):
    ranked = [s for s in run(store, limit=2)["spots"] if not s["unavailable"]]
    assert len(ranked) == 2


def test_no_spots_in_range(store):
    r = run(store, routing=FakeRouting({}), max_drive=15)
    assert r["spots"] == [] and r["verdict"]["rating"] == "unknown"


def test_out_of_coverage(store):
    with pytest.raises(QueryError) as e:
        find_spots(store, FakeRouting(MINUTES), FakeForecast(), SpotsQuery(lat=30.0, lon=-90.0), today=fixed_today)
    assert e.value.code == "out_of_coverage" and e.value.detail["metros"] == ["test"]


@pytest.mark.parametrize("night", [date(2026, 10, 15), date(2026, 10, 23)])
def test_night_out_of_range(store, night):
    with pytest.raises(QueryError) as e:
        run(store, night=night)
    assert e.value.code == "night_out_of_range"


def test_forecast_unavailable_still_ranks(store):
    r = run(store, forecast=FakeForecast(fail=True))
    assert r["forecast_status"] == "unavailable"
    assert r["spots"][0]["timeline"][0]["cloud"] is None


def test_forecast_partial(store):
    r = run(store, forecast=FakeForecast(fail_cells={(41.8, -84.2)}))
    assert r["forecast_status"] == "partial"


def test_estimates_flagged(store):
    r = run(store, routing=FakeRouting(None, estimate=True))
    assert r["drive_status"] == "approx"
    assert all(s["drive_is_estimate"] for s in r["spots"])


def test_cloudy_night_is_poor(store):
    assert run(store, forecast=FakeForecast(cloud=95.0))["verdict"]["rating"] == "poor"


def test_prefilter_caps_and_skips_far(store):
    routing = FakeRouting(MINUTES)
    run(store, routing=routing, max_drive=15)
    assert set(routing.calls[0][1]) <= {"sp_city", "sp_closed", "sp_hudson", "sp_camp", "sp_far"}
    assert "sp_far" not in routing.calls[0][1]  # 28 km > 15 min × 1.2 km/min


def test_start_sqm_nan_is_safe(tmp_path):
    from darksky_api.data import DataStore
    from darksky_api.config import MetroInfo

    wide = MetroInfo("test", "Wide", (-85.5, 41.0, -83.0, 43.0), (-84.2, 41.9), 9, "America/Detroit", "X")
    build_data_dir(tmp_path)
    store = DataStore.load(tmp_path, {"test": wide})
    q = SpotsQuery(lat=42.9, lon=-85.4)  # inside bbox, outside the darkness grid
    r = find_spots(store, FakeRouting(None), FakeForecast(), q, today=fixed_today)
    assert r["start"]["sqm"] is None
    assert all(s["darker_than_home"] == "about the same" for s in r["spots"])
```

- [ ] **Step 3: Run to verify failure** → `ModuleNotFoundError: darksky_api.service`.

- [ ] **Step 4: Write `api/darksky_api/service.py`**

```python
"""/api/spots orchestration (spec addendum §5)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

from . import config
from .data import DataStore, MetroData
from .forecast import cell_of, hour_key
from .routing import haversine_km
from .scoring import (Slot, best_window, conditions_score, darker_than_home, hour_quality, relevant_score,
                      site_score, verdict)
from .sky import dark_window, hourly_slots, moon_info, moon_up


class QueryError(Exception):
    def __init__(self, code: str, detail: dict | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail or {}


@dataclass
class SpotsQuery:
    lat: float
    lon: float
    night: date | None = None
    max_drive: int = config.DEFAULT_MAX_DRIVE
    access: str = "all"
    sort: str = "relevant"
    limit: int = config.DEFAULT_LIMIT


ACCESS_ALLOWED = {"all": {"verified", "likely", "check_hours"}, "likely": {"verified", "likely"},
                  "verified": {"verified"}}


def _today(tz: str) -> date:
    return datetime.now(ZoneInfo(tz)).date()


def _iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.isoformat()


def _resolve(store: DataStore, q: SpotsQuery, today: Callable[[str], date]) -> tuple[MetroData, date]:
    metro = store.metro_for(q.lon, q.lat)
    if metro is None:
        raise QueryError("out_of_coverage", {"metros": sorted(store.metros)})
    first = today(metro.info.timezone)
    night = q.night or first
    if not (first <= night <= first + timedelta(days=config.NIGHT_DAYS_AHEAD)):
        raise QueryError("night_out_of_range",
                         {"min": first.isoformat(), "max": (first + timedelta(days=config.NIGHT_DAYS_AHEAD)).isoformat()})
    return metro, night


def find_spots(store: DataStore, routing, forecast, q: SpotsQuery,
               today: Callable[[str], date] | None = None) -> dict:
    metro, night = _resolve(store, q, today or _today)
    tz = metro.info.timezone
    home = metro.grid.sample_lonlat(q.lon, q.lat)
    home_sqm = None if math.isnan(home) else home

    # Prefilter by access and straight-line reach.
    reach_km = q.max_drive * config.PREFILTER_KM_PER_MIN
    pool = []
    for s in metro.spots:
        if s["access"]["badge"] not in ACCESS_ALLOWED[q.access]:
            continue
        km = haversine_km(q.lon, q.lat, s["lon"], s["lat"])
        if km <= reach_km:
            pool.append((km, s))
    pool.sort(key=lambda t: (t[0], t[1]["id"]))
    pool = [s for _, s in pool[:config.PREFILTER_MAX_SPOTS]]

    minutes, estimated = routing.drive_minutes((q.lon, q.lat), [(s["id"], s["lon"], s["lat"]) for s in pool])
    reachable = [s for s in pool if s["id"] in minutes and minutes[s["id"]] <= q.max_drive]

    window = dark_window(q.lat, q.lon, night, tz)
    slots_t = hourly_slots(window)
    clat, clon = metro.info.center[1], metro.info.center[0]
    moon = moon_info(clat, clon, night, tz, window)
    up = [moon_up(clat, clon, t) for t in slots_t]

    available = [s for s in reachable if not s["unavailable"]]
    cells = sorted({cell_of(s["lat"], s["lon"]) for s in available})
    weather = forecast.get(cells, tz) if cells else {}
    if not cells or len(weather) == len(cells):
        forecast_status = "ok" if weather or not cells else "unavailable"
    else:
        forecast_status = "partial" if weather else "unavailable"

    scored = []
    for s in available:
        hours = weather.get(cell_of(s["lat"], s["lon"]), {})
        slots: list[Slot] = []
        for t, is_up in zip(slots_t, up):
            hw = hours.get(hour_key(t))
            quality, fog = hour_quality(hw.cloud if hw else None, hw.cloud_low if hw else None,
                                        hw.visibility if hw else None, is_up, moon.illumination)
            slots.append(Slot(t, quality, hw.cloud if hw else None, fog, is_up))
        win = best_window(slots)
        site = site_score(s)
        cond = conditions_score(slots, win)
        bv = site * cond / 100.0
        rel = relevant_score(bv, minutes[s["id"]], q.max_drive, s["access"]["badge"])
        win_times = None
        if win is not None:
            win_times = (slots[win[0]].time, min(slots[win[1] - 1].time + timedelta(hours=1), window.end))
        scored.append({
            **s,
            "drive_minutes": round(minutes[s["id"]]),
            "drive_is_estimate": estimated,
            "darker_than_home": darker_than_home(s["sqm"], home if home_sqm is not None else float("nan")),
            "scores": {"site": round(site), "conditions": round(cond), "best_view": round(bv), "relevant": round(rel)},
            "timeline": [{"time": _iso(sl.time), "quality": round(sl.quality, 3), "cloud": sl.cloud,
                          "fog": sl.fog, "moon_up": sl.moon_up} for sl in slots],
            "best_window": None if win_times is None else {"start": _iso(win_times[0]), "end": _iso(win_times[1])},
            "_sort": {"relevant": rel, "best_view": bv, "closest": minutes[s["id"]], "conditions": cond,
                      "window": win_times, "mean_cloud": _mean([sl.cloud for sl in slots])},
        })

    by_view = sorted(scored, key=lambda x: (-x["_sort"]["best_view"], x["id"]))
    lead = by_view[0] if by_view else None
    v = verdict([x["_sort"]["conditions"] for x in by_view], lead["_sort"]["window"] if lead else None,
                moon.illumination, moon.rise, moon.set, lead["_sort"]["mean_cloud"] if lead else None)

    if q.sort == "closest":
        scored.sort(key=lambda x: (x["_sort"]["closest"], x["id"]))
    else:
        scored.sort(key=lambda x: (-x["_sort"][q.sort], x["id"]))
    ranked = scored[:q.limit]
    for x in ranked:
        x.pop("_sort")

    unavailable = sorted((s for s in reachable if s["unavailable"]), key=lambda s: (minutes[s["id"]], s["id"]))
    tail = [{**s, "drive_minutes": round(minutes[s["id"]]), "drive_is_estimate": estimated,
             "darker_than_home": darker_than_home(s["sqm"], home if home_sqm is not None else float("nan")),
             "scores": None, "timeline": [], "best_window": None}
            for s in unavailable[:config.MAX_UNAVAILABLE_SHOWN]]

    return {
        "metro": metro.info.key,
        "night": night.isoformat(),
        "timezone": tz,
        "start": {"lat": q.lat, "lon": q.lon, "sqm": None if home_sqm is None else round(home_sqm, 2),
                  "sky_label": _sky_label(home_sqm)},
        "verdict": {**v,
                    "best_window": lead["best_window"] if lead else None,
                    "moon": {"illumination": round(moon.illumination, 3), "rise": _iso(moon.rise), "set": _iso(moon.set)},
                    "dark": {"start": _iso(window.start), "end": _iso(window.end), "kind": window.kind}},
        "forecast_status": forecast_status,
        "drive_status": "approx" if estimated else "ok",
        "spots": ranked + tail,
    }


def _mean(values: list[float | None]) -> float | None:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


SKY_LABELS = ((21.3, "Milky Way vivid"), (20.4, "Milky Way visible"), (19.5, "Milky Way faint"))


def _sky_label(sqm: float | None) -> str | None:
    if sqm is None:
        return None
    for threshold, label in SKY_LABELS:
        if sqm >= threshold:
            return label
    return "Milky Way not visible"
```

Note: the verdict is computed before `_sort` is popped from ranked spots; the response uses `lead["best_window"]` (already ISO strings).

- [ ] **Step 5: Run tests** → `.venv/Scripts/python -m pytest tests/test_service.py -q` → pass. Then full suite.

- [ ] **Step 6: Commit**

```bash
git add api/darksky_api/service.py api/tests/fakes.py api/tests/test_service.py
git commit -m "feat(api): spots orchestration with verdict, ranking and fallbacks"
```

---

### Task 10: FastAPI app, response models, errors, CORS, rate limit

**Files:**
- Create: `api/darksky_api/schemas.py`, `api/darksky_api/app.py`, `api/tests/test_app.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `schemas.*` pydantic models (`Region`, `SearchHit`, `SpotsResponse` with nested `Verdict`, `Spot` — `extra="allow"` on `Spot` so pipeline fields pass through); `app.create_app(store, routing, forecast, settings, limiter=None, today=None) -> FastAPI`; `app.build_default_app() -> FastAPI` (reads env via `load_settings(os.environ)`, `DataStore.load(settings.data_dir)`, real httpx clients). Run with `uvicorn darksky_api.app:build_default_app --factory`.

- [ ] **Step 1: Write failing tests `api/tests/test_app.py`**

```python
import pytest
from fastapi.testclient import TestClient

from darksky_api.app import create_app
from darksky_api.config import Settings
from darksky_api.ratelimit import SlidingWindowLimiter
from fakes import FakeForecast, FakeRouting, fixed_today
from fixtures import CITY
from test_service import MINUTES

SETTINGS = Settings(ors_api_key="secret-key", allowed_origins=("https://app.example", "http://localhost:5173"),
                    data_dir=None)


@pytest.fixture()
def client(store):
    app = create_app(store, FakeRouting(MINUTES), FakeForecast(), SETTINGS,
                     limiter=SlidingWindowLimiter(3), today=fixed_today)
    return TestClient(app, raise_server_exceptions=False)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True, "metros": ["test"], "release": "2099-01-01.0"}


def test_regions(client):
    (reg,) = client.get("/api/regions").json()
    assert reg["key"] == "test" and reg["timezone"] == "America/Detroit" and len(reg["bbox"]) == 4


def test_search(client):
    hits = client.get("/api/search", params={"q": "lake hud"}).json()
    assert hits[0]["name"] == "Lake Hudson Recreation Area" and hits[0]["metro"] == "test"
    assert client.get("/api/search", params={"q": "!!!"}).json() == []
    assert client.get("/api/search", params={"q": "x", "limit": 99}).status_code == 422


def test_spots_ok(client):
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0]})
    assert r.status_code == 200
    body = r.json()
    assert body["spots"][0]["id"] == "sp_hudson"
    assert body["spots"][0]["display_name"] == "Lake Hudson"
    assert "secret-key" not in r.text


def test_spots_errors(client):
    r = client.get("/api/spots", params={"lat": 30, "lon": -90})
    assert r.status_code == 422 and r.json()["error"] == "out_of_coverage"
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0], "night": "2026-12-01"})
    assert r.status_code == 422 and r.json()["error"] == "night_out_of_range"
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0], "sort": "weird"})
    assert r.status_code == 422 and r.json()["error"] == "invalid_request"
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0], "max_drive": 5})
    assert r.status_code == 422


def test_rate_limit(client):
    params = {"lat": CITY[1], "lon": CITY[0]}
    codes = [client.get("/api/spots", params=params).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    assert client.get("/api/spots", params=params).json() == {"error": "rate_limited"}


def test_forwarded_for_used_for_rate_limit(client):
    params = {"lat": CITY[1], "lon": CITY[0]}
    for _ in range(3):
        client.get("/api/spots", params=params, headers={"X-Forwarded-For": "1.1.1.1, 10.0.0.1"})
    assert client.get("/api/spots", params=params, headers={"X-Forwarded-For": "2.2.2.2"}).status_code == 200


def test_cors(client):
    r = client.options("/api/spots", headers={"Origin": "https://app.example", "Access-Control-Request-Method": "GET"})
    assert r.headers["access-control-allow-origin"] == "https://app.example"
    r = client.options("/api/spots", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers


def test_internal_error_hides_details(store):
    class Boom:
        def drive_minutes(self, *a):
            raise RuntimeError("secret internals")

    app = create_app(store, Boom(), FakeForecast(), SETTINGS, today=fixed_today)
    r = TestClient(app, raise_server_exceptions=False).get("/api/spots", params={"lat": CITY[1], "lon": CITY[0]})
    assert r.status_code == 500 and r.json() == {"error": "internal"}
    assert "secret" not in r.text
```

- [ ] **Step 2: Run to verify failure** → `ModuleNotFoundError: darksky_api.app`.

- [ ] **Step 3: Write `api/darksky_api/schemas.py`**

```python
"""Response models (documented in /docs; validate the service output shape)."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Region(BaseModel):
    key: str
    name: str
    bbox: list[float]
    center: list[float]
    zoom: float
    timezone: str


class SearchHit(BaseModel):
    name: str
    kind: str
    lat: float
    lon: float
    metro: str


class Health(BaseModel):
    ok: bool
    metros: list[str]
    release: str


class Window(BaseModel):
    start: str
    end: str


class Moon(BaseModel):
    illumination: float
    rise: str | None
    set: str | None


class Dark(BaseModel):
    start: str
    end: str
    kind: str


class Verdict(BaseModel):
    rating: str
    sentence: str
    best_window: Window | None
    moon: Moon
    dark: Dark


class Start(BaseModel):
    lat: float
    lon: float
    sqm: float | None
    sky_label: str | None


class Scores(BaseModel):
    site: int
    conditions: int
    best_view: int
    relevant: int


class TimelineHour(BaseModel):
    time: str
    quality: float
    cloud: float | None
    fog: bool
    moon_up: bool


class Spot(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    name: str
    display_name: str
    area: str | None
    lon: float
    lat: float
    sqm: float
    unavailable: bool
    drive_minutes: int
    drive_is_estimate: bool
    darker_than_home: str
    scores: Scores | None
    timeline: list[TimelineHour]
    best_window: Window | None


class SpotsResponse(BaseModel):
    metro: str
    night: str
    timezone: str
    start: Start
    verdict: Verdict
    forecast_status: str
    drive_status: str
    spots: list[Spot]
```

- [ ] **Step 4: Write `api/darksky_api/app.py`**

```python
"""FastAPI routes. Run: uvicorn darksky_api.app:build_default_app --factory"""
from __future__ import annotations

import logging
import os
from datetime import date
from typing import Callable, Literal

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config
from .config import Settings, load_settings
from .data import DataStore
from .forecast import ForecastClient
from .ratelimit import SlidingWindowLimiter
from .routing import RoutingClient
from .schemas import Health, Region, SearchHit, SpotsResponse
from .search import search
from .service import QueryError, SpotsQuery, find_spots

log = logging.getLogger("darksky_api")


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def create_app(store: DataStore, routing, forecast, settings: Settings,
               limiter: SlidingWindowLimiter | None = None,
               today: Callable[[str], date] | None = None) -> FastAPI:
    app = FastAPI(title="Dark Sky Finder API", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins), allow_methods=["GET"],
                       allow_headers=["*"])
    limiter = limiter or SlidingWindowLimiter(config.RATE_LIMIT_PER_MIN)

    @app.exception_handler(QueryError)
    async def _query_error(_: Request, exc: QueryError):
        return JSONResponse(status_code=422, content={"error": exc.code, **exc.detail})

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"error": "invalid_request",
                                                      "detail": [e.get("loc") for e in exc.errors()]})

    @app.exception_handler(Exception)
    async def _internal(_: Request, exc: Exception):
        log.exception("unhandled error")
        return JSONResponse(status_code=500, content={"error": "internal"})

    @app.get("/api/health", response_model=Health)
    def health():
        return {"ok": True, "metros": sorted(store.metros), "release": store.release}

    @app.get("/api/regions", response_model=list[Region])
    def regions():
        return [{"key": m.info.key, "name": m.info.name, "bbox": list(m.info.bbox), "center": list(m.info.center),
                 "zoom": m.info.zoom, "timezone": m.info.timezone} for _, m in sorted(store.metros.items())]

    @app.get("/api/search", response_model=list[SearchHit])
    def search_route(q: str = Query("", max_length=100), metro: str | None = None,
                     limit: int = Query(8, ge=1, le=20)):
        return search(store, q, metro=metro, limit=limit)

    @app.get("/api/spots", response_model=SpotsResponse)
    def spots(request: Request,
              lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
              night: date | None = None,
              max_drive: int = Query(config.DEFAULT_MAX_DRIVE, ge=config.MIN_MAX_DRIVE, le=config.MAX_MAX_DRIVE),
              access: Literal["all", "likely", "verified"] = "all",
              sort: Literal["relevant", "closest", "best_view"] = "relevant",
              limit: int = Query(config.DEFAULT_LIMIT, ge=1, le=config.MAX_LIMIT)):
        if not limiter.allow(_client_ip(request)):
            return JSONResponse(status_code=429, content={"error": "rate_limited"})
        q = SpotsQuery(lat=lat, lon=lon, night=night, max_drive=max_drive, access=access, sort=sort, limit=limit)
        return find_spots(store, routing, forecast, q, today=today)

    return app


def build_default_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO)
    settings = load_settings(os.environ)
    store = DataStore.load(settings.data_dir)
    http = httpx.Client()
    return create_app(store, RoutingClient(http, settings.ors_api_key), ForecastClient(http), settings)
```

- [ ] **Step 5: Run tests** → `.venv/Scripts/python -m pytest -q` → all pass.

- [ ] **Step 6: Commit**

```bash
git add api/darksky_api/schemas.py api/darksky_api/app.py api/tests/test_app.py
git commit -m "feat(api): FastAPI routes with response models, errors, CORS and rate limit"
```

---

### Task 11: Data sync CLI, real data, README, smoke run

**Files:**
- Create: `api/darksky_api/sync_data.py`, `api/tests/test_sync_data.py`, `api/README.md`, `api/data/<metro>/*` (synced files)

**Interfaces:**
- Produces: `sync_data.sync(src: Path, dst: Path, metros: list[str]) -> list[tuple[Path, int]]` (copied files + sizes); raises `SystemExit` with a message on wrong schema or a file ≥ 95 MB; `main(argv)` with `--from`, `--to`, `--metros`.

- [ ] **Step 1: Write failing tests `api/tests/test_sync_data.py`**

```python
import json

import pytest

from darksky_api.sync_data import sync
from fixtures import build_data_dir


def test_sync_copies_three_files_per_metro(tmp_path):
    src = build_data_dir(tmp_path / "out")
    (src / "test" / "basemap_test_base.pmtiles").write_bytes(b"x")
    copied = sync(src, tmp_path / "data", ["test"])
    names = sorted(p.name for p, _ in copied)
    assert names == ["darkness_test.npz", "search_test.sqlite", "spots_test.json"]
    assert not (tmp_path / "data" / "test" / "basemap_test_base.pmtiles").exists()


def test_sync_rejects_old_schema(tmp_path):
    src = build_data_dir(tmp_path / "out", schema_version=1)
    with pytest.raises(SystemExit, match="schema"):
        sync(src, tmp_path / "data", ["test"])


def test_sync_rejects_huge_file(tmp_path, monkeypatch):
    import darksky_api.sync_data as sd

    src = build_data_dir(tmp_path / "out")
    monkeypatch.setattr(sd, "MAX_FILE_BYTES", 10)
    with pytest.raises(SystemExit, match="too large"):
        sync(src, tmp_path / "data", ["test"])
```

- [ ] **Step 2: Run to verify failure** → `ModuleNotFoundError: darksky_api.sync_data`.

- [ ] **Step 3: Write `api/darksky_api/sync_data.py`**

```python
"""Copy pipeline outputs (never tiles) into the API data dir.

python -m darksky_api.sync_data --from ../pipeline/out --to data
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from .config import METROS, SCHEMA_VERSION

MAX_FILE_BYTES = 95 * 1024 * 1024  # stay under GitHub's 100 MB per-file limit


def sync(src: Path, dst: Path, metros: list[str]) -> list[tuple[Path, int]]:
    copied: list[tuple[Path, int]] = []
    for key in metros:
        names = [f"spots_{key}.json", f"darkness_{key}.npz", f"search_{key}.sqlite"]
        files = [Path(src) / key / n for n in names]
        for f in files:
            if not f.exists():
                raise SystemExit(f"missing {f}")
            if f.stat().st_size >= MAX_FILE_BYTES:
                raise SystemExit(f"{f.name} is too large ({f.stat().st_size} bytes) for git")
        doc = json.loads(files[0].read_text(encoding="utf-8"))
        if doc.get("schema_version") != SCHEMA_VERSION:
            raise SystemExit(f"{files[0].name}: schema_version {doc.get('schema_version')} != {SCHEMA_VERSION}")
        out = Path(dst) / key
        out.mkdir(parents=True, exist_ok=True)
        for f in files:
            target = out / f.name
            shutil.copy2(f, target)
            copied.append((target, target.stat().st_size))
    return copied


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="darksky_api.sync_data")
    ap.add_argument("--from", dest="src", default="../pipeline/out")
    ap.add_argument("--to", dest="dst", default="data")
    ap.add_argument("--metros", nargs="*", default=sorted(METROS))
    args = ap.parse_args(argv)
    for path, size in sync(Path(args.src), Path(args.dst), args.metros):
        print(f"{size / 1e6:8.1f} MB  {path}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests** → pass.

- [ ] **Step 5: Sync real data**

Run (from `api/`): `.venv/Scripts/python -m darksky_api.sync_data --from ../pipeline/out --to data`
Expected: six files listed, each < 95 MB (search indexes are slim after Task 1).

- [ ] **Step 6: Smoke run against real data (no ORS key → estimates; real Open-Meteo)**

Run: `.venv/Scripts/python -c "from fastapi.testclient import TestClient; from darksky_api.app import build_default_app; c=TestClient(build_default_app()); r=c.get('/api/spots', params={'lat':42.4895,'lon':-83.1446}); print(r.status_code, r.json()['verdict'], [ (s['display_name'], s['drive_minutes'], s['scores']) for s in r.json()['spots'][:5]])"`
Expected: `200`, a verdict with rating and sentence, five SE MI spots with estimated drive minutes ≤ 90. Then `c.get('/api/search', params={'q':'lake hudson'})` returns hits. Record the output in the commit message body.

- [ ] **Step 7: Write `api/README.md`**

````markdown
# Dark Sky Finder — API

FastAPI service: night verdict + ranked stargazing spots for a start point, start-point search, regions.

## Setup
```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # macOS/Linux: .venv/bin/python
```

## Data
Pipeline outputs are copied (never tiles) into `data/<metro>/`:
```bash
.venv/Scripts/python -m darksky_api.sync_data --from ../pipeline/out --to data
```

## Run
```bash
ORS_API_KEY=... ALLOWED_ORIGINS=https://your.app .venv/Scripts/uvicorn darksky_api.app:build_default_app --factory --reload
```
Without `ORS_API_KEY`, drive times are straight-line estimates (`drive_status: "approx"`).
Docs at `http://localhost:8000/docs`.

## Endpoints
`GET /api/health`, `GET /api/regions`, `GET /api/search?q=&metro=&limit=`,
`GET /api/spots?lat=&lon=&night=YYYY-MM-DD&max_drive=90&access=all|likely|verified&sort=relevant|closest|best_view&limit=25`

## Tests
```bash
.venv/Scripts/python -m pytest
```
````

- [ ] **Step 8: Commit**

```bash
git add api/darksky_api/sync_data.py api/tests/test_sync_data.py api/README.md api/data
git commit -m "feat(api): data sync CLI, real metro data, README"
```

---

## Self-Review Notes

- **Spec coverage:** §2 slim index + sync (T1, T11); §3 modules (T2–T10; `service.py` and `schemas.py` added to keep routes thin); §4 endpoints/shape (T10 models, T9 dict); §5 steps 1–13 (T9 orchestration using T5–T8; moon at metro center per spec step 7); §6 rate limit, ORS budget, CORS, env, errors, fail-fast startup (T2, T7, T10, T3); §7 tests distributed per task; §8 deps (T2).
- **Deliberate:** unavailable spots are drawn from the same reachable pool and appended unscored (max 10). Night range is today…today+6 in the metro tz.
````

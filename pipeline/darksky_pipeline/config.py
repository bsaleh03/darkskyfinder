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
    # Area of the detailed basemap extract; defaults to bbox. Spots, darkness and search always use bbox.
    map_bbox: BBox | None = None

    @property
    def tiles_bbox(self) -> BBox:
        return self.map_bbox or self.bbox


METROS: dict[str, Metro] = {
    # Spots cover southeast Michigan; the detailed map covers the whole Lower Peninsula.
    "se_mi": Metro("se_mi", "Michigan", (-84.6, 41.65, -82.4, 44.1), 32617,
                   (-83.1446, 42.4895), "Royal Oak", map_bbox=(-86.9, 41.65, -82.4, 45.9)),
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
    "observatory", "nature_reserve", "scenic_viewpoint", "boat_launch", "boating_place",
})
LIKELY_CATEGORIES = frozenset({"campground", "observatory", "boat_launch", "boating_place"})
PARKING_CATEGORIES = frozenset({"parking", "parking_lot", "park_and_ride"})
AMENITY_CATEGORIES: dict[str, frozenset[str]] = {
    "restroom": frozenset({"public_restroom", "public_toilet", "restroom"}),
    "fuel": frozenset({"gas_station", "truck_gas_station"}),
    "food": frozenset({"restaurant", "fast_food_restaurant", "cafe", "coffee_shop", "diner",
                       "pizza_restaurant", "american_restaurant", "burger_restaurant",
                       "bar_and_grill_restaurant"}),
}
AMENITY_RADIUS_M = 5_000

# --- Land use -----------------------------------------------------------------
PARK_SUBTYPES = frozenset({"park", "protected", "recreation", "campground"})
# Land-use classes that are never stargazing spots even under a park subtype.
LAND_USE_CLASS_DENYLIST = frozenset({
    "pitch", "stadium", "track", "sports_centre", "golf_course", "swimming_pool", "playground", "dog_park",
})
MIN_PARK_AREA_M2 = 20_000
PLACE_ONLY_RADIUS_M = 500  # search area for a spot place with no park polygon
PLACE_POLYGON_TOLERANCE_M = 100  # a place this close to a park polygon belongs to it
DUPLICATE_MERGE_M = 2_000  # same-name spots with viewing points this close are one spot

# --- Search -------------------------------------------------------------------
DIVISION_SUBTYPES = frozenset({"locality", "localadmin", "county", "neighborhood", "macrohood", "microhood"})

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
SKYGLOW_K = 2.0  # nW/cm2/sr of weighted radiance that doubles natural sky brightness.
# Calibrated 2026-10 on VNL v2 2025 + Overture 2026-09-23.1: Royal Oak ~18.3, Lake Hudson ~21.9.
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
# Overture ships coarse low-zoom land-cover generalizations on top of the detailed
# polygons; keep only the detailed band so horizon fractions are not double-counted.
LAND_COVER_MIN_ZOOM = 8
HORIZON_RADIUS_M = 1_000
HORIZON_TILE_M = 10_000  # land-cover/water polygons are pre-cut to this grid for fast per-point queries
OPEN_COVER_SUBTYPES = frozenset({"grass", "crop", "shrub", "barren", "wetland", "moss", "snow"})
CLOSED_COVER_SUBTYPES = frozenset({"forest", "mangrove"})
HORIZON_OPEN_MIN = 0.5
HORIZON_CLOSED_MAX_FOR_OPEN = 0.3
HORIZON_ENCLOSED_MIN = 0.5
LAKE_CHIP_MIN_WATER = 0.2

# --- Checks -------------------------------------------------------------------
SPOT_COUNT_RANGE: dict[str, tuple[int, int]] = {"se_mi": (50, 10_000), "bay_area": (50, 10_000)}
TOP_SPOTS_MIN_MEDIAN_SQM = 20.5
VERIFIED_MIN_GAIN_MAG = 1.0

# --- Tiles --------------------------------------------------------------------
# Overture publishes per-theme PMTiles under the full release name (verified 2026-09-23.1).
OVERTURE_TILES_URL = "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/{release}/{theme}.pmtiles"
OVERTURE_TILE_THEMES = ("base", "transportation", "buildings", "divisions")
LIGHTPOLLUTION_BRIGHT_SQM = 17.0  # SQM rendered at full brightness in the overlay
# The map's glow overlay covers the lower 48 (display only; spot darkness still uses the per-metro grids).
US_GLOW_BBOX: BBox = (-126.0, 23.5, -65.5, 50.5)
US_GLOW_EPSG = 5070  # NAD83 / Conus Albers (equal-area)
US_GLOW_RES_M = 1_000  # sky glow is smooth; 1 km keeps the CONUS grid ~15M cells
US_GLOW_ZOOMS = (3, 9)
# Overture divisions (land shapes, country/state borders, state names) for the map beyond the metros.
US_BORDERS_BBOX: BBox = (-130.0, 18.0, -60.0, 62.0)
US_BORDERS_MAXZOOM = 7
US_BORDER_COUNTRIES = frozenset({"US", "CA", "MX"})
US_BORDER_SIMPLIFY_DEG = 0.001  # ~100 m: fine to ~z11, keeps borders.geojson under ~1 MB
US_BORDER_LAND_SLACK_DEG = 0.003  # land shapes grown ~300 m before cutting, so land borders stay continuous

# --- Search -------------------------------------------------------------------
# Street addresses are excluded so each metro's index stays small enough to ship
# with the API (git + Render); users can still drop a pin for an exact start.
SEARCH_INCLUDE_ADDRESSES = False

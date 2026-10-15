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
SPOT_COUNT_RANGE: dict[str, tuple[int, int]] = {"se_mi": (50, 5_000), "bay_area": (50, 5_000)}
TOP_SPOTS_MIN_MEDIAN_SQM = 20.5
VERIFIED_MIN_GAIN_MAG = 1.0

# --- Tiles --------------------------------------------------------------------
# Overture publishes per-theme PMTiles; confirm the URL for the pinned release in Task 14.
OVERTURE_TILES_URL = "https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/{release}/{theme}.pmtiles"
OVERTURE_TILE_THEMES = ("base", "transportation", "buildings", "divisions")
LIGHTPOLLUTION_BRIGHT_SQM = 17.0  # SQM rendered at full brightness in the overlay

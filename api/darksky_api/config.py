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

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

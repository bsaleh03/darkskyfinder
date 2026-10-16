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

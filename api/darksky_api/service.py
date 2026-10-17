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
from .routing import estimate_minutes, haversine_km
from .scoring import (Slot, best_window, conditions_score, darker_than_home, forecast_unavailable_verdict, hour_quality, relevant_score,
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
    border: str = "include"


ACCESS_ALLOWED = {"all": {"verified", "likely", "check_hours"}, "likely": {"verified", "likely"},
                  "verified": {"verified"}}


def _now(tz: str) -> datetime:
    return datetime.now(ZoneInfo(tz))


def _iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.isoformat(timespec="minutes")


def _resolve(store: DataStore, q: SpotsQuery, today: Callable[[str], date] | None,
             now: Callable[[str], datetime] | None) -> tuple[MetroData, date, datetime | None]:
    """Metro, night and the local current time (None when only `today` was injected).

    The current night is yesterday's date until that night's dark window ends (dawn)."""
    metro = store.metro_for(q.lon, q.lat)
    if metro is None:
        raise QueryError("out_of_coverage", {"metros": sorted(store.metros)})
    tz = metro.info.timezone
    current: datetime | None = None
    if now is None and today is not None:
        first = today(tz)
    else:
        current = (now or _now)(tz)
        if current.tzinfo is None:
            current = current.replace(tzinfo=ZoneInfo(tz))
        prev = current.date() - timedelta(days=1)
        first = prev if current < dark_window(q.lat, q.lon, prev, tz).end else current.date()
    night = q.night or first
    if not (first <= night <= first + timedelta(days=config.NIGHT_DAYS_AHEAD)):
        raise QueryError("night_out_of_range",
                         {"min": first.isoformat(), "max": (first + timedelta(days=config.NIGHT_DAYS_AHEAD)).isoformat()})
    return metro, night, current


def find_spots(store: DataStore, routing, forecast, q: SpotsQuery,
               today: Callable[[str], date] | None = None,
               now: Callable[[str], datetime] | None = None) -> dict:
    metro, night, current = _resolve(store, q, today, now)
    tz = metro.info.timezone
    home = metro.grid.sample_lonlat(q.lon, q.lat)
    home_sqm = None if math.isnan(home) else home

    # Prefilter by access and straight-line reach.
    reach_km = q.max_drive * config.PREFILTER_KM_PER_MIN
    pool = []
    for s in metro.spots:
        if s["access"]["badge"] not in ACCESS_ALLOWED[q.access]:
            continue
        if q.border == "exclude" and _crosses_border(s, metro):
            continue
        km = haversine_km(q.lon, q.lat, s["lon"], s["lat"])
        if km <= reach_km:
            pool.append((km, s))
    pool = _prefilter(pool, q)

    minutes, estimated = routing.drive_minutes((q.lon, q.lat), [(s["id"], s["lon"], s["lat"]) for s in pool])
    reachable = [s for s in pool if s["id"] in minutes and minutes[s["id"]] <= q.max_drive]

    window = dark_window(q.lat, q.lon, night, tz)
    slots_t = hourly_slots(window)
    # On the night in progress, hours that already ended are shown but not scored.
    live = current is not None and window.start <= current <= window.end
    past = [live and t + timedelta(hours=1) <= current for t in slots_t]
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
        ahead = [sl for sl, p in zip(slots, past) if not p]
        win = best_window(ahead)
        site = site_score(s)
        cond = conditions_score(ahead, win)
        bv = site * cond / 100.0
        rel = relevant_score(bv, minutes[s["id"]], q.max_drive, s["access"]["badge"])
        win_times = None
        if win is not None:
            win_times = (ahead[win[0]].time, min(ahead[win[1] - 1].time + timedelta(hours=1), window.end))
        scored.append({
            **s,
            "drive_minutes": round(minutes[s["id"]]),
            "drive_is_estimate": s["id"] in estimated,
            "crosses_border": _crosses_border(s, metro),
            "darker_than_home": darker_than_home(s["sqm"], home if home_sqm is not None else float("nan")),
            "scores": {"site": round(site), "conditions": round(cond), "best_view": round(bv), "relevant": round(rel)},
            "timeline": [{"time": _iso(sl.time), "quality": round(sl.quality, 3), "cloud": sl.cloud,
                          "fog": sl.fog, "moon_up": sl.moon_up, "past": p} for sl, p in zip(slots, past)],
            "best_window": None if win_times is None else {"start": _iso(win_times[0]), "end": _iso(win_times[1])},
            "_sort": {"relevant": rel, "best_view": bv, "closest": minutes[s["id"]], "conditions": cond,
                      "window": win_times, "mean_cloud": _mean([sl.cloud for sl in ahead])},
        })

    by_view = sorted(scored, key=lambda x: (-x["_sort"]["best_view"], x["id"]))
    lead = by_view[0] if by_view else None
    v = verdict([x["_sort"]["conditions"] for x in by_view], lead["_sort"]["window"] if lead else None,
                moon.illumination, moon.rise, moon.set, lead["_sort"]["mean_cloud"] if lead else None)
    if scored and forecast_status == "unavailable":
        v = forecast_unavailable_verdict(moon.illumination, moon.rise, moon.set)

    if q.sort == "closest":
        scored.sort(key=lambda x: (x["_sort"]["closest"], x["id"]))
    else:
        scored.sort(key=lambda x: (-x["_sort"][q.sort], x["id"]))
    ranked = scored[:q.limit]
    for x in ranked:
        x.pop("_sort")

    unavailable = sorted((s for s in reachable if s["unavailable"]), key=lambda s: (minutes[s["id"]], s["id"]))
    tail = [{**s, "drive_minutes": round(minutes[s["id"]]), "drive_is_estimate": s["id"] in estimated,
             "crosses_border": _crosses_border(s, metro),
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


def _crosses_border(spot: dict, metro: MetroData) -> bool:
    country = spot.get("country")
    return country is not None and country != metro.info.home_country


def _prefilter(pool: list[tuple[float, dict]], q: SpotsQuery) -> list[dict]:
    """Pick spots to route. Closest sort: nearest N. Otherwise: highest potential
    (site score minus drive penalty), so dark sites beyond dense suburbs are kept."""
    pool = sorted(pool, key=lambda t: (t[0], t[1]["id"]))
    avail = [t for t in pool if not t[1]["unavailable"]]
    gone = [t for t in pool if t[1]["unavailable"]][:config.MAX_UNAVAILABLE_SHOWN]
    if q.sort != "closest":
        avail.sort(key=lambda t: (-(site_score(t[1]) - config.DRIVE_PENALTY * estimate_minutes(t[0]) / q.max_drive),
                                  t[0], t[1]["id"]))
    return [s for _, s in avail[:config.PREFILTER_MAX_SPOTS]] + [s for _, s in gone]


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

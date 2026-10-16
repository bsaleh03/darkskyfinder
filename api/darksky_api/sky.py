"""Sun/moon timing for a night (astral 3.2)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
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
    tz = window.start.tzinfo
    start_utc = window.start.astimezone(timezone.utc)
    end_utc = window.end.astimezone(timezone.utc)
    # Floor to a whole local hour, then step in UTC so DST transitions neither
    # skip the repeated fall-back hour nor emit the non-existent spring-forward hour.
    t = window.start.replace(minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    if t < start_utc:
        t += timedelta(hours=1)
    slots = []
    while t < end_utc:
        slots.append(t.astimezone(tz))
        t += timedelta(hours=1)
    return slots or [window.start.replace(minute=0, second=0, microsecond=0)]


def moon_illumination(night: date) -> float:
    p = moon.phase(night + timedelta(days=1))  # 00:00 UTC next day ~ evening in the US
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
    # astral 3.2's elevation() ignores tzinfo offsets and reads wall-clock fields
    # as UTC, so convert aware datetimes to UTC before evaluating.
    if when.tzinfo is not None:
        when = when.astimezone(timezone.utc)
    return bool(moon.elevation(Observer(latitude=lat, longitude=lon), when) > 0)

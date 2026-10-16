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


def hour_key(dt: datetime) -> int:
    """UTC epoch seconds of the hour containing an aware datetime (unambiguous across DST)."""
    ts = int(dt.timestamp())
    return ts - ts % 3600


def _parse(block: dict) -> dict[int, HourWeather]:
    h = block["hourly"]
    out = {}
    for t, c, cl, v in zip(h["time"], h["cloud_cover"], h["cloud_cover_low"], h["visibility"]):
        if c is None:
            continue
        out[int(t)] = HourWeather(float(c), float(cl or 0.0), None if v is None else float(v))
    return out


class ForecastClient:
    def __init__(self, http: httpx.Client, cache: TTLCache | None = None) -> None:
        self._http = http
        self._cache = cache or TTLCache(config.FORECAST_CACHE_TTL_S)

    def get(self, cells: list[Cell], tz: str) -> dict[Cell, dict[int, HourWeather]]:
        result: dict[Cell, dict[int, HourWeather]] = {}
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
            "timeformat": "unixtime",
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

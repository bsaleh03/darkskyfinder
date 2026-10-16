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

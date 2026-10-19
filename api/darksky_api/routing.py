"""Drive times via OpenRouteService matrix, with straight-line fallback."""
from __future__ import annotations

import logging
import math
import threading
import time
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
    """Per-(start, spot) cached ORS matrix lookups.

    drive_minutes returns ({id: minutes}, estimated_ids). Ids are estimated
    from straight-line distance when ORS is unavailable (no key, budget spent,
    recent failure) or reports the spot unroutable (null duration).
    """

    def __init__(self, http: httpx.Client, api_key: str | None, cache: TTLCache | None = None,
                 budget: int = config.ORS_DAILY_BUDGET,
                 today: Callable[[], date] = lambda: datetime.now(timezone.utc).date(),
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._http = http
        self._key = api_key
        self._cache = TTLCache(config.ROUTE_CACHE_TTL_S, maxsize=config.ROUTE_CACHE_MAX) if cache is None else cache
        self._budget = budget
        self._today = today
        self._clock = clock
        self._day: date | None = None
        self._down_until = float("-inf")
        self.calls_today = 0
        self._lock = threading.Lock()

    def _spend(self) -> bool:
        with self._lock:
            today = self._today()
            if today != self._day:
                self._day, self.calls_today = today, 0
            if self.calls_today >= self._budget:
                return False
            self.calls_today += 1
            return True

    def _available(self) -> bool:
        return self._key is not None and self._clock() >= self._down_until and self._spend()

    def drive_minutes(self, start: tuple[float, float], dests: list[Dest]) -> tuple[dict[str, float], set[str]]:
        r = config.ROUTE_CACHE_ROUND
        sx, sy = round(start[0], r), round(start[1], r)
        unique = list({d[0]: d for d in dests}.values())
        known: dict[str, float | None] = {}
        todo: list[Dest] = []
        for d in unique:
            hit = self._cache.get((sx, sy, d[0], round(d[1], 5), round(d[2], 5)))
            if hit is None:
                todo.append(d)
            else:
                known[d[0]] = hit[0]
        if todo and self._available():
            routed = self._route(start, todo)
            by_id = {d[0]: d for d in todo}
            if routed is not None:
                for i, value in routed.items():
                    _, dlon, dlat = by_id[i]
                    self._cache.set((sx, sy, i, round(dlon, 5), round(dlat, 5)), (value,))
                known.update(routed)
        minutes: dict[str, float] = {}
        estimated: set[str] = set()
        for i, lon, lat in unique:
            value = known.get(i)
            if value is None:
                value = estimate_minutes(haversine_km(start[0], start[1], lon, lat))
                estimated.add(i)
            minutes[i] = value
        return minutes, estimated

    def _route(self, start: tuple[float, float], dests: list[Dest]) -> dict[str, float | None] | None:
        body = {"locations": [list(start)] + [[lon, lat] for _, lon, lat in dests],
                "sources": [0], "destinations": list(range(1, len(dests) + 1)), "metrics": ["duration"]}
        try:
            resp = self._http.post(config.ORS_URL, json=body, headers={"Authorization": self._key},
                                   timeout=config.ORS_TIMEOUT_S)
            resp.raise_for_status()
            return _parse_row(resp.json(), dests)
        except (httpx.HTTPError, httpx.InvalidURL, httpx.StreamError, ValueError, KeyError, IndexError,
                TypeError) as exc:
            log.warning("ors failed (%s); using estimates for %ds", type(exc).__name__,
                        config.ROUTE_FAILURE_BACKOFF_S)
            self._down_until = self._clock() + config.ROUTE_FAILURE_BACKOFF_S
            return None


def _parse_row(body: object, dests: list[Dest]) -> dict[str, float | None]:
    """Validate an ORS matrix body (None = unroutable); raises on any shape or type mismatch."""
    row = body["durations"][0]  # type: ignore[index]
    if not isinstance(row, list) or len(row) != len(dests):
        raise ValueError("unexpected matrix row shape")
    for sec in row:
        if sec is not None and (isinstance(sec, bool) or not isinstance(sec, (int, float))):
            raise TypeError("non-numeric duration")
    return {i: None if sec is None else float(sec) / 60.0 * config.ROUTE_TIME_FACTOR for (i, _, _), sec in zip(dests, row)}

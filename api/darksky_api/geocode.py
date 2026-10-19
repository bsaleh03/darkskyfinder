"""Street-address fallback via the OpenRouteService geocoder (Pelias), used only
when Overture's address index has no hit. Same shape as routing.py: shared
httpx client, key in the Authorization header, daily budget, TTL cache and a
short back-off after failures. Any failure yields no hits, never an error.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import date, datetime, timezone
from typing import Callable, Mapping

import httpx

from . import config
from .address_text import normalize
from .cache import TTLCache
from .config import BBox

log = logging.getLogger("darksky_api.geocode")

Found = tuple[str, float, float]  # name, lat, lon


class GeocodeClient:
    def __init__(self, http: httpx.Client, api_key: str | None, cache: TTLCache | None = None,
                 budget: int = config.ORS_GEOCODE_DAILY_BUDGET,
                 today: Callable[[], date] = lambda: datetime.now(timezone.utc).date(),
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._http = http
        self._key = api_key
        if cache is None:  # not `cache or ...`: an empty TTLCache is falsy
            cache = TTLCache(config.GEOCODE_CACHE_TTL_S, maxsize=config.GEOCODE_CACHE_MAX)
        self._cache = cache
        self.budget = budget
        self._today = today
        self._clock = clock
        self._day: date | None = None
        self._down_until = float("-inf")
        self.calls_today = 0
        self._lock = threading.Lock()

    def __repr__(self) -> str:
        return f"GeocodeClient(calls_today={self.calls_today}, budget={self.budget})"

    def _spend(self) -> bool:
        with self._lock:
            today = self._today()
            if today != self._day:
                self._day, self.calls_today = today, 0
            if self.calls_today >= self.budget:
                return False
            self.calls_today += 1
            return True

    def _available(self) -> bool:
        return self._key is not None and self._clock() >= self._down_until and self._spend()

    def search(self, text: str, bboxes: Mapping[str, BBox]) -> list[dict]:
        """Address hits inside one of `bboxes` (metro key -> bbox), tagged with that metro."""
        key = normalize(text)
        found = self._cache.get(key)
        if found is None:
            if not self._available():
                return []
            found = self._fetch(text)
            if found is None:
                return []
            self._cache.set(key, found)
        hits = []
        for name, lat, lon in found:
            metro = next((k for k, (w, s, e, n) in sorted(bboxes.items()) if w <= lon <= e and s <= lat <= n), None)
            if metro is not None:
                hits.append({"name": name, "kind": "address", "lat": lat, "lon": lon, "metro": metro,
                             "source": "openrouteservice"})
        return hits

    def _fetch(self, text: str) -> tuple[Found, ...] | None:
        params = {"text": text, "layers": "address", "size": str(config.GEOCODE_SIZE),
                  "boundary.country": config.GEOCODE_COUNTRIES}
        try:
            resp = self._http.get(config.ORS_GEOCODE_URL, params=params, headers={"Authorization": self._key},
                                  timeout=config.ORS_TIMEOUT_S)
            resp.raise_for_status()
            return _parse(resp.json())
        except (httpx.HTTPError, httpx.InvalidURL, httpx.StreamError, ValueError, KeyError, IndexError,
                TypeError, AttributeError) as exc:
            log.warning("ors geocode failed (%s); no fallback hits for %ds", type(exc).__name__,
                        config.ROUTE_FAILURE_BACKOFF_S)
            self._down_until = self._clock() + config.ROUTE_FAILURE_BACKOFF_S
            return None


def _number(v: object) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise TypeError("non-numeric coordinate")
    return float(v)


def _parse(body: object) -> tuple[Found, ...]:
    """Validate a Pelias FeatureCollection; raises on any shape or type mismatch."""
    features = body["features"]  # type: ignore[index]
    if not isinstance(features, list):
        raise TypeError("features is not a list")
    out: list[Found] = []
    for f in features:
        lon, lat = (_number(v) for v in f["geometry"]["coordinates"][:2])
        props = f["properties"]
        if props.get("layer") != "address":  # Pelias falls back to the town's centroid for unknown addresses
            continue
        name = props["name"]
        if not isinstance(name, str):
            raise TypeError("non-string name")
        locality = props.get("locality")
        label = f"{name}, {locality}" if isinstance(locality, str) and locality else name
        out.append((label, lat, lon))
    return tuple(out)

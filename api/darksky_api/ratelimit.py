"""Per-key sliding-window rate limiter (in memory, thread-safe)."""
from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from typing import Callable

from . import config


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_s: float = 60.0, clock: Callable[[], float] = time.monotonic,
                 max_keys: int = config.MAX_TRACKED_CLIENTS) -> None:
        self._limit = limit
        self._window = window_s
        self._clock = clock
        self._max_keys = max_keys
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        with self._lock:
            now = self._clock()
            hits = self._hits.get(key)
            if hits is None:
                hits = deque()
            while hits and now - hits[0] >= self._window:
                hits.popleft()
            allowed = len(hits) < self._limit
            if allowed:
                hits.append(now)
            if hits:
                self._hits[key] = hits
                self._hits.move_to_end(key)
                while len(self._hits) > self._max_keys:
                    self._hits.popitem(last=False)
            else:
                self._hits.pop(key, None)
            return allowed

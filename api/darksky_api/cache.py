"""Tiny in-memory TTL cache (resets when the process restarts)."""
from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Callable, Hashable


class TTLCache:
    def __init__(self, ttl_s: float, maxsize: int = 2048, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_s
        self._max = maxsize
        self._clock = clock
        self._items: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()

    def get(self, key: Hashable) -> Any | None:
        item = self._items.get(key)
        if item is None:
            return None
        expires, value = item
        if self._clock() >= expires:
            del self._items[key]
            return None
        return value

    def set(self, key: Hashable, value: Any) -> None:
        self._items.pop(key, None)
        self._items[key] = (self._clock() + self._ttl, value)
        while len(self._items) > self._max:
            self._items.popitem(last=False)

    def __len__(self) -> int:
        return len(self._items)

"""Small helpers shared across pipeline modules."""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import pandas as pd
import shapely


def as_list(value: Any) -> list:
    """Normalize Overture nested-list values (None, NaN, list, ndarray) to a list."""
    if value is None:
        return []
    if isinstance(value, float) and np.isnan(value):
        return []
    if isinstance(value, np.ndarray):
        return list(value)
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


def wkb_to_geoms(series: pd.Series) -> np.ndarray:
    """Decode a WKB column (bytes or bytearray) into a shapely geometry array."""
    return shapely.from_wkb(np.array([bytes(b) for b in series], dtype=object))


@contextmanager
def atomic_path(path: Path) -> Iterator[Path]:
    """Yield `<path>.tmp` to write to; on success it replaces `path` atomically, on failure it is removed
    so a crash never leaves a truncated output behind."""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    if tmp.exists():
        tmp.unlink()
    try:
        yield tmp
        os.replace(tmp, path)
    except BaseException:
        if tmp.exists():
            tmp.unlink()
        raise

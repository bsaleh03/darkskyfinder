"""Small helpers shared across pipeline modules."""
from __future__ import annotations

from typing import Any

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

"""Nearest restroom / fuel / food to a viewing point (straight-line)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import config
from .geo import Projector


@dataclass(frozen=True)
class Amenity:
    name: str
    km: float


class AmenityFinder:
    def __init__(self, places: pd.DataFrame, projector: Projector) -> None:
        named = places[places["name"].notna()]
        self._kinds: dict[str, tuple[cKDTree, np.ndarray] | None] = {}
        for kind, cats in config.AMENITY_CATEGORIES.items():
            sub = named[named["category"].isin(cats)]
            if len(sub) == 0:
                self._kinds[kind] = None
                continue
            x, y = projector.to_xy(sub["lon"].to_numpy(), sub["lat"].to_numpy())
            self._kinds[kind] = (cKDTree(np.column_stack([x, y])), sub["name"].to_numpy(dtype=object))

    def near(self, x: float, y: float) -> dict[str, Amenity | None]:
        out: dict[str, Amenity | None] = {}
        for kind, entry in self._kinds.items():
            if entry is None:
                out[kind] = None
                continue
            tree, names = entry
            dist, i = tree.query([x, y])
            out[kind] = (Amenity(str(names[i]), round(float(dist) / 1000.0, 1))
                         if dist <= config.AMENITY_RADIUS_M else None)
        return out

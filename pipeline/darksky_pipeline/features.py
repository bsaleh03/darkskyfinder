"""Per-viewing-point site features: local glare and horizon openness."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import shapely
from scipy.spatial import cKDTree

from . import config
from .geo import Projector
from .roads import RoadNetwork
from .util import wkb_to_geoms


@dataclass(frozen=True)
class Glare:
    buildings_1km: int
    highway_m: float | None
    penalty: float


def glare_penalty(buildings: int, highway_m: float | None) -> float:
    p = min(1.0, buildings / config.GLARE_BUILDINGS_SATURATION) * config.GLARE_BUILDING_WEIGHT
    if highway_m is not None:
        if highway_m < config.HIGHWAY_NEAR_M:
            p += config.HIGHWAY_NEAR_PENALTY
        elif highway_m < config.HIGHWAY_MID_M:
            p += config.HIGHWAY_MID_PENALTY
    return round(min(p, 1.0), 3)


def building_points(buildings: pd.DataFrame, projector: Projector) -> np.ndarray:
    if len(buildings) == 0:
        return np.empty((0, 2))
    x, y = projector.to_xy(buildings["lon"].to_numpy(), buildings["lat"].to_numpy())
    return np.column_stack([x, y])


class GlareModel:
    def __init__(self, buildings_xy: np.ndarray, roads: RoadNetwork) -> None:
        self._tree = cKDTree(buildings_xy) if len(buildings_xy) else None
        self._roads = roads

    def at(self, x: float, y: float) -> Glare:
        count = len(self._tree.query_ball_point([x, y], r=config.GLARE_RADIUS_M)) if self._tree is not None else 0
        hw = None
        if self._roads.highway_tree is not None:
            p = shapely.Point(x, y)
            i = int(self._roads.highway_tree.nearest(p))
            hw = float(self._roads.highway_geoms[i].distance(p))
        return Glare(count, hw, glare_penalty(count, hw))


@dataclass(frozen=True)
class Horizon:
    cls: str
    open_frac: float
    closed_frac: float
    water_frac: float


def classify_horizon(open_frac: float, closed_frac: float) -> str:
    if open_frac >= config.HORIZON_OPEN_MIN and closed_frac < config.HORIZON_CLOSED_MAX_FOR_OPEN:
        return "open"
    if closed_frac >= config.HORIZON_ENCLOSED_MIN:
        return "enclosed"
    return "partial"


def _polygons(df: pd.DataFrame, projector: Projector) -> np.ndarray:
    if len(df) == 0:
        return np.array([], dtype=object)
    geoms = shapely.make_valid(projector.geoms_to_xy(wkb_to_geoms(df["wkb"])))
    return geoms[np.isin(shapely.get_type_id(geoms), [3, 6])]  # Polygon, MultiPolygon


class _Layer:
    def __init__(self, geoms: np.ndarray) -> None:
        self.geoms = geoms
        self.tree = shapely.STRtree(geoms) if len(geoms) else None

    def fraction(self, circle) -> float:
        if self.tree is None:
            return 0.0
        idx = self.tree.query(circle, predicate="intersects")
        if len(idx) == 0:
            return 0.0
        covered = shapely.union_all(shapely.intersection(self.geoms[idx], circle))
        return float(min(1.0, covered.area / circle.area))


class HorizonModel:
    def __init__(self, land_cover: pd.DataFrame, water: pd.DataFrame, projector: Projector) -> None:
        open_lc = _polygons(land_cover[land_cover["subtype"].isin(config.OPEN_COVER_SUBTYPES)], projector)
        closed_lc = _polygons(land_cover[land_cover["subtype"].isin(config.CLOSED_COVER_SUBTYPES)], projector)
        water_p = _polygons(water, projector)
        self._open = _Layer(np.concatenate([open_lc, water_p]))
        self._closed = _Layer(closed_lc)
        self._water = _Layer(water_p)

    def at(self, x: float, y: float) -> Horizon:
        circle = shapely.Point(x, y).buffer(config.HORIZON_RADIUS_M, quad_segs=16)
        o, c, w = self._open.fraction(circle), self._closed.fraction(circle), self._water.fraction(circle)
        return Horizon(classify_horizon(o, c), o, c, w)

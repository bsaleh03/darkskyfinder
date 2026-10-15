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


_POLYGONAL = (3, 6)  # Polygon, MultiPolygon


def _polygonal_parts(geoms: np.ndarray) -> np.ndarray:
    """Polygonal members of each geometry; GeometryCollections (e.g. from make_valid) are opened up."""
    geoms = np.asarray(geoms, dtype=object)
    if len(geoms) == 0:
        return geoms
    direct = geoms[np.isin(shapely.get_type_id(geoms), _POLYGONAL)]
    coll = geoms[shapely.get_type_id(geoms) == 7]
    if len(coll):
        parts = shapely.get_parts(coll)
        direct = np.concatenate([direct, parts[np.isin(shapely.get_type_id(parts), _POLYGONAL)]])
    return direct[~shapely.is_empty(direct)]


def _polygons(df: pd.DataFrame, projector: Projector) -> np.ndarray:
    if len(df) == 0:
        return np.array([], dtype=object)
    return _polygonal_parts(shapely.make_valid(projector.geoms_to_xy(wkb_to_geoms(df["wkb"]))))


def _tile(geoms: np.ndarray, tile_m: float) -> np.ndarray:
    """Cut polygons spanning more than one tile of a tile_m grid into per-tile pieces (done once),
    so per-query intersection/union work is bounded by the tile size, not the polygon size."""
    if len(geoms) == 0:
        return geoms
    b = shapely.bounds(geoms)
    span = (np.floor(b[:, 2] / tile_m) > np.floor(b[:, 0] / tile_m)) | (np.floor(b[:, 3] / tile_m) > np.floor(b[:, 1] / tile_m))
    if not span.any():
        return geoms
    big = geoms[span]
    minx, miny, maxx, maxy = shapely.total_bounds(big)
    xs = np.arange(np.floor(minx / tile_m) * tile_m, maxx, tile_m)
    ys = np.arange(np.floor(miny / tile_m) * tile_m, maxy, tile_m)
    X, Y = np.meshgrid(xs, ys)
    tiles = shapely.box(X.ravel(), Y.ravel(), X.ravel() + tile_m, Y.ravel() + tile_m)
    gi, ti = shapely.STRtree(tiles).query(big, predicate="intersects")
    pieces = _polygonal_parts(shapely.intersection(big[gi], tiles[ti]))
    return np.concatenate([geoms[~span], pieces])


class _Layer:
    def __init__(self, geoms: np.ndarray, tile_m: float = config.HORIZON_TILE_M) -> None:
        self.geoms = _tile(np.asarray(geoms, dtype=object), tile_m)
        self.tree = shapely.STRtree(self.geoms) if len(self.geoms) else None

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

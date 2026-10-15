"""Drivable road network, access checks, and darkest-reachable viewing point."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
import shapely
from shapely.geometry.base import BaseGeometry

from . import config
from .darkness import DarknessGrid
from .geo import Projector
from .util import as_list, wkb_to_geoms


def is_private(access_restrictions) -> bool:
    return any(isinstance(r, dict) and r.get("access_type") == "denied" and not r.get("when")
               for r in as_list(access_restrictions))


def is_paved(road_class: str, road_surface) -> bool:
    if road_class in config.UNPAVED_CLASSES:
        return False
    values = [r.get("value") for r in as_list(road_surface) if isinstance(r, dict)]
    return "unpaved" not in values


@dataclass
class RoadNetwork:
    geoms: np.ndarray
    classes: np.ndarray
    paved: np.ndarray
    tree: shapely.STRtree | None
    highway_geoms: np.ndarray
    highway_tree: shapely.STRtree | None


def build_road_network(segments: pd.DataFrame, projector: Projector) -> RoadNetwork:
    df = segments[(segments["subtype"] == "road") & segments["class"].isin(config.DRIVABLE_CLASSES)]
    df = df[~df["access_restrictions"].map(is_private)].reset_index(drop=True)
    geoms = projector.geoms_to_xy(wkb_to_geoms(df["wkb"])) if len(df) else np.array([], dtype=object)
    classes = df["class"].to_numpy(dtype=object)
    paved = np.array([is_paved(c, s) for c, s in zip(df["class"], df["road_surface"])], dtype=bool)
    hw = geoms[np.isin(classes, list(config.HIGHWAY_CLASSES))] if len(geoms) else np.array([], dtype=object)
    return RoadNetwork(geoms=geoms, classes=classes, paved=paved,
                       tree=shapely.STRtree(geoms) if len(geoms) else None,
                       highway_geoms=hw, highway_tree=shapely.STRtree(hw) if len(hw) else None)


def parking_points(places: pd.DataFrame, projector: Projector) -> np.ndarray:
    p = places[places["category"].isin(config.PARKING_CATEGORIES)]
    if len(p) == 0:
        return np.empty((0, 2))
    x, y = projector.to_xy(p["lon"].to_numpy(), p["lat"].to_numpy())
    return np.column_stack([x, y])


@dataclass(frozen=True)
class ViewingPoint:
    x: float
    y: float
    lon: float
    lat: float
    sqm: float
    road_class: str
    paved: bool
    radiance: float = math.nan  # local VIIRS radiance at the point (nW/cm2/sr)
    parking: bool = False       # from a parking place, or parking within ACCESS_SEARCH_M (see find_viewing_point)


def _sample(area: BaseGeometry, roads: RoadNetwork, parking_xy: np.ndarray,
            region: BaseGeometry | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Candidate viewing points: (xy, road index, is-parking mask).

    Points come from drivable, non-highway roads within ACCESS_SEARCH_M of `area` (clipped to
    `region` when given), sampled every ROAD_SAMPLE_STEP_M, plus parking places in that zone
    (snapped to the nearest such road for class/paved). Road samples are thinned to the
    MAX_VIEWING_CANDIDATES budget; parking points are always kept.
    """
    empty = (np.empty((0, 2)), np.empty(0, dtype=np.int64), np.empty(0, dtype=bool))
    if roads.tree is None:
        return empty
    zone = area.buffer(config.ACCESS_SEARCH_M)
    if region is not None:
        zone = zone.intersection(region)
    if zone.is_empty:
        return empty
    shapely.prepare(zone)
    idx = roads.tree.query(zone, predicate="intersects")
    idx = idx[~np.isin(roads.classes[idx], list(config.HIGHWAY_CLASSES))]  # never stop on a motorway
    if len(idx) == 0:
        return empty

    parts = shapely.intersection(roads.geoms[idx], zone)
    keep = ~shapely.is_empty(parts)
    parts, idx = parts[keep], idx[keep]
    coords, which = shapely.get_coordinates(shapely.segmentize(parts, config.ROAD_SAMPLE_STEP_M),
                                            return_index=True)
    road_xy, road_idx = coords, idx[which].astype(np.int64)

    park_xy, park_idx = np.empty((0, 2)), np.empty(0, dtype=np.int64)
    if len(parking_xy) and len(idx):
        inside = shapely.contains_xy(zone, parking_xy[:, 0], parking_xy[:, 1])
        park_xy = parking_xy[inside]
        if len(park_xy):
            d = shapely.distance(shapely.points(park_xy)[:, None], roads.geoms[idx][None, :])
            park_idx = idx[np.argmin(d, axis=1)].astype(np.int64)

    budget = max(config.MAX_VIEWING_CANDIDATES - len(park_xy), 0)
    if len(road_xy) > budget:
        sel = np.linspace(0, len(road_xy) - 1, budget).astype(np.int64)
        road_xy, road_idx = road_xy[sel], road_idx[sel]
    xy = np.vstack([road_xy, park_xy]) if len(park_xy) else road_xy
    if len(xy) == 0:
        return empty
    is_parking = np.concatenate([np.zeros(len(road_xy), dtype=bool), np.ones(len(park_xy), dtype=bool)])
    return xy, np.concatenate([road_idx, park_idx]), is_parking


def sample_points(area: BaseGeometry, roads: RoadNetwork, parking_xy: np.ndarray,
                  region: BaseGeometry | None = None) -> tuple[np.ndarray, np.ndarray]:
    xy, road_idx, _ = _sample(area, roads, parking_xy, region)
    return xy, road_idx


def find_viewing_point(area: BaseGeometry, roads: RoadNetwork, grid: DarknessGrid,
                       projector: Projector, parking_xy: np.ndarray,
                       region: BaseGeometry | None = None) -> ViewingPoint | None:
    """Darkest reachable point (ties within DARKNESS_TIE_MAG: nearest the area centroid).
    `region` (projected metres) keeps the point inside the metro.

    `parking` is true when the point is a parking place, a parking place lies within
    ACCESS_SEARCH_M of the point, or a parking place lies in the spot's access zone (within
    ACCESS_SEARCH_M of `area`), e.g. a lot inside the park.
    """
    xy, road_idx, is_parking = _sample(area, roads, parking_xy, region)
    if len(xy) == 0:
        return None
    sqm = grid.sample(xy[:, 0], xy[:, 1])
    finite = np.isfinite(sqm)
    if not finite.any():
        return None
    ok = finite & (sqm >= np.nanmax(sqm) - config.DARKNESS_TIE_MAG)
    c = area.centroid
    dist = np.hypot(xy[:, 0] - c.x, xy[:, 1] - c.y)
    dist[~ok] = np.inf
    k = int(np.argmin(dist))
    lon, lat = projector.to_lonlat(xy[k, 0], xy[k, 1])
    r = int(road_idx[k])
    near = (len(parking_xy) > 0 and
            bool(np.any(np.hypot(parking_xy[:, 0] - xy[k, 0], parking_xy[:, 1] - xy[k, 1]) <= config.ACCESS_SEARCH_M)))
    radiance = float(grid.sample_radiance(xy[k, 0], xy[k, 1])[0])
    return ViewingPoint(float(xy[k, 0]), float(xy[k, 1]), float(lon), float(lat), float(sqm[k]),
                        str(roads.classes[r]), bool(roads.paved[r]),
                        radiance=radiance, parking=bool(is_parking.any()) or near)

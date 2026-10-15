"""Drivable road network, access checks, and darkest-reachable viewing point."""
from __future__ import annotations

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


def sample_points(area: BaseGeometry, roads: RoadNetwork, parking_xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    empty = (np.empty((0, 2)), np.empty(0, dtype=np.int64))
    if roads.tree is None:
        return empty
    zone = area.buffer(config.ACCESS_SEARCH_M)
    idx = roads.tree.query(zone, predicate="intersects")
    xy_parts, road_parts = [], []
    for i in idx:
        part = roads.geoms[i].intersection(zone)
        if part.is_empty:
            continue
        coords = shapely.get_coordinates(shapely.segmentize(part, config.ROAD_SAMPLE_STEP_M))
        xy_parts.append(coords)
        road_parts.append(np.full(len(coords), i, dtype=np.int64))
    if len(idx) and len(parking_xy):
        inside = shapely.contains_xy(zone, parking_xy[:, 0], parking_xy[:, 1])
        for x, y in parking_xy[inside]:
            p = shapely.Point(x, y)
            nearest = min(idx, key=lambda j: roads.geoms[j].distance(p))
            xy_parts.append(np.array([[x, y]]))
            road_parts.append(np.array([nearest], dtype=np.int64))
    if not xy_parts:
        return empty
    xy, road_idx = np.vstack(xy_parts), np.concatenate(road_parts)
    if len(xy) > config.MAX_VIEWING_CANDIDATES:
        keep = np.linspace(0, len(xy) - 1, config.MAX_VIEWING_CANDIDATES).astype(np.int64)
        xy, road_idx = xy[keep], road_idx[keep]
    return xy, road_idx


def find_viewing_point(area: BaseGeometry, roads: RoadNetwork, grid: DarknessGrid,
                       projector: Projector, parking_xy: np.ndarray) -> ViewingPoint | None:
    xy, road_idx = sample_points(area, roads, parking_xy)
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
    return ViewingPoint(float(xy[k, 0]), float(xy[k, 1]), float(lon), float(lat), float(sqm[k]),
                        str(roads.classes[r]), bool(roads.paved[r]))

"""Projection between EPSG:4326 and a metro's UTM zone (metres)."""
from __future__ import annotations

import numpy as np
import shapely
from pyproj import Transformer


class Projector:
    def __init__(self, epsg: int) -> None:
        self.epsg = epsg
        self._fwd = Transformer.from_crs(4326, epsg, always_xy=True)
        self._inv = Transformer.from_crs(epsg, 4326, always_xy=True)

    def to_xy(self, lon, lat):
        return self._fwd.transform(lon, lat)

    def to_lonlat(self, x, y):
        return self._inv.transform(x, y)

    def geoms_to_xy(self, geoms: np.ndarray) -> np.ndarray:
        def fn(coords: np.ndarray) -> np.ndarray:
            x, y = self._fwd.transform(coords[:, 0], coords[:, 1])
            return np.column_stack([x, y])

        return shapely.transform(np.asarray(geoms, dtype=object), fn)

    @staticmethod
    def _edges(a0: float, b0: float, a1: float, b1: float) -> tuple[np.ndarray, np.ndarray]:
        t = np.linspace(0.0, 1.0, 21)
        xs = np.concatenate([a0 + (a1 - a0) * t, np.full(21, a1), a0 + (a1 - a0) * t, np.full(21, a0)])
        ys = np.concatenate([np.full(21, b0), b0 + (b1 - b0) * t, np.full(21, b1), b0 + (b1 - b0) * t])
        return xs, ys

    def bbox_xy(self, bbox) -> tuple[float, float, float, float]:
        w, s, e, n = bbox
        lons, lats = self._edges(w, s, e, n)
        x, y = self.to_xy(lons, lats)
        return float(np.min(x)), float(np.min(y)), float(np.max(x)), float(np.max(y))

    def region_xy(self, bbox, edge_points: int = 101, inset_m: float = 1.0) -> shapely.Polygon:
        """The lon/lat bbox as a densified polygon in projected metres, inset slightly so points
        inside it are strictly inside the lon/lat box after rounding."""
        w, s, e, n = bbox
        t = np.linspace(0.0, 1.0, edge_points)[:-1]
        lons = np.concatenate([w + (e - w) * t, np.full(t.size, e), e - (e - w) * t, np.full(t.size, w)])
        lats = np.concatenate([np.full(t.size, s), s + (n - s) * t, np.full(t.size, n), n - (n - s) * t])
        x, y = self.to_xy(lons, lats)
        poly = shapely.Polygon(np.column_stack([x, y]))
        return poly.buffer(-inset_m) if inset_m else poly

    def bbox_lonlat(self, xy_bbox) -> tuple[float, float, float, float]:
        minx, miny, maxx, maxy = xy_bbox
        xs, ys = self._edges(minx, miny, maxx, maxy)
        lon, lat = self.to_lonlat(xs, ys)
        return float(np.min(lon)), float(np.min(lat)), float(np.max(lon)), float(np.max(lat))

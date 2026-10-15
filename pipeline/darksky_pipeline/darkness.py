"""Sky-brightness (SQM) grid from VIIRS night-lights radiance.

Sky glow at a cell is a distance-weighted average of surrounding radiance
(weights ∝ d^-exponent within radius), converted to SQM with
    sqm = NATURAL_SQM - 2.5 * log10(1 + glow / k).
The grid is padded by `radius` so lights just outside the region still count.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from rasterio.windows import from_bounds
from scipy.signal import fftconvolve

from . import config
from .config import BBox
from .geo import Projector


def sqm_from_glow(glow, k: float = config.SKYGLOW_K) -> np.ndarray:
    g = np.maximum(np.asarray(glow, dtype=np.float64), 0.0)
    return (config.NATURAL_SQM - 2.5 * np.log10(1.0 + g / k)).astype(np.float32)


def sky_label(sqm: float) -> str:
    for threshold, label in config.SKY_LABELS:
        if sqm >= threshold:
            return label
    return config.SKY_LABELS[-1][1]


def bortle(sqm: float) -> int:
    for threshold, value in config.BORTLE_THRESHOLDS:
        if sqm >= threshold:
            return value
    return config.BORTLE_THRESHOLDS[-1][1]


def brightness_ratio(sqm_dark: float, sqm_bright: float) -> float:
    """How many times darker the sky at `sqm_dark` is than at `sqm_bright`."""
    return float(10 ** (0.4 * (sqm_dark - sqm_bright)))


def skyglow_kernel(res_m: float, radius_m: float, exponent: float) -> np.ndarray:
    n = int(radius_m // res_m)
    yy, xx = np.mgrid[-n:n + 1, -n:n + 1]
    d = np.hypot(xx, yy) * res_m
    w = (np.maximum(d, res_m / 2.0) / 1000.0) ** -exponent
    w[d > radius_m] = 0.0
    return w / w.sum()


@dataclass
class DarknessGrid:
    sqm: np.ndarray  # float32, rows x cols, row 0 = north
    x0: float        # west edge, metres
    y0: float        # north edge, metres
    res: float
    epsg: int

    def sample(self, x, y) -> np.ndarray:
        x = np.atleast_1d(np.asarray(x, dtype=np.float64))
        y = np.atleast_1d(np.asarray(y, dtype=np.float64))
        col = np.floor((x - self.x0) / self.res).astype(np.int64)
        row = np.floor((self.y0 - y) / self.res).astype(np.int64)
        h, w = self.sqm.shape
        ok = (col >= 0) & (col < w) & (row >= 0) & (row < h)
        out = np.full(x.shape, np.nan, dtype=np.float64)
        out[ok] = self.sqm[row[ok], col[ok]]
        return out

    def save(self, path: Path) -> None:
        np.savez_compressed(path, sqm=self.sqm,
                            meta=np.array([self.x0, self.y0, self.res, self.epsg], dtype=np.float64))

    @classmethod
    def load(cls, path: Path) -> "DarknessGrid":
        with np.load(path) as z:
            meta = z["meta"]
            return cls(sqm=z["sqm"], x0=float(meta[0]), y0=float(meta[1]), res=float(meta[2]), epsg=int(meta[3]))


def build_darkness_grid(viirs_path: Path, bbox: BBox, epsg: int,
                        res_m: float = config.GRID_RES_M, radius_m: float = config.SKYGLOW_RADIUS_M,
                        exponent: float = config.SKYGLOW_EXPONENT, k: float = config.SKYGLOW_K) -> DarknessGrid:
    projector = Projector(epsg)
    minx, miny, maxx, maxy = projector.bbox_xy(bbox)
    minx, miny = math.floor(minx / res_m) * res_m, math.floor(miny / res_m) * res_m
    maxx, maxy = math.ceil(maxx / res_m) * res_m, math.ceil(maxy / res_m) * res_m
    cols, rows = round((maxx - minx) / res_m), round((maxy - miny) / res_m)
    n = int(radius_m // res_m)
    pad = n * res_m

    radiance = np.full((rows + 2 * n, cols + 2 * n), np.nan, dtype=np.float32)
    dst_transform = from_origin(minx - pad, maxy + pad, res_m, res_m)
    lon_w, lat_s, lon_e, lat_n = projector.bbox_lonlat((minx - pad, miny - pad, maxx + pad, maxy + pad))
    with rasterio.open(viirs_path) as src:
        window = from_bounds(lon_w - 0.05, lat_s - 0.05, lon_e + 0.05, lat_n + 0.05,
                             transform=src.transform).round_offsets().round_lengths()
        fill = src.nodata if src.nodata is not None else 0.0
        data = src.read(1, window=window, boundless=True, fill_value=fill).astype(np.float32)
        reproject(source=data, destination=radiance,
                  src_transform=src.window_transform(window), src_crs=src.crs, src_nodata=src.nodata,
                  dst_transform=dst_transform, dst_crs=CRS.from_epsg(epsg), dst_nodata=np.nan,
                  resampling=Resampling.average)
    radiance = np.nan_to_num(radiance, nan=0.0)
    radiance[radiance < 0] = 0.0

    glow = fftconvolve(radiance, skyglow_kernel(res_m, radius_m, exponent), mode="same")
    glow = glow[n:n + rows, n:n + cols]
    return DarknessGrid(sqm=sqm_from_glow(glow, k), x0=minx, y0=maxy, res=float(res_m), epsg=epsg)

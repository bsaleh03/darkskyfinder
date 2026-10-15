"""Writes a small fake VIIRS radiance GeoTIFF (EPSG:4326) for tests."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

from overture_fixture import CITY

NODATA = -9999.0


def write_viirs_fixture(path: Path, blobs=((CITY[0], CITY[1], 0.03, 60.0),),
                        bounds=(-85.2, 41.2, -83.2, 42.6), res=0.005, base=0.2,
                        with_bad_values=True) -> Path:
    w, s, e, n = bounds
    cols, rows = round((e - w) / res), round((n - s) / res)
    lon = w + (np.arange(cols) + 0.5) * res
    lat = n - (np.arange(rows) + 0.5) * res
    LON, LAT = np.meshgrid(lon, lat)
    data = np.full((rows, cols), base, dtype=np.float32)
    for bx, by, r, v in blobs:
        data[(LON - bx) ** 2 + (LAT - by) ** 2 <= r * r] = v
    if with_bad_values:
        data[(LON >= -84.95) & (LON <= -84.90) & (LAT >= 41.90) & (LAT <= 42.00)] = NODATA
        data[(LON >= -84.60) & (LON <= -84.55) & (LAT >= 41.50) & (LAT <= 41.55)] = -1.5
    with rasterio.open(path, "w", driver="GTiff", height=rows, width=cols, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(w, n, res, res), nodata=NODATA) as dst:
        dst.write(data, 1)
    return path

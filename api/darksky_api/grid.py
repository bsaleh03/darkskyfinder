"""Sky-brightness (SQM) grid written by the pipeline (darkness_<metro>.npz)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from pyproj import Transformer


@dataclass
class DarknessGrid:
    sqm: np.ndarray
    x0: float
    y0: float
    res: float
    epsg: int

    def __post_init__(self) -> None:
        self._fwd = Transformer.from_crs(4326, self.epsg, always_xy=True)

    @classmethod
    def load(cls, path: Path) -> "DarknessGrid":
        with np.load(path) as z:
            meta = z["meta"]
            return cls(sqm=np.array(z["sqm"]), x0=float(meta[0]), y0=float(meta[1]), res=float(meta[2]),
                       epsg=int(meta[3]))

    def sample_lonlat(self, lon: float, lat: float) -> float:
        x, y = self._fwd.transform(lon, lat)
        col = math.floor((x - self.x0) / self.res)
        row = math.floor((self.y0 - y) / self.res)
        h, w = self.sqm.shape
        if not (0 <= row < h and 0 <= col < w):
            return float("nan")
        return float(self.sqm[row, col])

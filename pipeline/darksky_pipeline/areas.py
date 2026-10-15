"""Which named Overture division area contains a point (for the spot `area` label)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import shapely

from .util import wkb_to_geoms

# Lower rank wins: locality, then neighborhood, then county.
_RANK = {"locality": 0, "localadmin": 0, "neighborhood": 1, "macrohood": 1, "microhood": 1, "county": 2}


class AreaFinder:
    def __init__(self, divisions: pd.DataFrame):
        d = divisions[divisions["name"].notna() & divisions["subtype"].isin(_RANK)].reset_index(drop=True)
        d = d[d["name"].astype(str).str.strip() != ""].reset_index(drop=True)
        self._names = [str(n).strip() for n in d["name"]]
        self._ranks = [_RANK[s] for s in d["subtype"]]
        geoms = wkb_to_geoms(d["wkb"]) if len(d) else np.array([], dtype=object)
        self._areas = [g.area for g in geoms]
        self._tree = shapely.STRtree(geoms) if len(d) else None

    def area_for(self, lon: float, lat: float) -> str | None:
        if self._tree is None:
            return None
        hits = self._tree.query(shapely.Point(lon, lat), predicate="intersects")
        if len(hits) == 0:
            return None
        best = min((int(i) for i in hits), key=lambda i: (self._ranks[i], self._areas[i], self._names[i]))
        return self._names[best]

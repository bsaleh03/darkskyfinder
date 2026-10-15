"""Candidate stargazing spots from Overture places and park polygons."""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
import shapely
from shapely.geometry.base import BaseGeometry

from . import config
from .geo import Projector
from .util import wkb_to_geoms


@dataclass
class Candidate:
    id: str
    name: str
    category: str
    lon: float
    lat: float
    area: BaseGeometry  # UTM metres; where to look for a viewing point
    source: str         # "place+polygon" | "place" | "polygon"


def _polygonal(geom: BaseGeometry) -> BaseGeometry | None:
    geom = shapely.make_valid(geom)
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else None


def _park_polygons(land_use: pd.DataFrame, projector: Projector) -> tuple[list[BaseGeometry], list[tuple]]:
    lu = land_use[land_use["subtype"].isin(config.PARK_SUBTYPES)].reset_index(drop=True)
    if len(lu) == 0:
        return [], []
    polys, rows = [], []
    geoms = projector.geoms_to_xy(wkb_to_geoms(lu["wkb"]))
    for row, g in zip(lu[["id", "name", "subtype"]].itertuples(index=False), geoms):
        g = _polygonal(g)
        if g is None or g.area < config.MIN_PARK_AREA_M2:
            continue
        polys.append(g)
        rows.append(tuple(row))
    return polys, rows


def build_candidates(places: pd.DataFrame, land_use: pd.DataFrame, projector: Projector) -> list[Candidate]:
    polys, poly_rows = _park_polygons(land_use, projector)
    tree = shapely.STRtree(polys) if polys else None

    sel = places[places["category"].isin(config.SPOT_CATEGORIES)
                 & (places["confidence"] >= config.MIN_PLACE_CONFIDENCE)
                 & places["name"].notna()]
    sel = sel[sel["name"].str.strip() != ""]
    sel = sel.sort_values(["confidence", "id"], ascending=[False, True])

    claimed: dict[int, tuple] = {}
    lone: list[tuple] = []
    for row in sel[["id", "name", "category", "lon", "lat"]].itertuples(index=False):
        x, y = projector.to_xy(row.lon, row.lat)
        pt = shapely.Point(x, y)
        hits = tree.query(pt, predicate="within") if tree is not None else []
        if len(hits):
            i = int(min(hits, key=lambda j: polys[j].area))
            claimed.setdefault(i, (row, pt))  # rows are sorted best-first
        else:
            lone.append((row, pt))

    out: list[Candidate] = []
    for i, (row, _) in claimed.items():
        out.append(Candidate(row.id, row.name.strip(), row.category, float(row.lon), float(row.lat),
                             polys[i], "place+polygon"))
    for row, pt in lone:
        out.append(Candidate(row.id, row.name.strip(), row.category, float(row.lon), float(row.lat),
                             pt.buffer(config.PLACE_ONLY_RADIUS_M), "place"))
    for i, ((pid, name, subtype), g) in enumerate(zip(poly_rows, polys)):
        if i in claimed or not isinstance(name, str) or not name.strip():
            continue
        rp = g.representative_point()
        lon, lat = projector.to_lonlat(rp.x, rp.y)
        out.append(Candidate(pid, name.strip(), str(subtype), float(lon), float(lat), g, "polygon"))
    return sorted(out, key=lambda c: c.id)

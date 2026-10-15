"""Candidate stargazing spots from Overture places and park polygons."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
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


_PARK_PLACE_CATEGORIES = frozenset({"park", "state_park", "national_park", "nature_reserve"})


def normalize_name(name) -> str:
    """Lowercase, alphanumerics only: 'Foo Park!' == 'foo park'."""
    return "".join(ch for ch in name.lower() if ch.isalnum()) if isinstance(name, str) else ""


def _park_polygons(land_use: pd.DataFrame, projector: Projector) -> tuple[list[BaseGeometry], list[tuple]]:
    lu = land_use[land_use["subtype"].isin(config.PARK_SUBTYPES)
                  & ~land_use["class"].isin(config.LAND_USE_CLASS_DENYLIST)].reset_index(drop=True)
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


def _merge_same_name(polys: list[BaseGeometry], rows: list[tuple]) -> tuple[list[BaseGeometry], list[tuple]]:
    """Merge same-named polygons that overlap heavily (nested, or duplicate park/protected records).

    Two polygons with the same normalized name merge when one contains the other's representative
    point or their IoU exceeds 0.8. A merged group keeps the row of its largest member (ties: id).
    """
    if len(polys) < 2:
        return polys, rows
    names = [normalize_name(r[1]) for r in rows]
    parent = list(range(len(polys)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    arr = np.array(polys, dtype=object)
    left, right = shapely.STRtree(arr).query(arr, predicate="intersects")
    for a, b in zip(left.tolist(), right.tolist()):
        if a >= b or not names[a] or names[a] != names[b]:
            continue
        pa, pb = polys[a], polys[b]
        heavy = pa.contains(pb.representative_point()) or pb.contains(pa.representative_point())
        if not heavy:
            union = pa.union(pb).area
            heavy = union > 0 and pa.intersection(pb).area / union > 0.8
        if heavy:
            parent[find(a)] = find(b)

    groups: dict[int, list[int]] = {}
    for i in range(len(polys)):
        groups.setdefault(find(i), []).append(i)
    out_polys, out_rows = [], []
    for members in groups.values():
        lead = min(members, key=lambda j: (-polys[j].area, str(rows[j][0])))
        out_polys.append(polys[lead] if len(members) == 1 else shapely.union_all([polys[j] for j in members]))
        out_rows.append(rows[lead])
    return out_polys, out_rows


def build_candidates(places: pd.DataFrame, land_use: pd.DataFrame, projector: Projector) -> list[Candidate]:
    polys, poly_rows = _merge_same_name(*_park_polygons(land_use, projector))
    tree = shapely.STRtree(polys) if polys else None
    poly_names = [normalize_name(r[1]) for r in poly_rows]

    sel = places[places["category"].isin(config.SPOT_CATEGORIES)
                 & (places["confidence"] >= config.MIN_PLACE_CONFIDENCE)
                 & places["name"].notna()]
    sel = sel[sel["name"].str.strip() != ""].copy()
    # Who gets to name a polygon: park-like categories first, then confidence, then id.
    sel["_prio"] = (~sel["category"].isin(_PARK_PLACE_CATEGORIES)).astype(int)
    sel = sel.sort_values(["_prio", "confidence", "id"], ascending=[True, False, True])

    claimed: dict[int, tuple] = {}
    lone: list[tuple] = []
    for row in sel[["id", "name", "category", "lon", "lat"]].itertuples(index=False):
        x, y = projector.to_xy(row.lon, row.lat)
        pt = shapely.Point(x, y)
        hits = ([int(j) for j in tree.query(pt, predicate="dwithin", distance=config.PLACE_POLYGON_TOLERANCE_M)]
                if tree is not None else [])
        name = normalize_name(row.name)
        named = [j for j in hits if poly_names[j] and poly_names[j] == name]
        if row.category in config.LIKELY_CATEGORIES:
            # Campgrounds, observatories, launches are never absorbed by an enclosing park; they
            # only take (or dedupe against) a polygon carrying their own name.
            hits = named
        elif named:
            hits = named
        if hits:
            i = min(hits, key=lambda j: (-polys[j].area, str(poly_rows[j][0])))
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

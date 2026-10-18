"""Inputs for the pre-rendered per-region map pictures (the app shows pictures, not a live map).

Writes to <out>/<metro>/: extent.json (bounds, level-0 full size, levels), glow/ (the glow at every level in
STATIC_MAP_LEVELS: L0.png, L0_red.png and, for l >= 1, L{l}_{c}_{r}.png / L{l}_{c}_{r}_red.png; all Web Mercator,
each the level-0 full size, level l cutting the extent METROS[key].tiles_bbox into 2^l x 2^l equal Mercator
pictures, column c from the west, row r from the north), glow.png / glow_red.png (copies of the level-0 glow for
the render step), labels.json (localities by importance) and borders.geojson (country/state borders cut to land).
A later render step draws the base pictures and resizes everything.

    python -m darksky_pipeline.static_maps --metro se_mi --viirs data/viirs/vnl_annual.tif \
        --tiles-release 2026-09-23.1 --out out/maps
"""
from __future__ import annotations

import argparse
import json
import math
import re
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
import shapely
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.errors import NotGeoreferencedWarning
from rasterio.transform import from_bounds, from_origin
from rasterio.warp import Resampling, reproject

from . import config
from .config import METROS, BBox
from .darkness import DarknessGrid, build_darkness_grid
from .tiles import RED_STOPS, sqm_to_rgba

_TO_MERCATOR = Transformer.from_crs(4326, 3857, always_xy=True)


def mercator_bounds(bbox: BBox) -> tuple[float, float, float, float]:
    """A lon/lat rectangle is an exact rectangle in Web Mercator, so its corners are enough."""
    w, s, e, n = bbox
    (x0, x1), (y0, y1) = _TO_MERCATOR.transform([w, e], [s, n])
    return x0, y0, x1, y1


def image_size(bbox: BBox, max_pixels: int = config.STATIC_MAP_MAX_PIXELS) -> tuple[int, int]:
    """Largest (width, height) within max_pixels with the bbox's Web Mercator aspect; width a multiple of 4
    so the ½ and ¼ sizes are whole pixels."""
    x0, y0, x1, y1 = mercator_bounds(bbox)
    aspect = (y1 - y0) / (x1 - x0)
    width = int(math.sqrt(max_pixels / aspect)) // 4 * 4
    while width > 4 and width * round(width * aspect) > max_pixels:
        width -= 4
    return width, max(1, round(width * aspect))


def tile_bounds(bbox: BBox, level: int, col: int, row: int) -> tuple[float, float, float, float]:
    """Web Mercator (x0, y0, x1, y1) of picture (col, row) at `level`: the extent cut into 2^level x 2^level
    equal parts, col 0 at the west edge, row 0 at the north edge. Neighbours share edges exactly."""
    x0, y0, x1, y1 = mercator_bounds(bbox)
    n = 2 ** level
    fx = lambda i: x0 + (x1 - x0) * i / n  # noqa: E731
    fy = lambda i: y1 - (y1 - y0) * i / n  # noqa: E731
    return fx(col), fy(row + 1), fx(col + 1), fy(row)


def glow_tile_sqm(grid: DarknessGrid, bbox: BBox, level: int, col: int, row: int,
                  width0: int, height0: int) -> np.ndarray:
    """The darkness grid warped (cubic, so the glow stays smooth when magnified) onto picture (col, row) at `level`,
    width0 x height0 pixels."""
    sqm = np.full((height0, width0), np.nan, dtype=np.float32)
    reproject(source=grid.sqm.astype(np.float32), destination=sqm,
              src_transform=from_origin(grid.x0, grid.y0, grid.res, grid.res), src_crs=CRS.from_epsg(grid.epsg),
              src_nodata=np.nan, dst_transform=from_bounds(*tile_bounds(bbox, level, col, row), width0, height0),
              dst_crs=CRS.from_epsg(3857), dst_nodata=np.nan, resampling=Resampling.cubic)
    return sqm  # sqm_to_rgba clamps to the ramp, so cubic overshoot cannot leave it


def glow_tile_rgba(grid: DarknessGrid, bbox: BBox, level: int, col: int, row: int, width0: int, height0: int,
                   stops: np.ndarray | None = None) -> np.ndarray:
    return sqm_to_rgba(glow_tile_sqm(grid, bbox, level, col, row, width0, height0), stops)


def glow_rgba(grid: DarknessGrid, bbox: BBox, width: int, height: int,
              stops: np.ndarray | None = None) -> np.ndarray:
    """The whole extent (level 0) at width x height, colored with the glow ramp."""
    return glow_tile_rgba(grid, bbox, 0, 0, 0, width, height, stops)


def write_png(rgba: np.ndarray, path: Path) -> None:
    h, w, _ = rgba.shape
    # Not georeferenced on purpose: extent.json carries the bounds, and no .aux.xml sidecar is written.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with rasterio.open(path, "w", driver="PNG", width=w, height=h, count=4, dtype="uint8") as dst:
            dst.write(np.moveaxis(rgba, -1, 0))


# --- Labels -----------------------------------------------------------------------

def _bbox_where(bbox: BBox) -> str:
    w, s, e, n = bbox
    return f"bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}"


def _divisions_from(release: str, type_: str, source_root: str = config.OVERTURE_S3_ROOT) -> str:
    return (f"read_parquet('{source_root.rstrip('/')}/{release}/theme=divisions/type={type_}/*', "
            f"hive_partitioning=false)")


def labels_query(release: str, bbox: BBox, source_root: str = config.OVERTURE_S3_ROOT) -> str:
    # Prominence lives in the `cartography` struct (the tiles' @prominence); either it or population may be null.
    return (
        "SELECT names.primary AS name, ST_X(ST_Centroid(geometry)) AS lon, ST_Y(ST_Centroid(geometry)) AS lat, "
        "population, cartography.prominence AS prominence "
        f"FROM {_divisions_from(release, 'division', source_root)} "
        f"WHERE subtype = 'locality' AND {_bbox_where(bbox)}"
    )


# Overture lists Michigan's townships as localities ("Canton Charter", "Redford Township") next to the towns they
# surround: show them without the suffix, and keep only the more important of two same-named places this close.
_TOWNSHIP_SUFFIX = re.compile(r"\s+(?:Charter\s+Township|Charter\s+Twp|Charter|Township|Twp)\.?$", re.IGNORECASE)
LABEL_SAME_NAME_KM = 5.0


def _display_name(name: str) -> str:
    stripped = _TOWNSHIP_SUFFIX.sub("", name).strip()
    return stripped or name


def _km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return 6371.0 * math.hypot(x, math.radians(lat2 - lat1))


def labels_json(df: pd.DataFrame, limit: int = config.STATIC_MAP_LABEL_LIMIT) -> list[dict]:
    """Localities by importance (population, then prominence; unknowns last), rank 1 = most important.

    Township suffixes are stripped for display; of two places with the same display name within
    LABEL_SAME_NAME_KM only the more important one is kept; then duplicates on (name, rounded position) go.
    """
    df = df[df["name"].notna() & (df["name"].astype(str).str.strip() != "")].copy()
    df["name"] = df["name"].astype(str).str.strip().map(_display_name)
    df["lon"], df["lat"] = df["lon"].astype(float).round(5), df["lat"].astype(float).round(5)
    df = df.sort_values(["population", "prominence", "name"], ascending=[False, False, True],
                        na_position="last", kind="stable")
    kept: dict[str, list[tuple[float, float]]] = {}
    keep = []
    for r in df.itertuples(index=False):
        near = any(_km(r.lon, r.lat, lon, lat) <= LABEL_SAME_NAME_KM for lon, lat in kept.get(r.name, []))
        keep.append(not near)
        if not near:
            kept.setdefault(r.name, []).append((r.lon, r.lat))
    df = df[keep].drop_duplicates(subset=["name", "lon", "lat"]).head(limit)
    return [{"name": str(r.name), "lon": float(r.lon), "lat": float(r.lat), "rank": i}
            for i, r in enumerate(df.itertuples(index=False), start=1)]


def write_labels(release: str, bbox: BBox, out_dir: Path) -> Path:
    from .extract import connect
    con = connect()
    labels = labels_json(con.execute(labels_query(release, bbox)).df())
    con.close()
    out = Path(out_dir) / "labels.json"
    out.write_text(json.dumps(labels, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return out


# --- Borders ----------------------------------------------------------------------

def _border_query(release: str, bbox: BBox, type_: str, select: str, where: str) -> str:
    return (f"SELECT {select} FROM {_divisions_from(release, type_)} "
            f"WHERE class = 'land' AND {where} AND {_bbox_where(bbox)}")


def _countries() -> str:
    return ", ".join(f"'{c}'" for c in sorted(config.BORDER_COUNTRIES))


def border_line_query(release: str, bbox: BBox) -> str:
    # Country-to-country borders have no `country` value in Overture (they belong to neither side).
    return _border_query(release, bbox, "division_boundary", "subtype, ST_AsWKB(geometry) AS wkb",
                         f"(subtype = 'country' OR (subtype = 'region' AND country IN ({_countries()})))")


def border_area_query(release: str, bbox: BBox) -> str:
    tol = config.BORDER_SIMPLIFY_DEG / 2
    return _border_query(release, bbox, "division_area",
                         f"ST_AsWKB(ST_SimplifyPreserveTopology(geometry, {tol})) AS wkb",
                         f"subtype = 'region' AND country IN ({_countries()})")


def border_water_query(release: str, bbox: BBox) -> str:
    """Water polygons crossed by the border lines, passed as the one WKB parameter (`?`)."""
    tol = config.BORDER_SIMPLIFY_DEG / 2
    return (f"SELECT ST_AsWKB(ST_SimplifyPreserveTopology(geometry, {tol})) AS wkb "
            f"FROM read_parquet('{config.OVERTURE_S3_ROOT.rstrip('/')}/{release}/theme=base/type=water/*', "
            f"hive_partitioning=false) "
            f"WHERE {_bbox_where(bbox)} AND ST_GeometryType(geometry) IN ('POLYGON', 'MULTIPOLYGON') "
            f"AND ST_Intersects(geometry, ST_GeomFromWKB(?))")


def _area_km2(geom) -> float:
    lat = geom.centroid.y if not geom.is_empty else 0.0
    return geom.area * 111.32 ** 2 * math.cos(math.radians(lat))


def land_borders_geojson(lines: pd.DataFrame, areas: pd.DataFrame, bbox: BBox, water: pd.DataFrame | None = None,
                         slack_deg: float = config.BORDER_LAND_SLACK_DEG,
                         simplify_deg: float = config.BORDER_SIMPLIFY_DEG,
                         water_min_km2: float = config.BORDER_WATER_MIN_KM2, decimals: int = 4) -> dict:
    """Country/state borders inside bbox, split at the shore: Overture's 'land' boundaries also run through lakes
    and rivers (e.g. US-Canada across the Great Lakes), and its 'land' region areas include their share of the
    lakes, so water polygons are cut out as well. Land stretches get water=false; for countries the water
    stretches are kept with water=true (styled dashed), while state lines in water are dropped."""
    land = shapely.union_all([shapely.from_wkb(bytes(w)) for w in areas["wkb"]])
    if slack_deg:
        land = land.buffer(slack_deg)  # keeps land borders continuous where the simplified coast wobbles
    if water is not None and len(water):
        wet = [g for g in (shapely.from_wkb(bytes(w)) for w in water["wkb"]) if _area_km2(g) >= water_min_km2]
        land = land.difference(shapely.union_all(wet))
    shapely.prepare(land)
    frame = shapely.box(*bbox)
    features = []

    def add(geom, subtype: str, water: bool) -> None:
        parts = [p for p in shapely.get_parts(shapely.get_parts(geom)) if p.geom_type == "LineString"]
        if not parts:  # touches only at points
            return
        geom = shapely.line_merge(shapely.multilinestrings(parts))  # drop touch points
        if simplify_deg:
            geom = geom.simplify(simplify_deg)
        geom = shapely.set_precision(geom, 10 ** -decimals)
        if geom.is_empty:
            return
        g = shapely.geometry.mapping(geom)
        features.append({"type": "Feature", "properties": {"subtype": subtype, "water": water},
                         "geometry": {"type": g["type"], "coordinates": _round(g["coordinates"], decimals)}})

    for subtype, wkb in zip(lines["subtype"], lines["wkb"]):
        line = shapely.from_wkb(bytes(wkb)).intersection(frame)
        if line.is_empty:
            continue
        add(line.intersection(land), str(subtype), False)
        if subtype == "country":  # the country border through lakes/rivers is still the border: drawn dashed
            add(line.difference(land), str(subtype), True)
    return {"type": "FeatureCollection", "features": features}


def _round(c, d):
    return round(c, d) if isinstance(c, float) else [_round(x, d) for x in c]


def write_land_borders(release: str, bbox: BBox, out_dir: Path) -> Path:
    from .extract import connect
    con = connect()
    lines = con.execute(border_line_query(release, bbox)).df()
    water = None
    if len(lines):
        crossed = shapely.union_all([shapely.from_wkb(bytes(w)) for w in lines["wkb"]]).intersection(shapely.box(*bbox))
        water = con.execute(border_water_query(release, bbox), [shapely.to_wkb(crossed)]).df()
    fc = land_borders_geojson(lines, con.execute(border_area_query(release, bbox)).df(), bbox, water=water)
    con.close()
    out = Path(out_dir) / "borders.geojson"
    out.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    return out


# --- Region -----------------------------------------------------------------------

def glow_tile_name(level: int, col: int, row: int, red: bool) -> str:
    stem = "L0" if level == 0 else f"L{level}_{col}_{row}"
    return f"{stem}{'_red' if red else ''}.png"


def write_glow_levels(viirs: Path, metro_key: str, out: Path, width: int, height: int) -> None:
    """The glow at every level, normal and red, from one darkness grid computed at STATIC_MAP_GLOW_RES_M with
    VIIRS cubic-resampled; plus glow.png / glow_red.png (= level 0) for the render step."""
    metro = METROS[metro_key]
    bbox = metro.tiles_bbox
    grid = build_darkness_grid(viirs, bbox, metro.utm_epsg, res_m=config.STATIC_MAP_GLOW_RES_M,
                               resampling=Resampling.cubic)
    glow = out / "glow"
    glow.mkdir(parents=True, exist_ok=True)
    for level in config.STATIC_MAP_LEVELS:
        n = 2 ** level
        for col in range(n):
            for row in range(n):
                sqm = glow_tile_sqm(grid, bbox, level, col, row, width, height)
                for red, stops in ((False, None), (True, RED_STOPS)):
                    rgba = sqm_to_rgba(sqm, stops)
                    write_png(rgba, glow / glow_tile_name(level, col, row, red))
                    if level == 0:
                        write_png(rgba, out / ("glow_red.png" if red else "glow.png"))
                del sqm


def build_static_map_inputs(metro_key: str, viirs: Path, release: str, out_root: Path,
                            max_pixels: int = config.STATIC_MAP_MAX_PIXELS) -> Path:
    metro = METROS[metro_key]
    bbox = metro.tiles_bbox
    out = Path(out_root) / metro_key
    out.mkdir(parents=True, exist_ok=True)
    width, height = image_size(bbox, max_pixels)
    write_glow_levels(Path(viirs), metro_key, out, width, height)
    (out / "extent.json").write_text(json.dumps({"bounds": list(bbox), "width": width, "height": height,
                                                 "levels": list(config.STATIC_MAP_LEVELS)}), encoding="utf-8")
    write_labels(release, bbox, out)
    write_land_borders(release, bbox, out)
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="darksky_pipeline.static_maps")
    ap.add_argument("--metro", choices=sorted(METROS), required=True)
    ap.add_argument("--viirs", required=True, help="VIIRS annual radiance GeoTIFF (EPSG:4326)")
    ap.add_argument("--tiles-release", required=True, help="Overture release for labels and borders")
    ap.add_argument("--out", default="out/maps")
    args = ap.parse_args(argv)
    t0 = time.monotonic()
    out = build_static_map_inputs(args.metro, Path(args.viirs), args.tiles_release, Path(args.out))
    print(f"wrote {out} in {time.monotonic() - t0:.0f}s")


if __name__ == "__main__":
    main()

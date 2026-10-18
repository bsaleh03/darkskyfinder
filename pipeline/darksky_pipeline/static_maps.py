"""Inputs for the pre-rendered per-region map pictures (the app shows pictures, not a live map).

Writes to <out>/<metro>/: extent.json, glow.png, glow_red.png (Web Mercator, exactly the picture extent
METROS[key].tiles_bbox), labels.json (localities by importance) and borders.geojson (country/state borders
cut to land). A later render step draws the base pictures and resizes everything.

    python -m darksky_pipeline.static_maps --metro se_mi --viirs data/viirs/vnl_annual.tif \
        --tiles-release 2026-09-23.1 --out out/maps
"""
from __future__ import annotations

import argparse
import json
import math
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


def glow_rgba(grid: DarknessGrid, bbox: BBox, width: int, height: int,
              stops: np.ndarray | None = None) -> np.ndarray:
    """The darkness grid resampled onto the picture's Web Mercator pixel grid and colored with the glow ramp."""
    sqm = np.full((height, width), np.nan, dtype=np.float32)
    reproject(source=grid.sqm.astype(np.float32), destination=sqm,
              src_transform=from_origin(grid.x0, grid.y0, grid.res, grid.res), src_crs=CRS.from_epsg(grid.epsg),
              src_nodata=np.nan, dst_transform=from_bounds(*mercator_bounds(bbox), width, height),
              dst_crs=CRS.from_epsg(3857), dst_nodata=np.nan, resampling=Resampling.bilinear)
    return sqm_to_rgba(sqm, stops)


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


def labels_json(df: pd.DataFrame, limit: int = config.STATIC_MAP_LABEL_LIMIT) -> list[dict]:
    """Localities by importance (population, then prominence; unknowns last), rank 1 = most important."""
    df = df[df["name"].notna() & (df["name"].astype(str).str.strip() != "")].copy()
    df["lon"], df["lat"] = df["lon"].astype(float).round(5), df["lat"].astype(float).round(5)
    df = df.drop_duplicates(subset=["name", "lon", "lat"])
    df = df.sort_values(["population", "prominence", "name"], ascending=[False, False, True],
                        na_position="last", kind="stable").head(limit)
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

def build_static_map_inputs(metro_key: str, viirs: Path, release: str, out_root: Path,
                            max_pixels: int = config.STATIC_MAP_MAX_PIXELS) -> Path:
    metro = METROS[metro_key]
    bbox = metro.tiles_bbox
    out = Path(out_root) / metro_key
    out.mkdir(parents=True, exist_ok=True)
    width, height = image_size(bbox, max_pixels)
    grid = build_darkness_grid(Path(viirs), bbox, metro.utm_epsg, res_m=config.STATIC_MAP_GLOW_RES_M)
    for name, stops in (("glow.png", None), ("glow_red.png", RED_STOPS)):
        write_png(glow_rgba(grid, bbox, width, height, stops), out / name)
    (out / "extent.json").write_text(json.dumps({"bounds": list(bbox), "width": width, "height": height}),
                                     encoding="utf-8")
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

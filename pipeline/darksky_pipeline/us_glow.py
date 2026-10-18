"""US-wide map layers (display only; spots keep their per-metro grids and basemaps):
the lower-48 light-pollution overlay (plus a red-only variant for red mode) and, with --tiles-release, an Overture divisions extract
for land shapes and state names, plus country/state/province borders cut to land (GeoJSON, every zoom).

    python -m darksky_pipeline.us_glow --viirs data/viirs/vnl_annual.tif --out out/us --tiles-release 2026-09-23.1
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import pandas as pd
import shapely

from . import config
from .config import BBox
from .darkness import build_darkness_grid
from .tiles import RED_STOPS, lightpollution_pmtiles_command, run_commands, write_lightpollution_tif


def build_us_glow(viirs: Path, out_dir: Path, bbox: BBox = config.US_GLOW_BBOX,
                  res_m: float = config.US_GLOW_RES_M) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    grid = build_darkness_grid(Path(viirs), bbox, config.US_GLOW_EPSG, res_m=res_m)
    lo, hi = config.US_GLOW_ZOOMS
    cmds = []
    for name, stops in (("lightpollution_us", None), ("lightpollution_us_red", RED_STOPS)):
        tif = out_dir / f"{name}.tif"
        write_lightpollution_tif(grid, tif, stops)
        cmds.append(lightpollution_pmtiles_command(tif, out_dir / f"{name}.pmtiles", minzoom=lo, maxzoom=hi))
    run_commands(cmds)
    return out_dir / "lightpollution_us.pmtiles"


def us_borders_command(tiles_release: str, out_dir: Path) -> list[str]:
    w, s, e, n = config.US_BORDERS_BBOX
    return ["pmtiles", "extract", config.OVERTURE_TILES_URL.format(release=tiles_release, theme="divisions"),
            str(Path(out_dir) / "basemap_us_divisions.pmtiles"),
            f"--bbox={w},{s},{e},{n}", f"--maxzoom={config.US_BORDERS_MAXZOOM}"]


def _divisions_query(release: str, type_: str, select: str, where: str,
                     source_root: str = config.OVERTURE_S3_ROOT) -> str:
    w, s, e, n = config.US_BORDERS_BBOX
    return (
        f"SELECT {select} FROM read_parquet('{source_root.rstrip('/')}/{release}/theme=divisions/type={type_}/*', "
        f"hive_partitioning=false) "
        f"WHERE class = 'land' AND {where} "
        f"AND bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}"
    )


def _countries() -> str:
    return ", ".join(f"'{c}'" for c in sorted(config.US_BORDER_COUNTRIES))


def border_line_query(release: str) -> str:
    # Country-to-country borders have no `country` value in Overture (they belong to neither side).
    return _divisions_query(release, "division_boundary", "subtype, ST_AsWKB(geometry) AS wkb",
                            f"(subtype = 'country' OR (subtype = 'region' AND country IN ({_countries()})))")


def border_area_query(release: str) -> str:
    tol = config.US_BORDER_SIMPLIFY_DEG / 2
    return _divisions_query(release, "division_area", f"ST_AsWKB(ST_SimplifyPreserveTopology(geometry, {tol})) AS wkb",
                            f"subtype = 'region' AND country IN ({_countries()})")


def land_borders_geojson(lines: pd.DataFrame, areas: pd.DataFrame, slack_deg: float = config.US_BORDER_LAND_SLACK_DEG,
                         simplify_deg: float = config.US_BORDER_SIMPLIFY_DEG, decimals: int = 4) -> dict:
    """Country/state borders split at the shore: Overture's 'land' boundaries also run through lakes and rivers
    (e.g. US-Canada across the Great Lakes). Land stretches get water=false; for countries the water stretches
    are kept with water=true (styled dashed), while state lines in water are dropped."""
    land = shapely.union_all([shapely.from_wkb(bytes(w)) for w in areas["wkb"]])
    if slack_deg:
        land = land.buffer(slack_deg)  # keeps land borders continuous where the simplified coast wobbles
    shapely.prepare(land)
    features = []

    def add(geom, subtype: str, water: bool) -> None:
        if simplify_deg:
            geom = geom.simplify(simplify_deg)
        geom = shapely.set_precision(geom, 10 ** -decimals)
        if geom.is_empty:
            return
        g = shapely.geometry.mapping(geom)
        features.append({"type": "Feature", "properties": {"subtype": subtype, "water": water},
                         "geometry": {"type": g["type"], "coordinates": _round(g["coordinates"], decimals)}})

    for subtype, wkb in zip(lines["subtype"], lines["wkb"]):
        line = shapely.from_wkb(bytes(wkb))
        add(line.intersection(land), str(subtype), False)
        if subtype == "country":  # the country border through lakes/rivers is still the border: drawn dashed
            add(line.difference(land), str(subtype), True)
    return {"type": "FeatureCollection", "features": features}


def _round(c, d):
    return round(c, d) if isinstance(c, float) else [_round(x, d) for x in c]


def write_land_borders(release: str, out_dir: Path) -> Path:
    from .extract import connect
    con = connect()
    fc = land_borders_geojson(con.execute(border_line_query(release)).df(), con.execute(border_area_query(release)).df())
    out = Path(out_dir) / "borders.geojson"
    out.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="darksky_pipeline.us_glow")
    ap.add_argument("--viirs", required=True, help="VIIRS annual radiance GeoTIFF (EPSG:4326)")
    ap.add_argument("--out", default="out/us")
    ap.add_argument("--tiles-release", default=None, help="Overture tiles release; also extracts US borders")
    args = ap.parse_args(argv)
    t0 = time.monotonic()
    out = build_us_glow(Path(args.viirs), Path(args.out))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.0f} MB) in {time.monotonic() - t0:.0f}s")
    if args.tiles_release:
        run_commands([us_borders_command(args.tiles_release, Path(args.out))])
        print(f"wrote {Path(args.out) / 'basemap_us_divisions.pmtiles'}")
        borders = write_land_borders(args.tiles_release, Path(args.out))
        print(f"wrote {borders} ({borders.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()

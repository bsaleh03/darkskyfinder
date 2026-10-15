"""Run the whole pipeline for one metro.

python -m darksky_pipeline.build --metro se_mi --release <R> --viirs <path.tif>
"""
from __future__ import annotations

import argparse
import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from . import config
from .amenities import AmenityFinder
from .assemble import assemble_spot, build_spots_document, write_spots_json
from .checks import CheckResult, assert_checks, run_checks
from .config import METROS, OVERTURE_S3_ROOT, Metro
from .curated import load_curated
from .darkness import build_darkness_grid
from .extract import THEMES, connect, extract_theme
from .features import GlareModel, HorizonModel, building_points
from .geo import Projector
from .roads import build_road_network, find_viewing_point, parking_points
from .search_index import build_search_index, search_rows
from .spots import build_candidates
from .tiles import (basemap_extract_commands, lightpollution_pmtiles_command, run_commands,
                    write_lightpollution_tif)

log = logging.getLogger("darksky_pipeline")

TILE_TOOLS = ("pmtiles", "rio")


def check_tile_tools() -> None:
    """Fail fast (before hours of extraction) if the tile CLIs are not on PATH."""
    missing = [t for t in TILE_TOOLS if shutil.which(t) is None]
    if missing:
        raise RuntimeError(f"tile tools not found on PATH: {', '.join(missing)} "
                           "(install go-pmtiles and `pip install -e .[tiles]` for rio-pmtiles, or use --skip-tiles)")


@dataclass
class BuildSummary:
    metro: str
    spots: int
    dropped_no_access: list[str] = field(default_factory=list)
    curated_unknown_ids: list[str] = field(default_factory=list)
    checks: list[CheckResult] = field(default_factory=list)
    out_dir: Path | None = None


def run_build(metro: Metro, release: str, viirs_path: Path, out_dir: Path, curated_path: Path | None = None,
              source_root: str = OVERTURE_S3_ROOT, cache_dir: Path | None = None,
              count_range: tuple[int, int] | None = None, skip_tiles: bool = False, strict: bool = True,
              tiles_release: str | None = None) -> BuildSummary:
    if not skip_tiles:
        check_tile_tools()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    projector = Projector(metro.utm_epsg)
    region = projector.region_xy(metro.bbox)

    log.info("extracting Overture %s for %s", release, metro.key)
    con = connect()
    frames = {k: extract_theme(con, k, metro.bbox, release, source_root=source_root, cache_dir=cache_dir)
              for k in THEMES}
    con.close()

    log.info("building darkness grid")
    grid = build_darkness_grid(Path(viirs_path), metro.bbox, metro.utm_epsg)
    grid.save(out_dir / f"darkness_{metro.key}.npz")

    curated = load_curated(curated_path) if curated_path else {}
    candidates = build_candidates(frames["places"], frames["land_use"], projector)
    log.info("%d candidate spots", len(candidates))

    roads = build_road_network(frames["segments"], projector)
    parking_xy = parking_points(frames["places"], projector)
    glare_model = GlareModel(building_points(frames["buildings"], projector), roads)
    horizon_model = HorizonModel(frames["land_cover"], frames["water"], projector)
    amenity_finder = AmenityFinder(frames["places"], projector)

    spots, dropped = [], []
    for c in candidates:
        vp = find_viewing_point(c.area, roads, grid, projector, parking_xy, region=region)
        if vp is None:
            dropped.append(c.id)
            continue
        spots.append(assemble_spot(c, vp, glare_model.at(vp.x, vp.y), horizon_model.at(vp.x, vp.y),
                                   amenity_finder.near(vp.x, vp.y), curated.get(c.id)))
    log.info("%d spots, %d dropped (no drivable access)", len(spots), len(dropped))

    doc = build_spots_document(metro.key, release, spots)
    write_spots_json(doc, out_dir / f"spots_{metro.key}.json")

    rows = search_rows(frames["places"], frames["addresses"], frames["division_areas"])
    build_search_index(rows, out_dir / f"search_{metro.key}.sqlite")
    log.info("search index: %d rows", len(rows))

    tif = out_dir / f"lightpollution_{metro.key}.tif"
    write_lightpollution_tif(grid, tif)

    results = run_checks(doc, grid, metro, projector, count_range or config.SPOT_COUNT_RANGE[metro.key])
    for r in results:
        log.info("check %-26s %s  %s", r.name, "OK  " if r.ok else "FAIL", r.detail)
    summary = BuildSummary(metro=metro.key, spots=len(spots), dropped_no_access=sorted(dropped),
                           curated_unknown_ids=sorted(set(curated) - {c.id for c in candidates}),
                           checks=results, out_dir=out_dir)
    if summary.curated_unknown_ids:
        log.warning("curated ids not found in candidates: %s", summary.curated_unknown_ids)
    if strict:
        assert_checks(results)  # before the slow tile step

    if not skip_tiles:
        run_commands([lightpollution_pmtiles_command(tif, out_dir / f"lightpollution_{metro.key}.pmtiles"),
                      *basemap_extract_commands(tiles_release or release.split(".")[0], metro.bbox,
                                                out_dir, metro.key)])
    return summary


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="darksky_pipeline.build")
    ap.add_argument("--metro", choices=sorted(METROS), required=True)
    ap.add_argument("--release", required=True, help="Overture release, e.g. 2026-09-17.0")
    ap.add_argument("--viirs", required=True, help="VIIRS annual radiance GeoTIFF (EPSG:4326)")
    ap.add_argument("--out", default="out")
    ap.add_argument("--cache", default="data/raw")
    ap.add_argument("--curated", default=None, help="default: curated/<metro>.yaml")
    ap.add_argument("--skip-tiles", action="store_true")
    ap.add_argument("--no-strict", action="store_true", help="report failed checks without failing")
    ap.add_argument("--tiles-release", default=None, help="Overture tiles release folder if it differs")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    metro = METROS[args.metro]
    if args.curated is not None:
        curated_path = Path(args.curated)
        if not curated_path.exists():
            ap.error(f"--curated file not found: {curated_path}")
    else:
        curated_path = Path(f"curated/{metro.key}.yaml")
        if not curated_path.exists():
            log.warning("default curated file %s not found; building without curated facts", curated_path)
    summary = run_build(metro, args.release, Path(args.viirs), Path(args.out) / metro.key,
                        curated_path=curated_path,
                        cache_dir=Path(args.cache) / metro.key / args.release,
                        skip_tiles=args.skip_tiles, strict=not args.no_strict, tiles_release=args.tiles_release)
    print(f"{summary.metro}: {summary.spots} spots -> {summary.out_dir}")


if __name__ == "__main__":
    main()

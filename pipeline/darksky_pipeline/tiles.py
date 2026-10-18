"""Basemap PMTiles extraction (Overture) and light-pollution overlay raster."""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from . import config
from .config import BBox
from .darkness import DarknessGrid

# t (0 = natural sky, 1 = city) -> RGBA. Indigo/violet/amber palette from the spec.
_COLOR_STOPS = np.array([
    # Transparent end carries the faint-glow colour, not black: otherwise near-transparent pixels (and
    # downsampled tile edges) are dark and lay a dark film over the basemap.
    [0.0, 58, 47, 110, 0],
    [0.2, 58, 47, 110, 90],
    [0.5, 165, 139, 224, 140],
    [0.8, 245, 201, 107, 190],
    [1.0, 255, 244, 214, 220],
], dtype=np.float64)


def basemap_extract_commands(tiles_release: str, bbox: BBox, out_dir: Path, metro_key: str, maxzoom: int = 14,
                             url_template: str = config.OVERTURE_TILES_URL) -> list[list[str]]:
    w, s, e, n = bbox
    return [["pmtiles", "extract", url_template.format(release=tiles_release, theme=theme),
             str(Path(out_dir) / f"basemap_{metro_key}_{theme}.pmtiles"),
             f"--bbox={w},{s},{e},{n}", f"--maxzoom={maxzoom}"]
            for theme in config.OVERTURE_TILE_THEMES]


# Red-mode variant: same alpha as _COLOR_STOPS, hue limited to reds so the glow keeps night vision.
RED_STOPS = np.array([
    [0.0, 120, 8, 6, 0],
    [0.2, 120, 8, 6, 90],
    [0.5, 190, 20, 15, 140],
    [0.8, 240, 45, 35, 190],
    [1.0, 255, 80, 70, 220],
], dtype=np.float64)


def sqm_to_rgba(sqm: np.ndarray, stops: np.ndarray | None = None) -> np.ndarray:
    stops = _COLOR_STOPS if stops is None else stops
    sqm = np.asarray(sqm, dtype=np.float64)
    span = config.NATURAL_SQM - config.LIGHTPOLLUTION_BRIGHT_SQM
    t = np.clip((config.NATURAL_SQM - np.nan_to_num(sqm, nan=config.NATURAL_SQM)) / span, 0.0, 1.0)
    out = np.empty(sqm.shape + (4,), dtype=np.uint8)
    for ch in range(4):
        out[..., ch] = np.round(np.interp(t, stops[:, 0], stops[:, ch + 1])).astype(np.uint8)
    return out


def write_lightpollution_tif(grid: DarknessGrid, path: Path, stops: np.ndarray | None = None) -> None:
    rgba = sqm_to_rgba(grid.sqm, stops)
    h, w = grid.sqm.shape
    with rasterio.open(path, "w", driver="GTiff", height=h, width=w, count=4, dtype="uint8",
                       crs=CRS.from_epsg(grid.epsg), transform=from_origin(grid.x0, grid.y0, grid.res, grid.res),
                       photometric="RGB", alpha="YES") as dst:
        dst.write(np.moveaxis(rgba, -1, 0))


def lightpollution_pmtiles_command(tif: Path, out: Path, minzoom: int = 6, maxzoom: int = 11) -> list[str]:
    return ["rio", "pmtiles", str(tif), str(out), "--format", "PNG", "--zoom-levels", f"{minzoom}..{maxzoom}", "--rgba"]


def run_commands(cmds: list[list[str]]) -> None:
    for cmd in cmds:
        subprocess.run(cmd, check=True)

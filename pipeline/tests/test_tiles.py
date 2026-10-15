from pathlib import Path

import numpy as np
import rasterio

from darksky_pipeline.tiles import (basemap_extract_commands, lightpollution_pmtiles_command, sqm_to_rgba,
                                    write_lightpollution_tif)


def test_basemap_commands(tmp_path):
    cmds = basemap_extract_commands("2026-09-17", (-84.6, 41.65, -82.4, 44.1), tmp_path, "se_mi")
    assert len(cmds) == 4
    first = cmds[0]
    assert first[:2] == ["pmtiles", "extract"]
    assert first[2].endswith("/2026-09-17/base.pmtiles")
    assert first[3] == str(tmp_path / "basemap_se_mi_base.pmtiles")
    assert "--bbox=-84.6,41.65,-82.4,44.1" in first and "--maxzoom=14" in first


def test_sqm_to_rgba_endpoints_and_monotonic_alpha():
    rgba = sqm_to_rgba(np.array([22.0, 21.0, 19.0, 17.0, 15.0, np.nan]))
    assert rgba.dtype == np.uint8 and rgba.shape == (6, 4)
    assert tuple(rgba[0]) == (0, 0, 0, 0)
    assert tuple(rgba[3]) == (255, 244, 214, 220) == tuple(rgba[4])
    assert rgba[0, 3] < rgba[1, 3] < rgba[2, 3] < rgba[3, 3]
    assert tuple(rgba[5]) == (0, 0, 0, 0)


def test_write_lightpollution_tif(darkness_grid, tmp_path):
    path = tmp_path / "lp.tif"
    write_lightpollution_tif(darkness_grid, path)
    with rasterio.open(path) as src:
        assert src.count == 4 and src.dtypes[0] == "uint8"
        assert src.crs.to_epsg() == darkness_grid.epsg
        assert (src.height, src.width) == darkness_grid.sqm.shape


def test_lightpollution_command():
    cmd = lightpollution_pmtiles_command(Path("a.tif"), Path("b.pmtiles"))
    assert cmd == ["rio", "pmtiles", "a.tif", "b.pmtiles", "--format", "PNG", "--zoom-levels", "6..11", "--rgba"]

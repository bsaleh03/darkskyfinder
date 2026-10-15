import math

import numpy as np
import pytest

from darksky_pipeline import config
from darksky_pipeline.darkness import (DarknessGrid, bortle, brightness_ratio, build_darkness_grid,
                                       skyglow_kernel, sky_label, sqm_from_glow)
from overture_fixture import CITY, HUDSON, REGION_BBOX, TEST_EPSG
from viirs_fixture import write_viirs_fixture


def test_sqm_from_glow_formula():
    assert sqm_from_glow(np.array([0.0]))[0] == pytest.approx(22.0)
    assert sqm_from_glow(np.array([config.SKYGLOW_K]))[0] == pytest.approx(22.0 - 2.5 * math.log10(2), abs=1e-5)
    assert sqm_from_glow(np.array([-5.0]))[0] == pytest.approx(22.0)


@pytest.mark.parametrize("sqm,label", [
    (21.6, "Milky Way vivid"), (21.3, "Milky Way vivid"), (20.9, "Milky Way visible"),
    (19.8, "Milky Way faint"), (18.0, "Milky Way not visible"),
])
def test_sky_label(sqm, label):
    assert sky_label(sqm) == label


@pytest.mark.parametrize("sqm,b", [(22.0, 1), (21.8, 3), (21.0, 4), (19.0, 6), (17.0, 8)])
def test_bortle(sqm, b):
    assert bortle(sqm) == b


def test_brightness_ratio():
    assert brightness_ratio(21.0, 18.5) == pytest.approx(10.0)


def test_kernel_is_normalized_and_circular():
    k = skyglow_kernel(500, 5_000, 2.5)
    assert k.shape == (21, 21)
    assert k.sum() == pytest.approx(1.0)
    assert k[0, 0] == 0.0  # corner is beyond radius
    assert k[10, 10] == k.max()


def test_city_is_much_brighter_than_hudson(darkness_grid, projector):
    city = darkness_grid.sample(*projector.to_xy(*CITY))[0]
    hudson = darkness_grid.sample(*projector.to_xy(*HUDSON))[0]
    assert hudson - city > 2.0
    assert sky_label(hudson) in ("Milky Way vivid", "Milky Way visible")
    assert sky_label(city) == "Milky Way not visible"


def test_grid_is_finite_despite_bad_values(darkness_grid):
    assert np.isfinite(darkness_grid.sqm).all()
    assert darkness_grid.sqm.max() <= config.NATURAL_SQM + 1e-6


def test_grid_covers_region(darkness_grid, projector):
    w, s, e, n = REGION_BBOX
    for lon, lat in [(w + 0.01, s + 0.01), (e - 0.01, n - 0.01), (w + 0.01, n - 0.01), (e - 0.01, s + 0.01)]:
        assert np.isfinite(darkness_grid.sample(*projector.to_xy(lon, lat))[0])


def test_sample_outside_is_nan(darkness_grid, projector):
    assert np.isnan(darkness_grid.sample(*projector.to_xy(-90.0, 30.0))[0])


def test_save_load_round_trip(darkness_grid, tmp_path):
    path = tmp_path / "g.npz"
    darkness_grid.save(path)
    loaded = DarknessGrid.load(path)
    assert loaded.epsg == darkness_grid.epsg and loaded.res == darkness_grid.res
    assert loaded.x0 == darkness_grid.x0 and loaded.y0 == darkness_grid.y0
    np.testing.assert_array_equal(loaded.sqm, darkness_grid.sqm)


def test_edge_glow_from_outside_region(tmp_path, projector):
    # Bright blob ~4 km east of the region's east edge (-84.00).
    tif = write_viirs_fixture(tmp_path / "edge.tif", blobs=((-83.95, 41.90, 0.03, 60.0),), with_bad_values=False)
    grid = build_darkness_grid(tif, REGION_BBOX, TEST_EPSG)
    east = grid.sample(*projector.to_xy(-84.01, 41.90))[0]
    west = grid.sample(*projector.to_xy(-84.39, 41.90))[0]
    assert west - east > 1.0

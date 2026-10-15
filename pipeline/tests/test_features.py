import pytest

from darksky_pipeline.features import (GlareModel, HorizonModel, building_points, classify_horizon,
                                       glare_penalty)
from overture_fixture import CITY, HUDSON


@pytest.mark.parametrize("b,hw,expected", [
    (0, None, 0.0), (400, None, 0.7), (800, None, 0.7), (200, None, 0.35),
    (0, 500.0, 0.3), (0, 2000.0, 0.15), (0, 5000.0, 0.0), (400, 500.0, 1.0),
])
def test_glare_penalty(b, hw, expected):
    assert glare_penalty(b, hw) == pytest.approx(expected)


@pytest.mark.parametrize("o,c,expected", [
    (0.9, 0.0, "open"), (0.6, 0.35, "partial"), (0.1, 0.8, "enclosed"), (0.3, 0.3, "partial"),
])
def test_classify_horizon(o, c, expected):
    assert classify_horizon(o, c) == expected


def test_glare_city_vs_hudson(overture_frames, road_network, projector):
    model = GlareModel(building_points(overture_frames["buildings"], projector), road_network)
    city = model.at(*projector.to_xy(*CITY))
    hudson = model.at(*projector.to_xy(*HUDSON))
    assert city.buildings_1km >= 400 and city.penalty >= 0.5
    assert hudson.buildings_1km == 5 and hudson.penalty < 0.2
    assert 3_000 < city.highway_m < 5_000
    assert hudson.highway_m > 10_000


def test_horizon_hudson_open_with_lake_and_camp_enclosed(overture_frames, projector):
    model = HorizonModel(overture_frames["land_cover"], overture_frames["water"], projector)
    hudson = model.at(*projector.to_xy(*HUDSON))
    assert hudson.cls == "open" and hudson.water_frac > 0.2
    camp = model.at(*projector.to_xy(-84.15, 41.78))
    assert camp.cls == "enclosed" and camp.closed_frac > 0.9


def test_horizon_with_no_layers(overture_frames, projector):
    model = HorizonModel(overture_frames["land_cover"].iloc[0:0], overture_frames["water"].iloc[0:0], projector)
    h = model.at(*projector.to_xy(*HUDSON))
    assert (h.open_frac, h.closed_frac, h.water_frac, h.cls) == (0.0, 0.0, 0.0, "partial")


def _water(wkts):
    import pandas as pd
    import shapely
    return pd.DataFrame([{"id": f"w{i}", "subtype": "lake", "class": "lake", "wkb": shapely.to_wkb(shapely.from_wkt(w))}
                         for i, w in enumerate(wkts)], columns=["id", "subtype", "class", "wkb"])


def _no_cover(overture_frames):
    return overture_frames["land_cover"].iloc[0:0]


def test_invalid_spiked_polygon_still_counts(overture_frames, projector):
    # M4: make_valid turns this into GEOMETRYCOLLECTION(POLYGON, LINESTRING); the polygon must be kept.
    lon, lat = HUDSON
    spiked = (f"POLYGON(({lon - 0.03} {lat - 0.03}, {lon + 0.03} {lat - 0.03}, {lon + 0.03} {lat + 0.03}, "
              f"{lon - 0.03} {lat + 0.03}, {lon - 0.03} {lat - 0.03}, {lon - 0.06} {lat - 0.06}, "
              f"{lon - 0.03} {lat - 0.03}))")
    model = HorizonModel(_no_cover(overture_frames), _water([spiked]), projector)
    assert model.at(*projector.to_xy(*HUDSON)).water_frac > 0.99


def test_bowtie_polygon_still_counts(overture_frames, projector):
    lon, lat = HUDSON
    d = 0.03
    bowtie = (f"POLYGON(({lon - d} {lat - d}, {lon + d} {lat + d}, {lon + d} {lat - d}, "
              f"{lon - d} {lat + d}, {lon - d} {lat - d}))")
    model = HorizonModel(_no_cover(overture_frames), _water([bowtie]), projector)
    assert 0.3 < model.at(*projector.to_xy(*HUDSON)).water_frac < 0.7


def test_huge_polygons_are_tiled_and_fractions_unchanged(overture_frames, projector):
    # I4: a 60 km lake is cut into <= HORIZON_TILE_M pieces once, so queries never union it whole.
    import numpy as np
    import shapely
    from darksky_pipeline import config
    lon, lat = HUDSON
    big = f"POLYGON(({lon - 0.4} {lat - 0.3}, {lon} {lat - 0.3}, {lon} {lat + 0.3}, {lon - 0.4} {lat + 0.3}, {lon - 0.4} {lat - 0.3}))"
    model = HorizonModel(_no_cover(overture_frames), _water([big]), projector)
    b = shapely.bounds(model._water.geoms)
    assert len(model._water.geoms) > 1
    assert np.all(b[:, 2] - b[:, 0] <= config.HORIZON_TILE_M + 1e-6)
    assert np.all(b[:, 3] - b[:, 1] <= config.HORIZON_TILE_M + 1e-6)
    x, y = projector.to_xy(lon, lat)  # on the lake's east edge: about half the circle is water
    assert model.at(x, y).water_frac == pytest.approx(0.5, abs=0.03)
    inner = model.at(*projector.to_xy(lon - 0.2, lat))
    assert inner.water_frac == pytest.approx(1.0, abs=1e-6)

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

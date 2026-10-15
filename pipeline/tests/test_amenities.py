import pytest

from darksky_pipeline.amenities import AmenityFinder
from overture_fixture import CITY, HUDSON


def test_hudson_has_fuel_and_food_but_no_restroom(overture_frames, projector):
    near = AmenityFinder(overture_frames["places"], projector).near(*projector.to_xy(*HUDSON))
    assert set(near) == {"restroom", "fuel", "food"}
    assert near["restroom"] is None
    assert near["fuel"].name == "Hudson Fuel" and near["fuel"].km == pytest.approx(3.4, abs=0.2)
    assert near["food"].name == "Moon Cafe" and near["food"].km == pytest.approx(4.3, abs=0.2)


def test_city_has_nothing_within_radius(overture_frames, projector):
    near = AmenityFinder(overture_frames["places"], projector).near(*projector.to_xy(*CITY))
    assert near == {"restroom": None, "fuel": None, "food": None}


def test_empty_places(overture_frames, projector):
    near = AmenityFinder(overture_frames["places"].iloc[0:0], projector).near(*projector.to_xy(*CITY))
    assert near == {"restroom": None, "fuel": None, "food": None}

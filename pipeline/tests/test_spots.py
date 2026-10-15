import math

import pandas as pd

from darksky_pipeline import config
from darksky_pipeline.spots import build_candidates


def test_candidates_from_fixture(overture_frames, projector):
    cands = {c.id: c for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
    assert sorted(cands) == ["lu_woods", "pl_camp", "pl_city", "pl_hudson"]

    hudson = cands["pl_hudson"]
    assert hudson.source == "place+polygon"
    assert hudson.name == "Lake Hudson Recreation Area"
    assert hudson.area.area > 10_000_000  # the park polygon, ~22 km²

    camp = cands["pl_camp"]
    assert camp.source == "place"
    assert math.isclose(camp.area.area, math.pi * config.PLACE_ONLY_RADIUS_M ** 2, rel_tol=0.01)

    woods = cands["lu_woods"]
    assert woods.source == "polygon" and woods.category == "protected"
    assert -84.35 < woods.lon < -84.33 and 41.95 < woods.lat < 41.97


def test_duplicate_place_in_same_park_is_dropped(overture_frames, projector):
    ids = {c.id for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
    assert "pl_hudson_launch" not in ids and "lu_hudson" not in ids


def test_nameless_lowconf_and_non_spot_places_are_dropped(overture_frames, projector):
    ids = {c.id for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
    assert not ids & {"pl_noname", "pl_lowconf", "pl_cafe", "pl_gas", "pl_lot", "lu_tiny"}


def test_works_without_land_use(overture_frames, projector):
    empty = overture_frames["land_use"].iloc[0:0]
    cands = build_candidates(overture_frames["places"], empty, projector)
    assert {c.id for c in cands} == {"pl_hudson", "pl_hudson_launch", "pl_city", "pl_camp"}
    assert all(c.source == "place" for c in cands)


def test_blank_name_is_dropped(projector):
    places = pd.DataFrame([{"id": "p", "name": "   ", "category": "park", "confidence": 0.9,
                            "lon": -84.2, "lat": 41.9}])
    land_use = pd.DataFrame(columns=["id", "name", "subtype", "class", "wkb"])
    assert build_candidates(places, land_use, projector) == []

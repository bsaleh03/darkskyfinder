import math

import pandas as pd
import shapely

from darksky_pipeline import config
from darksky_pipeline.spots import build_candidates


def test_candidates_from_fixture(overture_frames, projector):
    cands = {c.id: c for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
    # I2(e): the boat launch (a LIKELY category) is no longer absorbed by the enclosing park.
    assert sorted(cands) == ["lu_woods", "pl_camp", "pl_city", "pl_hudson", "pl_hudson_launch"]

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


def test_named_park_polygon_is_claimed_and_likely_place_stays_separate(overture_frames, projector):
    cands = {c.id: c for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}
    assert "lu_hudson" not in cands
    launch = cands["pl_hudson_launch"]
    assert launch.source == "place"
    assert math.isclose(launch.area.area, math.pi * config.PLACE_ONLY_RADIUS_M ** 2, rel_tol=0.01)


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


# --- synthetic cases (I2 / I6) ---------------------------------------------------

def _lu(rows):
    """rows: (id, name, subtype, class, (w, s, e, n) lon/lat box)."""
    return pd.DataFrame([{"id": i, "name": n, "subtype": st, "class": cl, "wkb": shapely.to_wkb(shapely.box(*b))}
                         for i, n, st, cl, b in rows], columns=["id", "name", "subtype", "class", "wkb"])


def _places(rows):
    """rows: (id, name, category, confidence, lon, lat)."""
    return pd.DataFrame([{"id": i, "name": n, "category": c, "confidence": conf, "lon": lon, "lat": lat}
                         for i, n, c, conf, lon, lat in rows],
                        columns=["id", "name", "category", "confidence", "lon", "lat"])


NO_PLACES = _places([])
OUTER = (-84.30, 41.90, -84.26, 41.93)
INNER = (-84.29, 41.91, -84.28, 41.92)


def _cands(places, land_use, projector):
    return {c.id: c for c in build_candidates(places, land_use, projector)}


def test_nested_parks_with_same_name_are_one_spot(projector):
    lu = _lu([("lu_a", "Foo Park", "park", "park", OUTER), ("lu_b", "FOO park!", "protected", "nature_reserve", INNER)])
    cands = _cands(NO_PLACES, lu, projector)
    assert list(cands) == ["lu_a"] and cands["lu_a"].source == "polygon"
    with_place = _cands(_places([("pl_foo", "Foo Park", "park", 0.9, -84.285, 41.915)]), lu, projector)
    assert list(with_place) == ["pl_foo"]
    assert with_place["pl_foo"].source == "place+polygon"
    assert with_place["pl_foo"].area.area > 10_000_000  # the merged (outer) polygon, not the inner one


def test_duplicate_park_and_protected_with_same_name_are_one_spot(projector):
    lu = _lu([("lu_p", "Bar Woods", "park", "park", OUTER),
              ("lu_q", "Bar Woods", "protected", "nature_reserve", (-84.296, 41.90, -84.256, 41.93))])
    assert list(_cands(NO_PLACES, lu, projector)) == ["lu_p"]


def test_same_name_far_apart_are_not_merged(projector):
    lu = _lu([("lu_1", "Pocket Park", "park", "park", INNER),
              ("lu_2", "Pocket Park", "park", "park", (-84.10, 41.80, -84.09, 41.81))])
    assert sorted(_cands(NO_PLACES, lu, projector)) == ["lu_1", "lu_2"]


def test_campground_inside_park_stays_a_separate_spot(projector):
    lu = _lu([("lu_big", "Big Park", "park", "park", OUTER)])
    places = _places([("pl_big", "Big Park", "park", 0.9, -84.28, 41.915),
                      ("pl_camp", "Pine Camp", "campground", 0.95, -84.27, 41.92)])
    cands = _cands(places, lu, projector)
    assert sorted(cands) == ["pl_big", "pl_camp"]
    assert cands["pl_big"].source == "place+polygon"
    assert cands["pl_camp"].source == "place"
    assert math.isclose(cands["pl_camp"].area.area, math.pi * config.PLACE_ONLY_RADIUS_M ** 2, rel_tol=0.01)


def test_likely_place_claims_its_own_named_polygon(projector):
    lu = _lu([("lu_cg", "Pine Ridge Campground", "campground", "campground", INNER)])
    places = _places([("pl_cg", "Pine Ridge Campground", "campground", 0.9, -84.285, 41.915)])
    cands = _cands(places, lu, projector)
    assert list(cands) == ["pl_cg"] and cands["pl_cg"].source == "place+polygon"


def test_place_claims_polygon_within_tolerance(projector):
    lu = _lu([("lu_e", "Edge Park", "park", "park", OUTER)])
    near = _cands(_places([("pl_near", "Edge Park", "park", 0.9, -84.2594, 41.915)]), lu, projector)  # ~50 m out
    assert list(near) == ["pl_near"] and near["pl_near"].source == "place+polygon"
    far = _cands(_places([("pl_far", "Edge Park", "park", 0.9, -84.2575, 41.915)]), lu, projector)  # ~200 m out
    assert sorted(far) == ["lu_e", "pl_far"]


def test_place_prefers_name_match_then_largest_polygon(projector):
    lu = _lu([("lu_out", "Big State Park", "park", "park", OUTER),
              ("lu_in", "Little Pond Area", "recreation", "recreation_area", INNER)])
    match = _cands(_places([("pl_pond", "Little Pond Area", "park", 0.9, -84.285, 41.915)]), lu, projector)
    assert sorted(match) == ["lu_out", "pl_pond"] and match["pl_pond"].area.area < 2_000_000
    other = _cands(_places([("pl_x", "Something Else", "park", 0.9, -84.285, 41.915)]), lu, projector)
    assert sorted(other) == ["lu_in", "pl_x"] and other["pl_x"].area.area > 10_000_000


def test_park_category_outranks_higher_confidence_viewpoint(projector):
    lu = _lu([("lu_z", "Zed", "park", "park", OUTER)])
    places = _places([("pl_view", "Beta Overlook", "scenic_viewpoint", 0.99, -84.28, 41.915),
                      ("pl_park", "Alpha", "park", 0.70, -84.27, 41.915)])
    cands = _cands(places, lu, projector)
    assert sorted(cands) == ["pl_park", "pl_view"]  # park names the polygon; the overlook stays its own spot
    assert cands["pl_park"].source == "place+polygon" and cands["pl_view"].source == "place"


def test_equal_area_tie_is_deterministic(projector):
    rows = [("lu_m2", "West Meadow", "park", "park", OUTER), ("lu_m1", "East Meadow", "park", "park", OUTER)]
    places = _places([("pl_o", "Other", "park", 0.9, -84.28, 41.915)])
    for order in (rows, rows[::-1]):
        cands = _cands(places, _lu(order), projector)
        assert sorted(cands) == ["lu_m2", "pl_o"]  # pl_o claims lu_m1 (lowest id among equal areas)


def test_denylisted_land_use_class_is_not_a_spot(projector):
    lu = _lu([("lu_pitch", "Field 5", "recreation", "pitch", OUTER)])
    assert _cands(NO_PLACES, lu, projector) == {}


def test_campground_land_use_subtype_is_a_spot(projector):
    lu = _lu([("lu_cg", "Pine Ridge Campground", "campground", "campground", INNER)])
    cands = _cands(NO_PLACES, lu, projector)
    assert list(cands) == ["lu_cg"] and cands["lu_cg"].category == "campground"


# --- residual I2: hit ranking and dropped places ---------------------------------

COMPLEX = (-84.2000, 41.9100, -84.1920, 41.9175)    # ~0.55 km2
STATE_AREA = (-84.1915, 41.8700, -84.0900, 41.9555)  # ~80 km2, ~40 m east of COMPLEX


def test_place_inside_small_park_does_not_claim_huge_adjacent_park(projector):
    lu = _lu([("lu_complex", "Memorial Park Complex", "park", "park", COMPLEX),
              ("lu_state", "Hudson State Recreation Area", "protected", "nature_reserve", STATE_AREA)])
    places = _places([("pl_mem", "Memorial Park", "park", 0.95, -84.1925, 41.914),
                      ("pl_state", "Hudson State Recreation Area", "state_park", 0.9, -84.15, 41.91)])
    cands = _cands(places, lu, projector)
    assert sorted(cands) == ["pl_mem", "pl_state"]
    assert cands["pl_mem"].name == "Memorial Park" and cands["pl_mem"].area.area < 1_000_000
    assert cands["pl_state"].name == "Hudson State Recreation Area" and cands["pl_state"].area.area > 50_000_000
    assert not [c for c in cands.values() if c.name == "Memorial Park" and c.area.area > 1_000_000]


def test_place_just_outside_only_nearby_polygon_still_claims_it(projector):
    lu = _lu([("lu_e", "Edge Park", "park", "park", OUTER)])
    cands = _cands(_places([("pl_o", "Other Name", "park", 0.9, -84.2594, 41.915)]), lu, projector)  # ~50 m out
    assert list(cands) == ["pl_o"] and cands["pl_o"].source == "place+polygon"


def test_nearest_non_containing_polygon_wins_within_tolerance(projector):
    # Point at -84.2605: lu_near edge ~ 40 m east, lu_far (much larger) edge ~ 90 m east.
    lu = _lu([("lu_far", "Far Park", "park", "park", (-84.2594, 41.90, -84.15, 41.93)),
              ("lu_near", "Near Park", "park", "park", (-84.2600, 41.90, -84.25, 41.91))])
    cands = _cands(_places([("pl_x", "Zed", "park", 0.9, -84.2605, 41.905)]), lu, projector)
    assert sorted(cands) == ["lu_far", "pl_x"] and cands["pl_x"].area.area < 10_000_000


def test_equal_area_containing_polygons_choose_lowest_id(projector):
    rows = [("lu_b", "Beta", "park", "park", OUTER), ("lu_a", "Alpha", "park", "park", OUTER)]
    places = _places([("pl_o", "Other", "park", 0.9, -84.28, 41.915)])
    for order in (rows, rows[::-1]):
        assert sorted(_cands(places, _lu(order), projector)) == ["lu_b", "pl_o"]


def test_different_named_place_on_claimed_polygon_becomes_own_spot(projector):
    lu = _lu([("lu_big", "Big Park", "park", "park", OUTER)])
    places = _places([("pl_1", "Big Park", "park", 0.95, -84.28, 41.915),
                      ("pl_2", "Hilltop Lookout", "park", 0.90, -84.27, 41.92)])
    cands = _cands(places, lu, projector)
    assert sorted(cands) == ["pl_1", "pl_2"]
    assert cands["pl_1"].source == "place+polygon" and cands["pl_2"].source == "place"


def test_same_named_place_on_claimed_polygon_is_dropped(projector):
    lu = _lu([("lu_big", "Big Park", "park", "park", OUTER)])
    places = _places([("pl_1", "Big Park", "park", 0.95, -84.28, 41.915),
                      ("pl_2", "BIG PARK", "park", 0.90, -84.27, 41.92)])
    assert list(_cands(places, lu, projector)) == ["pl_1"]

import numpy as np
import pytest
import shapely

from darksky_pipeline import config
from darksky_pipeline.roads import (RoadNetwork, build_road_network, find_viewing_point, is_paved,
                                    is_private, parking_points, sample_points)


@pytest.mark.parametrize("value,expected", [
    (None, False),
    ([], False),
    ([{"access_type": "denied"}], True),
    ([{"access_type": "denied", "when": {"mode": ["hgv"]}}], False),
    ([{"access_type": "allowed"}], False),
    (np.array([{"access_type": "denied", "when": None}], dtype=object), True),
])
def test_is_private(value, expected):
    assert is_private(value) is expected


@pytest.mark.parametrize("cls,surface,expected", [
    ("tertiary", [{"value": "paved"}], True),
    ("tertiary", None, True),
    ("tertiary", [{"value": "unpaved"}], False),
    ("track", [{"value": "paved"}], False),
])
def test_is_paved(cls, surface, expected):
    assert is_paved(cls, surface) is expected


def test_network_excludes_private_and_non_drivable(road_network):
    assert sorted(road_network.classes) == sorted(["tertiary", "residential", "track", "motorway"])
    assert len(road_network.highway_geoms) == 1


def test_hudson_viewing_point_near_park_center(candidates, road_network, darkness_grid, projector, overture_frames):
    vp = find_viewing_point(candidates["pl_hudson"].area, road_network, darkness_grid, projector,
                            parking_points(overture_frames["places"], projector))
    assert vp is not None
    assert abs(vp.lon + 84.25) < 0.002 and abs(vp.lat - 41.83) < 0.001
    assert vp.road_class == "tertiary" and vp.paved is True
    assert vp.sqm > 21.0


def test_camp_viewing_point_is_unpaved_track(candidates, road_network, darkness_grid, projector):
    vp = find_viewing_point(candidates["pl_camp"].area, road_network, darkness_grid, projector, np.empty((0, 2)))
    assert vp is not None and vp.road_class == "track" and vp.paved is False


def test_no_viewing_point_without_drivable_road(candidates, road_network, darkness_grid, projector):
    # Hidden Woods only has a private service road and a footway.
    assert find_viewing_point(candidates["lu_woods"].area, road_network, darkness_grid, projector,
                              np.empty((0, 2))) is None


def test_parking_points_selects_parking_places(overture_frames, projector):
    pts = parking_points(overture_frames["places"], projector)
    assert pts.shape == (1, 2)


def test_sample_points_are_capped():
    line = shapely.LineString([(0, 500), (300_000, 500)])
    net = RoadNetwork(geoms=np.array([line], dtype=object), classes=np.array(["primary"], dtype=object),
                      paved=np.array([True]), tree=shapely.STRtree([line]),
                      highway_geoms=np.array([], dtype=object), highway_tree=None)
    xy, road_idx = sample_points(shapely.box(0, 0, 300_000, 1_000), net, np.empty((0, 2)))
    assert len(xy) == config.MAX_VIEWING_CANDIDATES == len(road_idx)


def test_empty_network_returns_none(candidates, darkness_grid, projector):
    net = RoadNetwork(geoms=np.array([], dtype=object), classes=np.array([], dtype=object),
                      paved=np.array([], dtype=bool), tree=None,
                      highway_geoms=np.array([], dtype=object), highway_tree=None)
    assert find_viewing_point(candidates["pl_hudson"].area, net, darkness_grid, projector, np.empty((0, 2))) is None

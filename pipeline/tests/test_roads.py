import numpy as np
import pandas as pd
import pytest
import shapely

from darksky_pipeline import config
from darksky_pipeline.darkness import DarknessGrid
from overture_fixture import REGION_BBOX, TEST_EPSG
from darksky_pipeline.roads import (RoadNetwork, build_road_network, find_viewing_point, is_paved,
                                    is_private, parking_points, sample_points, find_entry)


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
    assert vp.radiance == pytest.approx(0.2, rel=0.05)  # I7
    assert vp.parking is True  # M6: Hudson Lot lies inside the park's access zone


def test_viewing_point_from_parking_sets_parking(projector, darkness_grid):
    net = build_road_network(_segments([("tertiary", "LINESTRING(-84.335 41.908, -84.305 41.908)")]), projector)
    area = _box_xy(projector, -84.33, 41.89, -84.31, 41.91)
    lot = np.array([projector.to_xy(-84.32, 41.90)])  # the park centre: wins the darkness tie
    vp = find_viewing_point(area, net, darkness_grid, projector, lot)
    assert vp.parking is True and abs(vp.lat - 41.90) < 1e-6
    far_lot = np.array([projector.to_xy(-84.20, 41.80)])
    assert find_viewing_point(area, net, darkness_grid, projector, far_lot).parking is False


def test_camp_viewing_point_is_unpaved_track(candidates, road_network, darkness_grid, projector):
    vp = find_viewing_point(candidates["pl_camp"].area, road_network, darkness_grid, projector, np.empty((0, 2)))
    assert vp is not None and vp.road_class == "track" and vp.paved is False
    assert vp.parking is False


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


def _segments(rows):
    """rows: (class, wkt in lon/lat)."""
    return pd.DataFrame([{"id": f"s{i}", "subtype": "road", "class": c, "road_surface": None,
                          "access_restrictions": None, "wkb": shapely.to_wkb(shapely.from_wkt(w))}
                         for i, (c, w) in enumerate(rows)])


def _box_xy(projector, w, s, e, n):
    return projector.geoms_to_xy(np.array([shapely.box(w, s, e, n)], dtype=object))[0]


def test_motorway_through_park_is_not_a_viewing_point(projector, darkness_grid):
    # C1: a motorway crosses the park centre; a tertiary road runs along the park's north side.
    net = build_road_network(_segments([
        ("motorway", "LINESTRING(-84.32 41.85, -84.32 41.95)"),
        ("tertiary", "LINESTRING(-84.335 41.908, -84.305 41.908)"),
    ]), projector)
    assert len(net.highway_geoms) == 1  # still used for glare
    area = _box_xy(projector, -84.33, 41.89, -84.31, 41.91)
    vp = find_viewing_point(area, net, darkness_grid, projector, np.empty((0, 2)))
    assert vp is not None and vp.road_class == "tertiary"
    assert abs(vp.lat - 41.908) < 0.0005


def test_only_motorway_means_no_viewing_point(projector, darkness_grid):
    net = build_road_network(_segments([("trunk", "LINESTRING(-84.32 41.85, -84.32 41.95)")]), projector)
    area = _box_xy(projector, -84.33, 41.89, -84.31, 41.91)
    assert find_viewing_point(area, net, darkness_grid, projector, np.empty((0, 2))) is None


def test_viewing_point_is_clipped_to_region(projector):
    # I3: park straddles the region's east edge (-84.00); the sky gets darker eastward.
    w, s, e, n = projector.bbox_xy((-84.5, 41.7, -83.7, 42.1))
    res = 500.0
    cols, rows = int((e - w) // res) + 1, int((n - s) // res) + 1
    sqm = np.tile(18.0 + 0.05 * np.arange(cols, dtype=np.float32), (rows, 1))
    grid = DarknessGrid(sqm=sqm, x0=w, y0=n, res=res, epsg=TEST_EPSG)
    net = build_road_network(_segments([("tertiary", "LINESTRING(-84.02 41.90, -83.90 41.90)")]), projector)
    area = _box_xy(projector, -84.02, 41.88, -83.90, 41.92)
    unclipped = find_viewing_point(area, net, grid, projector, np.empty((0, 2)))
    assert unclipped.lon > REGION_BBOX[2]  # sanity: without the region the point is outside
    region = projector.region_xy(REGION_BBOX)
    vp = find_viewing_point(area, net, grid, projector, np.empty((0, 2)), region=region)
    assert vp is not None
    assert REGION_BBOX[0] <= vp.lon <= REGION_BBOX[2] and REGION_BBOX[1] <= vp.lat <= REGION_BBOX[3]


def test_parking_points_survive_cap_thinning():
    # M1: thinning applies to road samples only.
    line = shapely.LineString([(0, 500), (300_000, 500)])
    net = RoadNetwork(geoms=np.array([line], dtype=object), classes=np.array(["primary"], dtype=object),
                      paved=np.array([True]), tree=shapely.STRtree([line]),
                      highway_geoms=np.array([], dtype=object), highway_tree=None)
    parking = np.array([[100_033.0, 520.0], [150_017.0, 480.0], [200_011.0, 510.0]])
    xy, road_idx = sample_points(shapely.box(0, 0, 300_000, 1_000), net, parking)
    assert len(xy) <= config.MAX_VIEWING_CANDIDATES and len(xy) == len(road_idx)
    for p in parking:
        assert np.any(np.all(np.isclose(xy, p), axis=1)), p


def test_samples_lie_on_their_roads(road_network, candidates):
    area = candidates["pl_hudson"].area
    xy, road_idx = sample_points(area, road_network, np.empty((0, 2)))
    assert len(xy) > 0
    d = shapely.distance(road_network.geoms[road_idx], shapely.points(xy))
    assert np.all(d < 1e-6)
    assert np.all(shapely.dwithin(area, shapely.points(xy), config.ACCESS_SEARCH_M + 1e-6))


def _lonlat_of(projector, pt_xy):
    return projector.to_lonlat(pt_xy[0], pt_xy[1])


def _xy(projector, lon, lat):
    x, y = projector.to_xy(np.array([lon]), np.array([lat]))
    return float(x[0]), float(y[0])


def test_entry_prefers_parking(projector):
    net = build_road_network(_segments([("primary", "LINESTRING(-84.335 41.908, -84.305 41.908)")]), projector)
    area = _box_xy(projector, -84.33, 41.89, -84.31, 41.91)
    px, py = projector.to_xy(np.array([-84.32]), np.array([41.9115]))
    parking = np.column_stack([px, py])
    lon, lat = find_entry(area, net, parking, projector, _xy(projector, -84.32, 41.905))
    assert abs(lon + 84.32) < 1e-5 and abs(lat - 41.9115) < 1e-5


def test_entry_parking_nearest_to_viewing_point(projector):
    # three lots inside the area; the viewing point sits near the east one
    net = build_road_network(_segments([("primary", "LINESTRING(-84.335 41.908, -84.305 41.908)")]), projector)
    area = _box_xy(projector, -84.33, 41.89, -84.31, 41.91)
    px, py = projector.to_xy(np.array([-84.328, -84.32, -84.312]), np.array([41.9115, 41.9, 41.905]))
    parking = np.column_stack([px, py])
    lon, lat = find_entry(area, net, parking, projector, _xy(projector, -84.3125, 41.906))
    assert abs(lon + 84.312) < 1e-5 and abs(lat - 41.905) < 1e-5


def test_entry_parking_far_from_viewing_point_falls_to_road(projector):
    # the only lot is ~2.2 km from the viewing point (> ENTRY_PARKING_MAX_KM) -> nearest road point instead
    net = build_road_network(_segments([("residential", "LINESTRING(-84.335 41.8885, -84.305 41.8885)")]), projector)
    area = _box_xy(projector, -84.33, 41.89, -84.31, 41.91)
    px, py = projector.to_xy(np.array([-84.32]), np.array([41.9105]))
    parking = np.column_stack([px, py])
    lon, lat = find_entry(area, net, parking, projector, _xy(projector, -84.32, 41.891))
    assert abs(lat - 41.8885) < 1e-4
    assert abs(lon + 84.32) < 1e-3


def test_entry_near_road_beats_far_side_primary(projector):
    # primary along the far (south) side; residential next to the viewing point on the north side
    net = build_road_network(_segments([
        ("primary", "LINESTRING(-84.335 41.8885, -84.305 41.8885)"),
        ("residential", "LINESTRING(-84.335 41.9105, -84.305 41.9105)"),
        ("service", "LINESTRING(-84.335 41.9085, -84.305 41.9085)"),
    ]), projector)
    area = _box_xy(projector, -84.33, 41.89, -84.31, 41.91)
    lon, lat = find_entry(area, net, np.empty((0, 2)), projector, _xy(projector, -84.32, 41.908))
    assert abs(lat - 41.9105) < 1e-4
    assert abs(lon + 84.32) < 1e-3


def test_entry_ignores_road_of_distant_area_part(projector):
    # multi-part area: the viewing point is in the west part; the only road serves the east part (~8 km away)
    west = _box_xy(projector, -84.33, 41.89, -84.32, 41.90)
    east = _box_xy(projector, -84.23, 41.89, -84.22, 41.90)
    area = shapely.MultiPolygon([west, east])
    net = build_road_network(_segments([("primary", "LINESTRING(-84.235 41.9015, -84.215 41.9015)")]), projector)
    assert find_entry(area, net, np.empty((0, 2)), projector, _xy(projector, -84.325, 41.895)) is None


def test_entry_none_when_only_tracks(projector):
    net = build_road_network(_segments([
        ("track", "LINESTRING(-84.335 41.905, -84.305 41.905)"),
        ("service", "LINESTRING(-84.335 41.906, -84.305 41.906)"),
        ("motorway", "LINESTRING(-84.335 41.907, -84.305 41.907)"),
    ]), projector)
    area = _box_xy(projector, -84.33, 41.89, -84.31, 41.91)
    assert find_entry(area, net, np.empty((0, 2)), projector, _xy(projector, -84.32, 41.905)) is None

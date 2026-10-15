import numpy as np
import shapely

from darksky_pipeline.geo import Projector


def test_round_trip_detroit():
    p = Projector(32617)
    x, y = p.to_xy(-83.0458, 42.3314)
    lon, lat = p.to_lonlat(x, y)
    assert abs(lon + 83.0458) < 1e-7 and abs(lat - 42.3314) < 1e-7


def test_distances_are_metres():
    p = Projector(32617)
    x1, y1 = p.to_xy(-83.0, 42.0)
    x2, y2 = p.to_xy(-83.0, 42.01)
    assert abs(np.hypot(x2 - x1, y2 - y1) - 1111) < 5


def test_geoms_to_xy_projects_arrays():
    p = Projector(32617)
    geoms = np.array([shapely.Point(-83.0, 42.0), shapely.LineString([(-83.0, 42.0), (-83.0, 42.01)])], dtype=object)
    out = p.geoms_to_xy(geoms)
    assert abs(out[1].length - 1111) < 5
    assert abs(out[0].x - p.to_xy(-83.0, 42.0)[0]) < 1e-6


def test_bbox_xy_contains_all_corners_and_round_trips():
    p = Projector(32617)
    bbox = (-84.6, 41.65, -82.4, 44.1)
    minx, miny, maxx, maxy = p.bbox_xy(bbox)
    for lon in (bbox[0], bbox[2]):
        for lat in (bbox[1], bbox[3]):
            x, y = p.to_xy(lon, lat)
            assert minx <= x <= maxx and miny <= y <= maxy
    w, s, e, n = p.bbox_lonlat((minx, miny, maxx, maxy))
    assert w <= bbox[0] and s <= bbox[1] and e >= bbox[2] and n >= bbox[3]


def test_region_xy_is_projected_bbox_polygon():
    p = Projector(32617)
    bbox = (-84.40, 41.75, -84.00, 42.05)
    region = p.region_xy(bbox)
    assert region.geom_type == "Polygon" and region.is_valid
    inside = shapely.Point(*p.to_xy(-84.2, 41.9))
    assert region.contains(inside)
    for lon, lat in [(-83.999, 41.9), (-84.401, 41.9), (-84.2, 42.051), (-84.2, 41.749)]:
        assert not region.contains(shapely.Point(*p.to_xy(lon, lat))), (lon, lat)
    # corners just inside the lon/lat box are still inside the projected region
    for lon, lat in [(-84.3999, 41.7501), (-84.0001, 42.0499)]:
        assert region.contains(shapely.Point(*p.to_xy(lon, lat))), (lon, lat)

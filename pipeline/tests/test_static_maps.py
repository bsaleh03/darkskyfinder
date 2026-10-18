import json
import math

import numpy as np
import pandas as pd
import pytest
import rasterio
import shapely

from darksky_pipeline import config
from darksky_pipeline.config import Metro
from overture_fixture import CITY, REGION_BBOX, TEST_EPSG

MI = (-86.9, 41.65, -82.4, 45.9)


def _merc_aspect(bbox):
    w, s, e, n = bbox
    y = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))  # noqa: E731
    return (y(n) - y(s)) / math.radians(e - w)


def test_image_size_respects_pixel_cap_and_mercator_aspect():
    from darksky_pipeline.static_maps import image_size
    w, h = image_size(MI)
    assert w * h <= 16_000_000
    assert w * h >= 15_000_000
    assert w % 4 == 0
    assert abs((h / w) / _merc_aspect(MI) - 1) < 0.005


def test_glow_rgba_shape_and_ramps(darkness_grid):
    from darksky_pipeline.static_maps import glow_rgba
    from darksky_pipeline.tiles import RED_STOPS
    rgba = glow_rgba(darkness_grid, REGION_BBOX, 64, 48)
    assert rgba.shape == (48, 64, 4) and rgba.dtype == np.uint8
    # The fixture city sits near the north-east corner of the region.
    w, s, e, n = REGION_BBOX
    col = int((CITY[0] - w) / (e - w) * 64)
    assert rgba[:12, max(col - 6, 0):col + 6, 3].max() > 0
    red = glow_rgba(darkness_grid, REGION_BBOX, 64, 48, RED_STOPS).astype(int)
    visible = red[..., 3] > 0
    assert visible.any()
    r, g, b = red[..., 0][visible], red[..., 1][visible], red[..., 2][visible]
    assert (g <= r / 2).all() and (b <= r / 2).all()


def test_labels_query_and_json():
    from darksky_pipeline.static_maps import labels_json, labels_query
    q = labels_query("2026-09-23.1", MI)
    assert "/2026-09-23.1/" in q and "type=division/" in q and "subtype = 'locality'" in q
    for v in MI:
        assert str(v) in q
    df = pd.DataFrame({
        "name": ["Smallville", "Big City", None, "Mid Town", "Big City", "Tie A", "Tie B"],
        "lon": [-84.0, -83.0, -83.5, -84.5, -83.0, -85.0, -85.5],
        "lat": [42.0, 42.3, 42.1, 43.0, 42.3, 44.0, 44.5],
        "population": [500, 700_000, 9_000, 40_000, 700_000, None, None],
        "prominence": [20, 80, 50, None, 80, 10, 30],
    })
    out = labels_json(df)
    assert [x["name"] for x in out] == ["Big City", "Mid Town", "Smallville", "Tie B", "Tie A"]
    assert [x["rank"] for x in out] == [1, 2, 3, 4, 5]
    assert out[0] == {"name": "Big City", "lon": -83.0, "lat": 42.3, "rank": 1}
    assert [x["name"] for x in labels_json(df, limit=2)] == ["Big City", "Mid Town"]


# --- borders (moved from the dropped US-wide map) ---------------------------------

def test_border_queries_filter_land_and_bbox():
    from darksky_pipeline.static_maps import border_area_query, border_line_query
    lines, areas = border_line_query("2026-09-23.1", MI), border_area_query("2026-09-23.1", MI)
    assert "type=division_boundary" in lines and "type=division_area" in areas
    for q in (lines, areas):
        assert "/2026-09-23.1/" in q and "class = 'land'" in q
        assert "bbox.xmax >= -86.9" in q and "bbox.xmin <= -82.4" in q
        assert "bbox.ymax >= 41.65" in q and "bbox.ymin <= 45.9" in q
    assert "subtype = 'region'" in areas and "country IN ('CA', 'MX', 'US')" in areas


def test_country_border_lines_not_filtered_by_country():
    from darksky_pipeline.static_maps import border_line_query
    # Country-to-country borders carry no `country` value in Overture, so they must not be filtered by it.
    assert ("(subtype = 'country' OR (subtype = 'region' AND country IN ('CA', 'MX', 'US')))"
            in border_line_query("2026-09-23.1", MI))


def _lake_case():
    # Two land squares with a 1-degree-wide lake between them; one border crosses all three.
    areas = pd.DataFrame({"wkb": [shapely.to_wkb(shapely.box(0, 0, 1, 1)), shapely.to_wkb(shapely.box(2, 0, 3, 1))]})
    lines = pd.DataFrame({"subtype": ["country", "region"],
                          "wkb": [shapely.to_wkb(shapely.LineString([(0.5, 0.5), (2.5, 0.5)])),
                                  shapely.to_wkb(shapely.LineString([(1.4, 5), (1.6, 6)]))]})  # all water
    return lines, areas


def _by_kind(fc):
    return {(f["properties"]["subtype"], f["properties"]["water"]): shapely.geometry.shape(f["geometry"])
            for f in fc["features"]}


def test_land_borders_geojson_keeps_water_stretches_for_countries_only():
    from darksky_pipeline.static_maps import land_borders_geojson
    lines, areas = _lake_case()
    by = _by_kind(land_borders_geojson(lines, areas, bbox=(-10, -10, 10, 10), slack_deg=0.01, simplify_deg=0.0))
    # Country borders keep their water stretch as a separate (dashed) feature; state lines in water are dropped.
    assert set(by) == {("country", False), ("country", True)}
    assert abs(by[("country", False)].length - (0.51 + 0.51)) < 1e-6
    assert abs(by[("country", True)].length - (2.0 - 1.02)) < 1e-6


def test_land_borders_geojson_clips_to_bbox():
    from darksky_pipeline.static_maps import land_borders_geojson
    lines, areas = _lake_case()
    by = _by_kind(land_borders_geojson(lines, areas, bbox=(0.0, 0.0, 0.8, 1.0), slack_deg=0.01, simplify_deg=0.0))
    assert set(by) == {("country", False)}
    assert abs(by[("country", False)].length - 0.3) < 1e-6


def test_land_borders_geojson_cuts_lakes_inside_division_areas():
    # Overture's 'land' region areas include their share of the Great Lakes, so water polygons are cut out too.
    from darksky_pipeline.static_maps import border_water_query, land_borders_geojson
    lines, _ = _lake_case()
    areas = pd.DataFrame({"wkb": [shapely.to_wkb(shapely.box(0, 0, 3, 1))]})  # the area spans the lake
    water = pd.DataFrame({"wkb": [shapely.to_wkb(shapely.box(1, -1, 2, 2)),  # the lake
                                  shapely.to_wkb(shapely.box(0.6, 0.499, 0.601, 0.501))]})  # a pond (~0.02 km2): ignored
    by = _by_kind(land_borders_geojson(lines, areas, bbox=(-10, -10, 10, 10), water=water, slack_deg=0.0,
                                       simplify_deg=0.0))
    assert set(by) == {("country", False), ("country", True)}
    assert abs(by[("country", False)].length - 1.0) < 1e-6
    assert abs(by[("country", True)].length - 1.0) < 1e-6
    q = border_water_query("2026-09-23.1", MI)
    assert "theme=base/type=water/" in q and "bbox.xmin <= -82.4" in q and "ST_Intersects(geometry" in q


def test_land_borders_geojson_keeps_only_line_parts():
    # A line that just touches the land at a point intersects to a GeometryCollection(Point, LineString).
    from darksky_pipeline.static_maps import land_borders_geojson
    areas = pd.DataFrame({"wkb": [shapely.to_wkb(shapely.box(0, 0, 1, 1))]})
    lines = pd.DataFrame({"subtype": ["region"], "wkb": [shapely.to_wkb(shapely.MultiLineString(
        [[(0.2, 0.5), (0.8, 0.5)], [(1, 1), (2, 1.5)]]))]})
    fc = land_borders_geojson(lines, areas, bbox=(-10, -10, 10, 10), slack_deg=0.0, simplify_deg=0.0)
    assert [f["geometry"]["type"] for f in fc["features"]] == ["LineString"]
    assert abs(shapely.geometry.shape(fc["features"][0]["geometry"]).length - 0.6) < 1e-6


def test_land_borders_geojson_keeps_narrow_rivers_as_water():
    # The land slack must not erase a river (here ~1 km wide) where the border runs down the water.
    from darksky_pipeline.static_maps import land_borders_geojson
    areas = pd.DataFrame({"wkb": [shapely.to_wkb(shapely.box(0, 0, 3, 1))]})
    water = pd.DataFrame({"wkb": [shapely.to_wkb(shapely.box(1.5, -1, 1.51, 2))]})  # ~1 km wide, ~370 km2
    lines = pd.DataFrame({"subtype": ["country"], "wkb": [shapely.to_wkb(shapely.LineString([(0.5, 0.5), (2.5, 0.5)]))]})
    by = _by_kind(land_borders_geojson(lines, areas, bbox=(-10, -10, 10, 10), water=water, slack_deg=0.003,
                                       simplify_deg=0.0))
    assert abs(by[("country", True)].length - 0.01) < 1e-6


def test_build_static_map_inputs_writes_all_outputs(viirs_path, tmp_path, monkeypatch):
    from darksky_pipeline import static_maps
    monkeypatch.setitem(config.METROS, "test", Metro("test", "Test", REGION_BBOX, TEST_EPSG, CITY, "Testville"))
    calls = []
    monkeypatch.setattr(static_maps, "write_labels", lambda release, bbox, out: calls.append(("labels", bbox)))
    monkeypatch.setattr(static_maps, "write_land_borders", lambda release, bbox, out: calls.append(("borders", bbox)))
    out = static_maps.build_static_map_inputs("test", viirs_path, "2026-09-23.1", tmp_path / "maps",
                                              max_pixels=40_000)
    assert out == tmp_path / "maps" / "test"
    assert sorted(calls) == [("borders", REGION_BBOX), ("labels", REGION_BBOX)]
    extent = json.loads((out / "extent.json").read_text(encoding="utf-8"))
    assert extent["bounds"] == list(REGION_BBOX)
    assert extent["width"] * extent["height"] <= 40_000 and extent["width"] % 4 == 0
    for name in ("glow.png", "glow_red.png"):
        with rasterio.open(out / name) as src:
            assert (src.width, src.height) == (extent["width"], extent["height"])
            assert src.count == 4 and src.dtypes[0] == "uint8"
            assert src.read(4).max() > 0
    assert not list(out.glob("*.aux.xml"))


@pytest.mark.parametrize("key", ["se_mi", "bay_area"])
def test_cli_parses(key, monkeypatch):
    from darksky_pipeline import static_maps
    seen = []
    monkeypatch.setattr(static_maps, "build_static_map_inputs", lambda *a, **k: seen.append(a) or a[3] / a[0])
    static_maps.main(["--metro", key, "--viirs", "v.tif", "--tiles-release", "2026-09-23.1", "--out", "out/maps"])
    assert seen[0][0] == key and seen[0][2] == "2026-09-23.1"

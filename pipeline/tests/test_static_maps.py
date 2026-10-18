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



def test_glow_res_and_levels_config():
    assert config.STATIC_MAP_GLOW_RES_M == 200
    assert config.STATIC_MAP_LEVELS == (0, 1)


@pytest.mark.parametrize("level", [0, 1])
def test_tile_bounds_cut_the_extent_into_exact_mercator_fractions(level):
    from darksky_pipeline.static_maps import mercator_bounds, tile_bounds
    x0, y0, x1, y1 = mercator_bounds(MI)
    n = 2 ** level
    for c in range(n):
        for r in range(n):
            tx0, ty0, tx1, ty1 = tile_bounds(MI, level, c, r)
            assert tx0 == pytest.approx(x0 + (x1 - x0) * c / n, abs=1e-6)
            assert tx1 == pytest.approx(x0 + (x1 - x0) * (c + 1) / n, abs=1e-6)
            assert ty1 == pytest.approx(y1 - (y1 - y0) * r / n, abs=1e-6)  # row 0 is the north edge
            assert ty0 == pytest.approx(y1 - (y1 - y0) * (r + 1) / n, abs=1e-6)
            if c + 1 < n:
                assert tile_bounds(MI, level, c + 1, r)[0] == tx1  # neighbours share edges exactly
            if r + 1 < n:
                assert tile_bounds(MI, level, c, r + 1)[3] == ty0


def _step_edges(alpha: np.ndarray) -> int:
    """Adjacent-pixel jumps of >= 3 alpha levels that are >= 3x both neighbouring jumps (pixel-block edges)."""
    a = alpha.astype(float)
    count = 0
    for d in (np.abs(np.diff(a, axis=1)), np.abs(np.diff(a, axis=0)).T):
        inner, nb = d[:, 1:-1], np.maximum(d[:, :-2], d[:, 2:])
        count += int(((inner >= 3 * np.maximum(nb, 1)) & (inner >= 3)).sum())
    return count


@pytest.fixture(scope="module")
def fine_grid(viirs_path):
    from darksky_pipeline.darkness import build_darkness_grid
    from rasterio.warp import Resampling
    return build_darkness_grid(viirs_path, REGION_BBOX, TEST_EPSG, res_m=config.STATIC_MAP_GLOW_RES_M,
                               resampling=Resampling.cubic)


def test_glow_tile_rgba_is_level0_size_and_smooth_at_level1(fine_grid):
    from darksky_pipeline.static_maps import glow_tile_rgba, image_size
    from darksky_pipeline.tiles import RED_STOPS
    w0, h0 = image_size(REGION_BBOX, 40_000)
    # The fixture city sits in the north-east quarter: level-1 tile (1, 0).
    for level, col, row in ((0, 0, 0), (1, 1, 0), (1, 0, 1)):
        rgba = glow_tile_rgba(fine_grid, REGION_BBOX, level, col, row, w0, h0)
        assert rgba.shape == (h0, w0, 4) and rgba.dtype == np.uint8
        red = glow_tile_rgba(fine_grid, REGION_BBOX, level, col, row, w0, h0, RED_STOPS).astype(int)
        visible = red[..., 3] > 0
        r, g, b = red[..., 0][visible], red[..., 1][visible], red[..., 2][visible]
        assert (g <= r / 2).all() and (b <= r / 2).all()
    city = glow_tile_rgba(fine_grid, REGION_BBOX, 1, 1, 0, w0, h0)
    alpha = city[..., 3]
    assert alpha.max() > 100 and (alpha == 0).mean() < 0.9  # the city glow is in this tile
    assert _step_edges(alpha) == 0
    assert np.abs(np.diff(alpha.astype(int), axis=1)).max() <= 24
    assert np.abs(np.diff(alpha.astype(int), axis=0)).max() <= 24


def test_step_edge_check_catches_pixel_blocks(fine_grid):
    """The smoothness check itself: a nearest-neighbour (blocky) warp of the same grid fails it."""
    from rasterio.crs import CRS
    from rasterio.transform import from_bounds, from_origin
    from rasterio.warp import Resampling, reproject
    from darksky_pipeline.static_maps import image_size, tile_bounds
    from darksky_pipeline.tiles import sqm_to_rgba
    w0, h0 = image_size(REGION_BBOX, 40_000)
    sqm = np.full((h0, w0), np.nan, dtype=np.float32)
    reproject(source=fine_grid.sqm.astype(np.float32), destination=sqm,
              src_transform=from_origin(fine_grid.x0, fine_grid.y0, fine_grid.res, fine_grid.res),
              src_crs=CRS.from_epsg(fine_grid.epsg), src_nodata=np.nan,
              dst_transform=from_bounds(*tile_bounds(REGION_BBOX, 1, 1, 0), w0, h0), dst_crs=CRS.from_epsg(3857),
              dst_nodata=np.nan, resampling=Resampling.nearest)
    assert _step_edges(sqm_to_rgba(sqm)[..., 3]) > 100

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
    assert extent["levels"] == [0, 1]
    glow = out / "glow"
    names = ["L0.png", "L0_red.png"] + [f"L1_{c}_{r}{red}.png" for c in (0, 1) for r in (0, 1) for red in ("", "_red")]
    assert sorted(p.name for p in glow.iterdir()) == sorted(names)
    # The render step reads glow/ only; no legacy level-0 copies next to it.
    assert not (out / "glow.png").exists() and not (out / "glow_red.png").exists()
    for name in names:
        with rasterio.open(glow / name) as src:
            assert (src.width, src.height) == (extent["width"], extent["height"])
            assert src.count == 4 and src.dtypes[0] == "uint8"
            rgba = np.moveaxis(src.read(), 0, -1).astype(int)
        visible = rgba[..., 3] > 0
        if name.endswith("_red.png"):
            r, g, b = rgba[..., 0][visible], rgba[..., 1][visible], rgba[..., 2][visible]
            assert (g <= r / 2).all() and (b <= r / 2).all()
    with rasterio.open(glow / "L1_1_0.png") as src:  # the city's quarter
        assert src.read(4).max() > 0
    assert not list(out.glob("*.aux.xml"))


@pytest.mark.parametrize("key", ["se_mi", "bay_area"])
def test_cli_parses(key, monkeypatch):
    from darksky_pipeline import static_maps
    seen = []
    monkeypatch.setattr(static_maps, "build_static_map_inputs", lambda *a, **k: seen.append(a) or a[3] / a[0])
    static_maps.main(["--metro", key, "--viirs", "v.tif", "--tiles-release", "2026-09-23.1", "--out", "out/maps"])
    assert seen[0][0] == key and seen[0][2] == "2026-09-23.1"


def test_land_borders_geojson_skips_point_only_touches():
    # A line that touches the land only at a corner intersects to a Point: no feature, no error.
    from darksky_pipeline.static_maps import land_borders_geojson
    areas = pd.DataFrame({"wkb": [shapely.to_wkb(shapely.box(0, 0, 1, 1))]})
    lines = pd.DataFrame({"subtype": ["region"], "wkb": [shapely.to_wkb(shapely.LineString([(1, 1), (2, 1.5)]))]})
    fc = land_borders_geojson(lines, areas, bbox=(-10, -10, 10, 10), slack_deg=0.0, simplify_deg=0.0)
    assert fc["features"] == []


def test_labels_json_strips_township_suffixes_and_drops_nearby_duplicates():
    from darksky_pipeline.static_maps import labels_json
    df = pd.DataFrame({
        "name": ["Canton", "Canton Charter", "Shelby Charter", "Redford Township", "Redford", "Milford Twp",
                 "Milford", "Lyon Charter", "Lyon Charter"],
        # Canton Charter is ~2 km from Canton; Redford Township ~3 km from Redford; Milford Twp ~30 km from Milford.
        "lon": [-83.48, -83.50, -82.95, -83.30, -83.29, -83.60, -83.60, -83.65, -83.65],
        "lat": [42.31, 42.30, 42.67, 42.40, 42.38, 42.30, 42.59, 42.47, 42.47],
        "population": [90_000, 98_000, 80_000, 48_000, None, 10_000, 6_000, 20_000, 20_000],
        "prominence": [50, 50, 40, 30, 30, 10, 10, 10, 10],
    })
    out = labels_json(df)
    names = [x["name"] for x in out]
    # Suffixes are stripped for display; the higher-ranked of two same-named places within 5 km is kept.
    assert names == ["Canton", "Shelby", "Redford", "Lyon", "Milford", "Milford"]
    assert out[0]["lon"] == -83.50  # the Charter township outranked the town, so its position stays
    assert out[2] == {"name": "Redford", "lon": -83.30, "lat": 42.40, "rank": 3}
    assert [x["rank"] for x in out] == [1, 2, 3, 4, 5, 6]
    assert not any(n.endswith((" Charter", " Township", " Twp")) for n in names)

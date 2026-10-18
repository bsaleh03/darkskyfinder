import rasterio

from darksky_pipeline import config
from darksky_pipeline.us_glow import build_us_glow
from viirs_fixture import write_viirs_fixture


def test_us_glow_config():
    w, s, e, n = config.US_GLOW_BBOX
    assert w <= -124.8 and e >= -66.9 and s <= 24.5 and n >= 49.4  # covers the lower 48
    assert config.US_GLOW_EPSG == 5070  # CONUS Albers equal-area
    assert config.US_GLOW_ZOOMS == (3, 9)


def test_build_us_glow_writes_tif_and_tiles(tmp_path, monkeypatch):
    viirs = write_viirs_fixture(tmp_path / "viirs.tif")
    ran = []
    monkeypatch.setattr("darksky_pipeline.us_glow.run_commands", lambda cmds: ran.extend(cmds))
    # A small box inside the fixture keeps the test fast; the real run uses config.US_GLOW_BBOX.
    out = build_us_glow(viirs, tmp_path / "us", bbox=(-84.9, 41.5, -83.5, 42.3), res_m=2_000)
    tif = tmp_path / "us" / "lightpollution_us.tif"
    assert out == tmp_path / "us" / "lightpollution_us.pmtiles"
    with rasterio.open(tif) as src:
        assert src.crs.to_epsg() == 5070 and src.count == 4
        alpha = src.read(4)
    assert alpha.max() > 0  # the fixture city glows
    red_tif = tmp_path / "us" / "lightpollution_us_red.tif"
    red_out = tmp_path / "us" / "lightpollution_us_red.pmtiles"
    with rasterio.open(red_tif) as src:
        r, g, b, a = src.read()
    assert (r[a > 0] >= 3 * g[a > 0]).all()  # the red-mode variant is red only
    assert ran == [["rio", "pmtiles", str(tif), str(out), "--format", "PNG", "--zoom-levels", "3..9", "--rgba"],
                   ["rio", "pmtiles", str(red_tif), str(red_out), "--format", "PNG", "--zoom-levels", "3..9", "--rgba"]]


def test_us_borders_command(tmp_path):
    from darksky_pipeline.us_glow import us_borders_command
    w, s, e, n = config.US_BORDERS_BBOX
    assert w <= -125 and e >= -65 and s <= 24 and n >= 60  # lower 48 plus room to zoom out
    cmd = us_borders_command("2026-09-23.1", tmp_path)
    assert cmd[:2] == ["pmtiles", "extract"]
    assert cmd[2].endswith("/tiles/2026-09-23.1/divisions.pmtiles")
    assert cmd[3] == str(tmp_path / "basemap_us_divisions.pmtiles")
    assert f"--bbox={w},{s},{e},{n}" in cmd and "--maxzoom=7" in cmd


def test_border_queries_filter_land_and_countries():
    from darksky_pipeline.us_glow import border_area_query, border_line_query
    lines, areas = border_line_query("2026-09-23.1"), border_area_query("2026-09-23.1")
    assert "type=division_boundary" in lines and "type=division_area" in areas
    for q in (lines, areas):
        assert "/2026-09-23.1/" in q and "class = 'land'" in q
    assert "subtype = 'region'" in areas and "country IN ('CA', 'MX', 'US')" in areas
    # Country-to-country borders carry no `country` value in Overture, so they must not be filtered by it.
    assert "(subtype = 'country' OR (subtype = 'region' AND country IN ('CA', 'MX', 'US')))" in lines


def test_land_borders_geojson_cuts_water_segments():
    import pandas as pd
    import shapely
    from darksky_pipeline.us_glow import land_borders_geojson
    # Two land squares with a 1-degree-wide lake between them; one border crosses all three.
    areas = pd.DataFrame({"wkb": [shapely.to_wkb(shapely.box(0, 0, 1, 1)), shapely.to_wkb(shapely.box(2, 0, 3, 1))]})
    lines = pd.DataFrame({"subtype": ["country", "region"],
                          "wkb": [shapely.to_wkb(shapely.LineString([(0.5, 0.5), (2.5, 0.5)])),
                                  shapely.to_wkb(shapely.LineString([(1.4, 5), (1.6, 6)]))]})  # all water
    fc = land_borders_geojson(lines, areas, slack_deg=0.01, simplify_deg=0.0)
    by = {(f["properties"]["subtype"], f["properties"]["water"]): shapely.geometry.shape(f["geometry"])
          for f in fc["features"]}
    # Country borders keep their water stretch as a separate (dashed) feature; state lines in water are dropped.
    assert set(by) == {("country", False), ("country", True)}
    assert abs(by[("country", False)].length - (0.51 + 0.51)) < 1e-6
    assert abs(by[("country", True)].length - (2.0 - 1.02)) < 1e-6

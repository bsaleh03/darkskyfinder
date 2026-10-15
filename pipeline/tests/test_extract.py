import shapely

from darksky_pipeline.extract import THEMES, build_query, extract_theme, theme_glob, connect
from darksky_pipeline.util import wkb_to_geoms
from overture_fixture import REGION_BBOX, RELEASE


def test_places_filtered_to_bbox_with_expected_columns(overture_frames):
    places = overture_frames["places"]
    assert list(places.columns) == ["id", "name", "category", "confidence", "lon", "lat"]
    assert "pl_out" not in set(places["id"])
    assert len(places) == 9
    hudson = places.set_index("id").loc["pl_hudson"]
    assert hudson["name"] == "Lake Hudson Recreation Area"
    assert abs(hudson["lon"] + 84.25) < 1e-9


def test_land_use_returns_polygons(overture_frames):
    lu = overture_frames["land_use"]
    assert set(lu["id"]) == {"lu_hudson", "lu_city", "lu_woods", "lu_tiny"}
    geoms = wkb_to_geoms(lu["wkb"])
    assert all(g.geom_type == "Polygon" for g in geoms)


def test_buildings_are_centroids(overture_frames):
    b = overture_frames["buildings"]
    assert list(b.columns) == ["lon", "lat"]  # I5: id dropped to save memory
    assert len(b) == 505


def test_segments_filtered_to_roads_in_sql(overture_frames):
    seg = overture_frames["segments"]
    assert "rd_rail" not in set(seg["id"])
    assert set(seg["subtype"]) == {"road"}


def test_divisions_filtered_to_search_subtypes_in_sql(overture_frames):
    from darksky_pipeline import config
    d = overture_frames["division_areas"]
    assert set(d["id"]) == {"div_testville"}
    assert set(d["subtype"]) <= config.DIVISION_SUBTYPES


def test_land_use_filtered_to_park_subtypes_in_sql(overture_frames):
    from darksky_pipeline import config
    lu = overture_frames["land_use"]
    assert "lu_resi" not in set(lu["id"])
    assert set(lu["subtype"]) <= config.PARK_SUBTYPES


def test_query_appends_where_clause():
    sql = build_query("g", THEMES["segments"], (-1.0, -2.0, 3.0, 4.0))
    assert "AND (subtype = 'road')" in sql
    sql = build_query("g", THEMES["land_use"], (-1.0, -2.0, 3.0, 4.0))
    assert "subtype IN ('campground', 'park', 'protected', 'recreation')" in sql


def test_segments_keep_nested_columns(overture_frames):
    seg = overture_frames["segments"].set_index("id")
    assert seg.loc["rd_hudson", "road_surface"][0]["value"] == "paved"
    assert seg.loc["rd_private", "access_restrictions"][0]["access_type"] == "denied"


def test_cache_round_trip(overture_root, tmp_path):
    con = connect()
    first = extract_theme(con, "places", REGION_BBOX, RELEASE,
                          source_root=overture_root.as_posix(), cache_dir=tmp_path)
    assert (tmp_path / "places.parquet").exists()
    again = extract_theme(con, "places", REGION_BBOX, RELEASE,
                          source_root="does/not/exist", cache_dir=tmp_path)
    assert sorted(again["id"]) == sorted(first["id"])


def test_query_uses_bbox_intersection_filter():
    sql = build_query(theme_glob("s3://x", "R", THEMES["places"]), THEMES["places"], (-1.0, -2.0, 3.0, 4.0))
    assert "bbox.xmax >= -1.0" in sql and "bbox.xmin <= 3.0" in sql
    assert "bbox.ymax >= -2.0" in sql and "bbox.ymin <= 4.0" in sql

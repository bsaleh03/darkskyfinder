from darksky_pipeline.extract import connect
from darksky_pipeline.probe import find_by_name, list_releases, place_categories
from overture_fixture import RELEASE


def test_place_categories_counts_matching_keywords(overture_frames):
    cats = place_categories(overture_frames["places"], ["park", "camp"]).set_index("category")["count"]
    assert cats["park"] == 4
    assert cats["campground"] == 1
    assert "restaurant" not in cats


def test_find_by_name_is_case_insensitive_and_covers_land_use(overture_frames):
    hits = find_by_name(overture_frames["places"], overture_frames["land_use"], "hudson")
    assert {"pl_hudson", "pl_hudson_launch", "pl_gas", "pl_lot", "lu_hudson"} <= set(hits["id"])
    assert set(hits["kind"]) == {"place", "land_use"}
    lu = hits.set_index("id").loc["lu_hudson"]
    assert abs(lu["lon"] + 84.25) < 0.02 and abs(lu["lat"] - 41.83) < 0.02


def test_list_releases_reads_directory_names(overture_root):
    assert list_releases(connect(), overture_root.as_posix()) == [RELEASE]


def test_sky_at_reads_grid(darkness_grid, tmp_path):
    from darksky_pipeline.probe import sky_at
    from overture_fixture import CITY, HUDSON

    path = tmp_path / "g.npz"
    darkness_grid.save(path)
    rows = dict((name, (sqm, label)) for name, sqm, label in
                sky_at(path, [("city", *CITY), ("hudson", *HUDSON)]))
    assert rows["hudson"][0] - rows["city"][0] > 2.0
    assert rows["city"][1] == "Milky Way not visible"

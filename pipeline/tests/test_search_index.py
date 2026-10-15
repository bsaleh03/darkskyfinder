import pytest

from darksky_pipeline.search_index import build_search_index, format_address, query, search_rows


@pytest.fixture(scope="module")
def index_path(overture_frames, tmp_path_factory):
    path = tmp_path_factory.mktemp("search") / "search.sqlite"
    rows = search_rows(overture_frames["places"], overture_frames["addresses"], overture_frames["division_areas"])
    build_search_index(rows, path)
    return path


def test_format_address():
    assert format_address("101", "Main St", [{"value": "MI"}, {"value": "Testville"}]) == "101 Main St, Testville"
    assert format_address(None, "Main St", None) == "Main St"
    assert format_address("5", None, None) is None


def test_rows_include_all_kinds(overture_frames):
    rows = search_rows(overture_frames["places"], overture_frames["addresses"], overture_frames["division_areas"])
    kinds = {k for _, k, _, _ in rows}
    assert kinds == {"place", "address", "locality"}
    names = {n for n, _, _, _ in rows}
    assert "Sketchy Park" not in names  # confidence 0.3 < 0.5
    assert None not in names


def test_query_address_prefix(index_path):
    hits = query(index_path, "101 mai")
    assert hits[0]["name"] == "101 Main St, Testville" and hits[0]["kind"] == "address"
    assert abs(hits[0]["lon"] + 84.051) < 1e-6


def test_query_prefix_matches_multiple(index_path):
    names = {h["name"] for h in query(index_path, "hud")}
    assert {"Lake Hudson Recreation Area", "Hudson Fuel"} <= names


def test_query_division(index_path):
    hits = query(index_path, "Testville")
    assert any(h["kind"] == "locality" for h in hits)


@pytest.mark.parametrize("text", ["O'Neill", '"quoted"', "Café*", "   ", "!!!", "AND OR NOT"])
def test_query_handles_punctuation(index_path, text):
    assert isinstance(query(index_path, text), list)


def test_rebuild_overwrites(tmp_path):
    path = tmp_path / "s.sqlite"
    build_search_index([("Alpha", "place", 1.0, 2.0)], path)
    build_search_index([("Beta", "place", 1.0, 2.0)], path)
    assert query(path, "alpha") == [] and query(path, "beta")[0]["name"] == "Beta"


def test_failed_rebuild_keeps_previous_index(tmp_path):
    path = tmp_path / "s.sqlite"
    build_search_index([("Alpha", "place", 1.0, 2.0)], path)
    with pytest.raises(Exception):
        build_search_index([("Broken",)], path)  # wrong arity -> sqlite error mid-build
    assert query(path, "alpha")[0]["name"] == "Alpha"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["s.sqlite"]

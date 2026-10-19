import sqlite3

import pandas as pd
import pytest

from darksky_pipeline.search_index import address_blocks, build_search_index, query, search_rows


@pytest.fixture(scope="module")
def index_path(overture_frames, tmp_path_factory):
    path = tmp_path_factory.mktemp("search") / "search.sqlite"
    rows = search_rows(overture_frames["places"], overture_frames["division_areas"])
    build_search_index(rows, path, *address_blocks(overture_frames["addresses"]))
    return path


def test_rows_are_places_and_divisions(overture_frames):
    rows = search_rows(overture_frames["places"], overture_frames["division_areas"])
    assert {k for _, k, _, _ in rows} == {"place", "locality"}
    names = {n for n, _, _, _ in rows}
    assert "Sketchy Park" not in names  # confidence 0.3 < 0.5
    assert None not in names


def _addr(number, street, city, lon, lat, postcode=None, state="MI"):
    levels = [{"value": state}] + ([{"value": city}] if city else [])
    return {"number": number, "street": street, "postcode": postcode, "address_levels": levels, "lon": lon, "lat": lat}


ADDRS = pd.DataFrame([
    _addr("101", "Main St", "ROYAL OAK", -83.100001, 42.500001, "48067"),
    _addr("101", "Main Street", "Royal Oak", -83.100003, 42.500003, "48067-1234"),  # same number: mean point
    _addr("150", "MAIN STREET", "Royal Oak", -83.1005, 42.5005, "48073"),
    _addr("199", "main st", "Royal Oak", -83.101, 42.501),
    _addr("205B", "Main St", "Royal Oak", -83.102, 42.502),  # leading integer 205 -> next block
    _addr("12", "Main St", "Ferndale", -83.13, 42.46),  # other city: other street row
    _addr("1/2", "Main St", "Ferndale", -83.13, 42.46),  # no leading integer... "1" is leading
    _addr("abc", "Main St", "Ferndale", -83.13, 42.46),  # no number: dropped
    _addr("5", None, "Ferndale", -83.13, 42.46),  # no street: dropped
    _addr("7", "South STATE Street", None, -84.0, 41.7, None, "OH"),  # no city level
])


def test_address_blocks_streets():
    streets, _ = address_blocks(ADDRS)
    by_display = {display: (sid, text) for sid, text, display in streets}
    assert set(by_display) == {"Main St, Royal Oak", "Main St, Ferndale", "S State St"}
    _, text = by_display["Main St, Royal Oak"]
    assert text == "main st royal oak mi 48067 48073"
    assert by_display["S State St"][1] == "s state st oh"
    assert len({sid for sid, _, _ in streets}) == 3


def test_address_blocks_groups_by_hundred_and_keeps_end_points():
    streets, blocks = address_blocks(ADDRS)
    sid = {display: s for s, _, display in streets}["Main St, Royal Oak"]
    mine = sorted(b for b in blocks if b[0] == sid)
    assert mine == [(sid, 101, 199, 42.5, -83.1, 42.501, -83.101), (sid, 205, 205, 42.502, -83.102, 42.502, -83.102)]
    fern = sorted(b for b in blocks if b[0] == {d: s for s, _, d in streets}["Main St, Ferndale"])
    assert [(b[1], b[2]) for b in fern] == [(1, 12)]


def test_address_blocks_round_to_five_decimals():
    _, blocks = address_blocks(ADDRS)
    for b in blocks:
        for v in b[3:]:
            assert round(v, 5) == v


def test_address_blocks_empty():
    assert address_blocks(ADDRS.iloc[0:0]) == ([], [])


def test_index_has_street_and_block_tables(index_path):
    con = sqlite3.connect(index_path)
    try:
        (sid, display), = con.execute("SELECT s.rowid, n.display FROM streets s JOIN street_names n ON n.id = s.rowid "
                                      "WHERE streets MATCH ? ORDER BY rank", ('"main" "st"*',))
        assert display == "Main St, Testville"
        # 1e-5 degree integers; the hi point is stored as an offset from the lo point
        assert con.execute("SELECT lo, hi, lat_lo, lon_lo, dlat_hi, dlon_hi FROM blocks WHERE street_id = ?",
                           (sid,)).fetchall() == [(101, 101, 4200100, -8405100, 0, 0)]
    finally:
        con.close()


def test_block_offsets_round_trip(tmp_path):
    path = tmp_path / "s.sqlite"
    build_search_index([], path, [(0, "main st", "Main St")], [(0, 101, 199, 42.5, -83.1, 42.50123, -83.10456)])
    con = sqlite3.connect(path)
    try:
        assert con.execute("SELECT lat_lo, lon_lo, lat_lo + dlat_hi, lon_lo + dlon_hi FROM blocks").fetchone() ==             (4250000, -8310000, 4250123, -8310456)
    finally:
        con.close()


def test_search_table_has_no_addresses(index_path):
    assert query(index_path, "101 mai") == []


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

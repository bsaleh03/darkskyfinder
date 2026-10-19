import pytest

from darksky_api.search import search


def test_prefix_match(store):
    hits = search(store, "lake hud")
    assert hits[0]["name"] == "Lake Hudson Recreation Area"
    assert hits[0]["metro"] == "test" and hits[0]["kind"] == "place"
    assert hits[0]["lat"] == pytest.approx(41.83)


def test_locality(store):
    assert search(store, "testv")[0]["kind"] == "locality"


@pytest.mark.parametrize("text", ["O'Neill", '"', "***", "   ", "AND OR NOT", "Café"])
def test_query_handles_punctuation(store, text):
    assert isinstance(search(store, text), list)


def test_apostrophe_name_found(store):
    assert search(store, "O'Neill")[0]["name"] == "O'Neill Park"


def test_metro_filter_and_limit(store):
    assert search(store, "park", metro="nope") == []
    assert len(search(store, "a", limit=1)) <= 1


def test_best_match_wins_across_metros(store, tmp_path):
    import dataclasses
    import sqlite3

    from darksky_api.data import DataStore, MetroData
    from fixtures import TEST_METRO

    weak_path = tmp_path / "search_aaa.sqlite"
    con = sqlite3.connect(weak_path)
    con.execute("CREATE VIRTUAL TABLE search USING fts5(name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED, "
                "tokenize='unicode61 remove_diacritics 2')")
    con.execute("INSERT INTO search (name, kind, lat, lon) VALUES (?, ?, ?, ?)",
                ("Parkside Plaza Shopping Center Area", "place", 41.0, -84.0))
    con.commit()
    con.close()

    weak = MetroData(info=dataclasses.replace(TEST_METRO, key="aaa"), release="2099-01-01.0", spots=[],
                     grid=store.metros["test"].grid, search_path=weak_path)
    both = DataStore({"aaa": weak, "test": store.metros["test"]})

    hits = search(both, "park", limit=1)
    assert hits[0]["name"] == "O'Neill Park"
    assert hits[0]["metro"] == "test"


def _index(path, rows, streets=None, blocks=()):
    import sqlite3

    from fixtures import write_address_tables

    con = sqlite3.connect(path)
    con.execute("CREATE VIRTUAL TABLE search USING fts5(name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED, "
                "tokenize='unicode61 remove_diacritics 2')")
    con.executemany("INSERT INTO search (name, kind, lat, lon) VALUES (?, ?, ?, ?)", rows)
    if streets is not None:
        write_address_tables(con, streets, blocks)
    con.commit()
    con.close()
    return path


def _store(store, tmp_path, metros, addresses=None):
    """addresses: {metro: (streets, blocks)} for metros that also get an address index."""
    import dataclasses

    from darksky_api.data import DataStore, MetroData
    from fixtures import TEST_METRO

    out = {}
    for key, rows in metros.items():
        streets, blocks = (addresses or {}).get(key, (None, ()))
        out[key] = MetroData(info=dataclasses.replace(TEST_METRO, key=key), release="2099-01-01.0", spots=[],
                             grid=store.metros["test"].grid,
                             search_path=_index(tmp_path / f"search_{key}.sqlite", rows, streets, blocks))
    return DataStore(out)


def test_locality_beats_many_place_hits_in_other_metro(store, tmp_path):
    many = [(f"Detroit Style Pizza {i}", "place", 37.0 + i * 0.05, -122.0) for i in range(60)]
    many += [("Detroit", "place", 37.5, -122.5)]  # an exact-name business still ranks below a division
    st = _store(store, tmp_path, {"aaa": many, "zzz": [("Detroit", "locality", 42.33, -83.05),
                                                         ("Detroit Lakes Plaza", "place", 42.0, -83.0)]})
    hits = search(st, "detroit", limit=8)
    assert hits[0] == {"name": "Detroit", "kind": "locality", "lat": 42.33, "lon": -83.05, "metro": "zzz",
                       "source": "overture"}
    assert hits[1]["name"] == "Detroit" and hits[1]["kind"] == "place"


def test_exact_and_word_match_beat_prefix(store, tmp_path):
    st = _store(store, tmp_path, {"aaa": [("Lakeside Mall", "place", 42.0, -83.0),
                                          ("Big Lake", "place", 42.1, -83.1),
                                          ("Lake", "place", 42.2, -83.2)]})
    assert [h["name"] for h in search(st, "lake ")] == ["Lake", "Big Lake", "Lakeside Mall"]
    st = _store(store, tmp_path, {"bbb": [("Lakes", "place", 42.0, -83.0),
                                          ("Big Lake Regional Park North Trail Head", "place", 42.1, -83.1)]})
    assert [h["name"] for h in search(st, "lake")] == ["Big Lake Regional Park North Trail Head", "Lakes"]


def test_duplicates_within_1km_collapse(store, tmp_path):
    st = _store(store, tmp_path, {"aaa": [("Royal Oak", "locality", 42.4895, -83.1446),
                                          ("Royal Oak", "locality", 42.4900, -83.1450),
                                          ("royal oak", "locality", 42.4890, -83.1440),
                                          ("Royal Oak", "locality", 42.80, -83.50),
                                          ("Royal Oak", "place", 42.4895, -83.1446)]})
    hits = search(st, "royal oak")
    assert [(h["kind"], round(h["lat"], 2)) for h in hits] == [("locality", 42.49), ("locality", 42.8),
                                                              ("place", 42.49)]


def test_short_tokens_dropped(store):
    assert search(store, "a") == []
    assert search(store, "a lake hud")[0]["name"] == "Lake Hudson Recreation Area"


# --- street addresses (Overture blocks, interpolated) ---------------------------

def test_hits_carry_overture_source(store):
    assert {h["source"] for h in search(store, "lake hud")} == {"overture"}


def test_address_interpolates_inside_block(store):
    hit = search(store, "150 main st testville")[0]
    assert hit["name"] == "150 Main St, Testville"
    assert hit["kind"] == "address" and hit["metro"] == "test" and hit["source"] == "overture"
    t = 50 / 98
    assert hit["lat"] == pytest.approx(42.0 + t * 0.001, abs=1e-5)
    assert hit["lon"] == pytest.approx(-84.05 - t * 0.002, abs=1e-5)


def test_address_block_ends_exact(store):
    assert search(store, "100 main st testville")[0]["lat"] == pytest.approx(42.0)
    hit = search(store, "250 main st testville")[0]
    assert (hit["lat"], hit["lon"]) == pytest.approx((42.003, -84.054))


def test_address_nearest_block_within_100(store):
    hit = search(store, "199 main st testville")[0]  # between blocks: nearest end is 198
    assert hit["name"] == "199 Main St, Testville" and (hit["lat"], hit["lon"]) == pytest.approx((42.001, -84.052))
    hit = search(store, "340 Main St Testville")[0]  # 90 past the last block
    assert hit["name"] == "340 Main St, Testville" and (hit["lat"], hit["lon"]) == pytest.approx((42.003, -84.054))


def test_address_number_out_of_range(store):
    assert [h for h in search(store, "351 main st testville") if h["kind"] == "address"] == []
    assert [h for h in search(store, "5000 main st testville") if h["kind"] == "address"] == []


def test_address_abbreviations_match(store):
    hit = search(store, "123 main street")[0]
    assert hit["name"] == "123 Main St, Testville" and hit["kind"] == "address"
    assert search(store, "1050 North Main Street")[0]["name"] == "1050 N Main St, Hudson"


def test_address_partial_long_form_while_typing(store):
    assert search(store, "123 main stre")[0]["name"] == "123 Main St, Testville"


def test_address_city_and_postcode_narrow(store):
    names = [h["name"] for h in search(store, "120 main") if h["kind"] == "address"]
    assert names == ["120 Main St, Testville"]  # the Hudson street has no block within 100 of 120
    assert [h["name"] for h in search(store, "1050 main st hudson")] == ["1050 N Main St, Hudson"]
    assert search(store, "1050 main st testville") == []
    assert search(store, "150 main st 49999")[0]["name"] == "150 Main St, Testville"
    assert search(store, "150 main st 12345") == []


def test_address_punctuation_and_suffix(store):
    assert search(store, "150, Main St., Testville, MI 49999")[0]["name"] == "150 Main St, Testville"
    assert search(store, "150b main st")[0]["name"] == "150b Main St, Testville"
    assert search(store, "7 lakeview")[0]["name"] == "7 Lakeview Rd, Testville"


def test_address_hits_rank_before_divisions_and_places(store, tmp_path):
    rows = [("Main", "locality", 42.0, -84.0), ("150 Main Street Cafe", "place", 42.0, -84.0)]
    st = _store(store, tmp_path, {"aaa": rows}, {"aaa": ([(0, "main st testville", "Main St, Testville")],
                                                         [(0, 100, 198, 42.0, -84.05, 42.001, -84.052)])})
    assert [h["kind"] for h in search(st, "150 main")] == ["address", "place"]
    assert [h["kind"] for h in search(st, "main")] == ["locality", "place"]  # no number: unchanged


def test_address_dedupes_same_street_and_city(store, tmp_path):
    streets = [(0, "main st testville 49999", "Main St, Testville"), (1, "main st testville 49998", "Main St, Testville")]
    blocks = [(0, 100, 198, 42.0, -84.05, 42.001, -84.052), (1, 100, 198, 42.0, -84.05, 42.001, -84.052)]
    st = _store(store, tmp_path, {"aaa": []}, {"aaa": (streets, blocks)})
    assert [h["name"] for h in search(st, "150 main st")] == ["150 Main St, Testville"]


def test_index_without_address_tables_still_searches(store, tmp_path):
    st = _store(store, tmp_path, {"aaa": [("150 Main Cafe", "place", 42.0, -84.0)]})
    assert [h["name"] for h in search(st, "150 main")] == ["150 Main Cafe"]


def test_address_metro_filter(store):
    assert search(store, "150 main st", metro="nope") == []
    assert search(store, "150 main st", metro="test")[0]["kind"] == "address"


# --- ORS fallback ---------------------------------------------------------------

class FakeGeocoder:
    def __init__(self, hits=None):
        self.hits = hits or []
        self.calls = []

    def search(self, text, bboxes):
        self.calls.append((text, dict(bboxes)))
        return list(self.hits)


ORS_HIT = {"name": "5500 Telegraph Road, Testville", "kind": "address", "lat": 41.9, "lon": -84.1, "metro": "test",
           "source": "openrouteservice"}


def test_fallback_used_when_overture_has_no_address(store):
    geo = FakeGeocoder([ORS_HIT])
    hits = search(store, "5500 Telegraph Rd Testville", geocoder=geo)
    assert hits[0] == ORS_HIT
    assert geo.calls == [("5500 Telegraph Rd Testville", {"test": store.metros["test"].info.bbox})]


def test_fallback_respects_metro_filter(store):
    geo = FakeGeocoder([ORS_HIT])
    search(store, "5500 Telegraph Rd", metro="test", geocoder=geo)
    assert geo.calls[0][1] == {"test": store.metros["test"].info.bbox}
    geo2 = FakeGeocoder([ORS_HIT])
    assert search(store, "5500 Telegraph Rd", metro="nope", geocoder=geo2) == [] and geo2.calls == []


def test_no_fallback_when_overture_found_address(store):
    geo = FakeGeocoder([ORS_HIT])
    assert search(store, "150 main st", geocoder=geo)[0]["source"] == "overture"
    assert geo.calls == []


@pytest.mark.parametrize("text", ["lake hudson", "testville", "5500", "5500 abc", "12 b c", "12345 n e", "12th st"])
def test_no_fallback_for_non_address_queries(store, text):
    geo = FakeGeocoder([ORS_HIT])
    search(store, text, geocoder=geo)
    assert geo.calls == []


def test_fallback_needs_four_letters(store):
    geo = FakeGeocoder([])
    search(store, "12 ab cde", geocoder=geo)
    assert len(geo.calls) == 1


@pytest.mark.parametrize("text", ["5500 Telegraph Rd D", "5500 Telegraph Rd De"])
def test_no_fallback_while_last_word_is_still_being_typed(store, text):
    geo = FakeGeocoder([])
    search(store, text, geocoder=geo)
    assert geo.calls == []


@pytest.mark.parametrize("text", ["5500 Telegraph Rd", "5500 Telegraph Rd Dea"])
def test_fallback_once_last_word_is_a_street_type_or_three_letters(store, text):
    geo = FakeGeocoder([])
    search(store, text, geocoder=geo)
    assert len(geo.calls) == 1


def test_address_hits_respect_limit(store, tmp_path):
    streets = [(i, f"main st town{i}", f"Main St, Town{i}") for i in range(5)]
    blocks = [(i, 100, 198, 42.0, -84.05, 42.001, -84.052) for i in range(5)]
    st = _store(store, tmp_path, {"aaa": []}, {"aaa": (streets, blocks)})
    assert len(search(st, "150 main st", limit=2)) == 2
    assert len(search(st, "150 main st")) == 5

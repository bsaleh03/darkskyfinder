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


def _index(path, rows):
    import sqlite3

    con = sqlite3.connect(path)
    con.execute("CREATE VIRTUAL TABLE search USING fts5(name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED, "
                "tokenize='unicode61 remove_diacritics 2')")
    con.executemany("INSERT INTO search (name, kind, lat, lon) VALUES (?, ?, ?, ?)", rows)
    con.commit()
    con.close()
    return path


def _store(store, tmp_path, metros):
    import dataclasses

    from darksky_api.data import DataStore, MetroData
    from fixtures import TEST_METRO

    out = {}
    for key, rows in metros.items():
        out[key] = MetroData(info=dataclasses.replace(TEST_METRO, key=key), release="2099-01-01.0", spots=[],
                             grid=store.metros["test"].grid,
                             search_path=_index(tmp_path / f"search_{key}.sqlite", rows))
    return DataStore(out)


def test_locality_beats_many_place_hits_in_other_metro(store, tmp_path):
    many = [(f"Detroit Style Pizza {i}", "place", 37.0 + i * 0.05, -122.0) for i in range(60)]
    many += [("Detroit", "place", 37.5, -122.5)]  # an exact-name business still ranks below a division
    st = _store(store, tmp_path, {"aaa": many, "zzz": [("Detroit", "locality", 42.33, -83.05),
                                                         ("Detroit Lakes Plaza", "place", 42.0, -83.0)]})
    hits = search(st, "detroit", limit=8)
    assert hits[0] == {"name": "Detroit", "kind": "locality", "lat": 42.33, "lon": -83.05, "metro": "zzz"}
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

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

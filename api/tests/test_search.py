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

from datetime import date

import httpx
import pytest

from darksky_api import config
from darksky_api.cache import TTLCache
from darksky_api.geocode import GeocodeClient

BBOXES = {"se_mi": (-84.6, 41.65, -82.4, 44.1), "bay_area": (-123.2, 36.4, -121.0, 38.6)}


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def feature(name, lon, lat, locality="Dearborn Heights", layer="address"):
    props = {"name": name, "layer": layer}
    if locality is not None:
        props["locality"] = locality
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props}


TELEGRAPH = feature("5500 Telegraph Road", -83.2741, 42.3260)


def make(handler, key="k", budget=500, today=lambda: date(2026, 10, 18), cache=None, clock=None):
    return GeocodeClient(httpx.Client(transport=httpx.MockTransport(handler)), key, cache=cache, budget=budget,
                         today=today, clock=clock or Clock())


def ok(*features, calls=None):
    def handler(req):
        if calls is not None:
            calls.append(req)
        return httpx.Response(200, json={"type": "FeatureCollection", "features": list(features)})
    return handler


def test_request_shape_and_hit():
    calls = []
    hits = make(ok(TELEGRAPH, calls=calls)).search("5500 Telegraph Rd Dearborn Heights", BBOXES)
    assert hits == [{"name": "5500 Telegraph Road, Dearborn Heights", "kind": "address", "lat": 42.326,
                     "lon": -83.2741, "metro": "se_mi", "source": "openrouteservice"}]
    (req,) = calls
    assert str(req.url).startswith(config.ORS_GEOCODE_URL + "?")
    assert req.method == "GET" and req.headers["Authorization"] == "k"
    assert dict(req.url.params) == {"text": "5500 Telegraph Rd Dearborn Heights", "layers": "address", "size": "5",
                                    "boundary.country": "US,CA"}
    assert "api_key" not in str(req.url)  # key only in the header


def test_name_without_locality():
    hits = make(ok(feature("5500 Telegraph Road", -83.27, 42.33, locality=None))).search("5500 telegraph rd", BBOXES)
    assert hits[0]["name"] == "5500 Telegraph Road"


def test_out_of_metro_results_dropped_and_metro_tagged():
    hits = make(ok(feature("1 Main St", -100.0, 40.0, "Nowhere"), TELEGRAPH,
                   feature("1 Dr Carlton B Goodlett Pl", -122.4192, 37.7793, "San Francisco"))).search("1 x st", BBOXES)
    assert [(h["name"], h["metro"]) for h in hits] == [("5500 Telegraph Road, Dearborn Heights", "se_mi"),
                                                       ("1 Dr Carlton B Goodlett Pl, San Francisco", "bay_area")]
    assert make(ok(TELEGRAPH)).search("5500 telegraph rd", {"bay_area": BBOXES["bay_area"]}) == []


def test_cache_hit_avoids_call_and_is_keyed_by_normalized_query():
    calls = []
    c = make(ok(TELEGRAPH, calls=calls), cache=TTLCache(3600))
    first = c.search("5500 Telegraph Road", BBOXES)
    assert c.search("5500  telegraph rd.", BBOXES) == first
    assert len(calls) == 1 and c.calls_today == 1
    c.search("5501 telegraph rd", BBOXES)
    assert len(calls) == 2


def test_cache_filters_by_metro_each_time():
    c = make(ok(TELEGRAPH), cache=TTLCache(3600))
    assert c.search("5500 telegraph rd", {"bay_area": BBOXES["bay_area"]}) == []
    assert c.search("5500 telegraph rd", BBOXES)[0]["metro"] == "se_mi"  # cached, still tagged


def test_cache_expires_after_a_day():
    clock = Clock()
    calls = []
    c = make(ok(TELEGRAPH, calls=calls), cache=TTLCache(config.GEOCODE_CACHE_TTL_S, clock=clock), clock=clock)
    c.search("5500 telegraph rd", BBOXES)
    clock.t += config.GEOCODE_CACHE_TTL_S + 1
    c.search("5500 telegraph rd", BBOXES)
    assert len(calls) == 2 and config.GEOCODE_CACHE_TTL_S == 24 * 3600


def test_budget_exhaustion_and_daily_reset():
    day = {"d": date(2026, 10, 18)}
    calls = []
    c = make(ok(TELEGRAPH, calls=calls), budget=1, today=lambda: day["d"])
    assert c.search("5500 telegraph rd", BBOXES) != []
    assert c.search("5600 telegraph rd", BBOXES) == []
    assert len(calls) == 1
    day["d"] = date(2026, 10, 19)
    assert c.search("5700 telegraph rd", BBOXES) != []
    assert config.ORS_GEOCODE_DAILY_BUDGET == 500


def test_budget_is_separate_from_routing():
    assert make(ok()).budget == config.ORS_GEOCODE_DAILY_BUDGET != config.ORS_DAILY_BUDGET


def test_missing_key_never_calls():
    def handler(req):
        raise AssertionError("must not call ORS without a key")
    assert make(handler, key=None).search("5500 telegraph rd", BBOXES) == []


@pytest.mark.parametrize("handler", [
    lambda req: httpx.Response(429, json={"error": "quota"}),
    lambda req: httpx.Response(500),
    lambda req: httpx.Response(200, content=b"not json"),
    lambda req: httpx.Response(200, json={"features": [{"geometry": {"coordinates": ["x", 1]}, "properties": {}}]}),
    lambda req: httpx.Response(200, json={"features": "nope"}),
    lambda req: httpx.Response(200, json=[1, 2]),
])
def test_failures_return_empty(handler):
    assert make(handler).search("5500 telegraph rd", BBOXES) == []


def test_timeout_returns_empty_and_backs_off():
    calls = []
    clock = Clock()

    def handler(req):
        calls.append(1)
        raise httpx.ConnectTimeout("slow", request=req)

    c = make(handler, clock=clock)
    assert c.search("5500 telegraph rd", BBOXES) == []
    assert c.search("5600 telegraph rd", BBOXES) == []
    assert len(calls) == 1
    clock.t += config.ROUTE_FAILURE_BACKOFF_S + 1
    c.search("5700 telegraph rd", BBOXES)
    assert len(calls) == 2


def test_failure_is_not_cached():
    responses = [httpx.Response(500), httpx.Response(200, json={"features": [TELEGRAPH]})]
    clock = Clock()
    c = make(lambda req: responses.pop(0), cache=TTLCache(3600), clock=clock)
    assert c.search("5500 telegraph rd", BBOXES) == []
    clock.t += config.ROUTE_FAILURE_BACKOFF_S + 1
    assert c.search("5500 telegraph rd", BBOXES) != []


def test_key_never_in_logs_or_repr(caplog):
    key = "secret-geo-key-123"

    def handler(req):
        raise httpx.InvalidURL("bad url")

    with caplog.at_level("DEBUG"):
        c = make(handler, key=key)
        assert c.search("5500 telegraph rd", BBOXES) == []
    assert key not in caplog.text and all(key not in r.getMessage() for r in caplog.records)
    assert key not in repr(c) and key not in str(c)
    assert "telegraph" not in caplog.text.lower()  # the typed address is not logged either


def test_uses_routing_timeout():
    seen = {}

    def handler(req):
        seen.update(req.extensions.get("timeout", {}))
        return httpx.Response(200, json={"features": []})

    make(handler).search("5500 telegraph rd", BBOXES)
    assert seen["read"] == config.ORS_TIMEOUT_S


def test_non_address_fallbacks_dropped():
    """Pelias answers an unknown address with the town's centroid (layer locality, match_type fallback)."""
    town = feature("Dearborn Heights", -83.2959, 42.3406, layer="locality")
    assert make(ok(town)).search("5500 telegraph rd dearborn heights", BBOXES) == []
    hits = make(ok(town, TELEGRAPH)).search("5500 telegraph rd dearborn heights", BBOXES)
    assert [h["name"] for h in hits] == ["5500 Telegraph Road, Dearborn Heights"]

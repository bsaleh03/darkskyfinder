import json
from datetime import date

import httpx
import pytest

from darksky_api.cache import TTLCache
from darksky_api.routing import RoutingClient, estimate_minutes, haversine_km

START = (-84.05, 42.00)
DESTS = [("a", -84.25, 41.83), ("b", -84.15, 41.78)]


def make(handler, key="k", budget=450, today=lambda: date(2026, 10, 16), cache=None):
    return RoutingClient(httpx.Client(transport=httpx.MockTransport(handler)), key, cache=cache,
                         budget=budget, today=today)


def ok(durations):
    def handler(req):
        body = json.loads(req.content)
        assert req.headers["Authorization"] == "k"
        assert body["sources"] == [0] and body["destinations"] == [1, 2]
        assert body["locations"][0] == list(START)
        return httpx.Response(200, json={"durations": [durations]})
    return handler


def test_haversine_and_estimate():
    km = haversine_km(-84.05, 42.00, -84.25, 41.83)
    assert 24 < km < 27
    assert estimate_minutes(60.0) == pytest.approx(81.0)


def test_ors_durations_to_minutes():
    minutes, est = make(ok([1800.0, 2400.0])).drive_minutes(START, DESTS)
    assert est is False and minutes == {"a": 30.0, "b": 40.0}


def test_null_duration_drops_spot():
    minutes, est = make(ok([1800.0, None])).drive_minutes(START, DESTS)
    assert est is False and minutes == {"a": 30.0}


@pytest.mark.parametrize("handler", [
    lambda req: httpx.Response(429, json={"error": "quota"}),
    lambda req: httpx.Response(500),
])
def test_http_errors_fall_back(handler):
    minutes, est = make(handler).drive_minutes(START, DESTS)
    assert est is True and set(minutes) == {"a", "b"}
    assert minutes["a"] == pytest.approx(estimate_minutes(haversine_km(*START, -84.25, 41.83)))


def test_timeout_falls_back():
    def handler(req):
        raise httpx.ConnectTimeout("slow", request=req)
    assert make(handler).drive_minutes(START, DESTS)[1] is True


def test_missing_key_never_calls():
    def handler(req):
        raise AssertionError("must not call ORS without a key")
    assert make(handler, key=None).drive_minutes(START, DESTS)[1] is True


def test_cache_hit_avoids_call():
    calls = []

    def handler(req):
        calls.append(1)
        return ok([60.0, 120.0])(req)

    c = make(handler, cache=TTLCache(3600))
    c.drive_minutes(START, DESTS)
    c.drive_minutes((-84.0501, 42.0003), list(reversed(DESTS)))  # same rounded start, same id set
    assert len(calls) == 1


def test_budget_switches_to_estimates_and_resets_daily():
    day = {"d": date(2026, 10, 16)}
    c = make(lambda req: httpx.Response(200, json={"durations": [[60.0, 120.0]]}), budget=1,
             today=lambda: day["d"])
    assert c.drive_minutes(START, DESTS)[1] is False
    assert c.drive_minutes((-83.0, 42.3), DESTS)[1] is True
    day["d"] = date(2026, 10, 17)
    assert c.drive_minutes((-83.1, 42.4), DESTS)[1] is False


def test_empty_dests():
    assert make(ok([])).drive_minutes(START, []) == ({}, False)

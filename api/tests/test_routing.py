import json
from datetime import date

import httpx
import pytest

from darksky_api.cache import TTLCache
from darksky_api.routing import RoutingClient, estimate_minutes, haversine_km

START = (-84.05, 42.00)
DESTS = [("a", -84.25, 41.83), ("b", -84.15, 41.78)]


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make(handler, key="k", budget=450, today=lambda: date(2026, 10, 16), cache=None, clock=None):
    return RoutingClient(httpx.Client(transport=httpx.MockTransport(handler)), key, cache=cache,
                         budget=budget, today=today, clock=clock or Clock())


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
    assert est == set() and minutes == {"a": 30.0, "b": 40.0}


def test_null_duration_keeps_spot_with_estimate():
    calls = []

    def handler(req):
        calls.append(1)
        return ok([1800.0, None])(req)

    c = make(handler)
    minutes, est = c.drive_minutes(START, DESTS)
    assert est == {"b"} and minutes["a"] == 30.0
    assert minutes["b"] == pytest.approx(estimate_minutes(haversine_km(*START, -84.15, 41.78)))
    assert c.drive_minutes(START, DESTS) == (minutes, {"b"})  # unroutable result is cached too
    assert len(calls) == 1


@pytest.mark.parametrize("handler", [
    lambda req: httpx.Response(429, json={"error": "quota"}),
    lambda req: httpx.Response(500),
])
def test_http_errors_fall_back(handler):
    minutes, est = make(handler).drive_minutes(START, DESTS)
    assert est == {"a", "b"} and set(minutes) == {"a", "b"}
    assert minutes["a"] == pytest.approx(estimate_minutes(haversine_km(*START, -84.25, 41.83)))


def test_timeout_falls_back():
    def handler(req):
        raise httpx.ConnectTimeout("slow", request=req)
    assert make(handler).drive_minutes(START, DESTS)[1] == {"a", "b"}


def test_missing_key_never_calls():
    def handler(req):
        raise AssertionError("must not call ORS without a key")
    assert make(handler, key=None).drive_minutes(START, DESTS)[1] == {"a", "b"}


def test_cache_hit_avoids_call():
    calls = []

    def handler(req):
        calls.append(1)
        return ok([60.0, 120.0])(req)

    c = make(handler, cache=TTLCache(3600))
    c.drive_minutes(START, DESTS)
    c.drive_minutes((-84.0501, 42.0003), list(reversed(DESTS)))  # same rounded start, same id set
    assert len(calls) == 1


def test_superset_pool_routes_only_new_ids():
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append([tuple(loc) for loc in body["locations"][1:]])
        return httpx.Response(200, json={"durations": [[600.0 * (k + 1) for k in range(len(body["destinations"]))]]})

    c = make(handler, cache=TTLCache(3600))
    c.drive_minutes(START, DESTS)
    minutes, est = c.drive_minutes(START, DESTS + [("c", -84.30, 41.95)])
    assert seen[1] == [(-84.30, 41.95)]
    assert minutes == {"a": 10.0, "b": 20.0, "c": 10.0} and est == set()


def test_failure_backs_off_then_retries():
    calls = []
    clock = Clock()

    def handler(req):
        calls.append(1)
        return httpx.Response(503)

    c = make(handler, clock=clock)
    assert c.drive_minutes(START, DESTS)[1] == {"a", "b"}
    assert c.drive_minutes(START, DESTS)[1] == {"a", "b"}
    assert len(calls) == 1 and c.calls_today == 1
    clock.t += 61
    c.drive_minutes(START, DESTS)
    assert len(calls) == 2


def test_budget_switches_to_estimates_and_resets_daily():
    day = {"d": date(2026, 10, 16)}
    c = make(lambda req: httpx.Response(200, json={"durations": [[60.0, 120.0]]}), budget=1,
             today=lambda: day["d"])
    assert c.drive_minutes(START, DESTS)[1] == set()
    assert c.drive_minutes((-83.0, 42.3), DESTS)[1] == {"a", "b"}
    day["d"] = date(2026, 10, 17)
    assert c.drive_minutes((-83.1, 42.4), DESTS)[1] == set()


def test_empty_dests():
    assert make(ok([])).drive_minutes(START, []) == ({}, set())


def _json_handler(body):
    return lambda req: httpx.Response(200, json=body)


@pytest.mark.parametrize("body", [
    {"durations": [["1800.0", 2400.0]]},  # string value
    {"durations": [None]},  # row is null
    {"durations": [[True, 2400.0]]},  # bool is not a duration
    {"other": [[1800.0, 2400.0]]},  # missing durations key
    [1800.0, 2400.0],  # wrong top-level type
])
def test_malformed_200_body_falls_back(body):
    minutes, est = make(_json_handler(body)).drive_minutes(START, DESTS)
    assert est == {"a", "b"} and set(minutes) == {"a", "b"}


@pytest.mark.parametrize("row", [[1800.0], [1800.0, 2400.0, 60.0]])
def test_wrong_length_row_falls_back_and_is_not_cached(row):
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(200, json={"durations": [row]})

    clock = Clock()
    c = make(handler, clock=clock)
    assert c.drive_minutes(START, DESTS)[1] == {"a", "b"}
    clock.t += 61  # past the failure back-off
    assert c.drive_minutes(START, DESTS)[1] == {"a", "b"}
    assert len(calls) == 2


def test_failure_never_logs_api_key(caplog):
    key = "secret-key-123"

    def handler(req):
        raise httpx.InvalidURL("bad url")

    with caplog.at_level("DEBUG"):
        minutes, est = make(handler, key=key).drive_minutes(START, DESTS)
    assert est == {"a", "b"}
    assert all(key not in r.getMessage() for r in caplog.records)
    assert key not in caplog.text

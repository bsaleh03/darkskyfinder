import pytest
from fastapi.testclient import TestClient

from darksky_api.app import create_app
from darksky_api.config import Settings
from darksky_api.ratelimit import SlidingWindowLimiter
from fakes import FakeForecast, FakeRouting, fixed_today
from fixtures import CITY
from test_service import MINUTES

SETTINGS = Settings(ors_api_key="secret-key", allowed_origins=("https://app.example", "http://localhost:5173"),
                    data_dir=None)


@pytest.fixture()
def client(store):
    app = create_app(store, FakeRouting(MINUTES), FakeForecast(), SETTINGS,
                     limiter=SlidingWindowLimiter(3), today=fixed_today)
    return TestClient(app, raise_server_exceptions=False)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True, "metros": ["test"], "release": "2099-01-01.0"}


def test_regions(client):
    (reg,) = client.get("/api/regions").json()
    assert reg["key"] == "test" and reg["timezone"] == "America/Detroit" and len(reg["bbox"]) == 4


def test_search(client):
    hits = client.get("/api/search", params={"q": "lake hud"}).json()
    assert hits[0]["name"] == "Lake Hudson Recreation Area" and hits[0]["metro"] == "test"
    assert client.get("/api/search", params={"q": "!!!"}).json() == []
    assert client.get("/api/search", params={"q": "x", "limit": 99}).status_code == 422


def test_spots_ok(client):
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0]})
    assert r.status_code == 200
    body = r.json()
    assert body["spots"][0]["id"] == "sp_hudson"
    assert body["spots"][0]["display_name"] == "Lake Hudson"
    assert "secret-key" not in r.text


def test_spots_current_night_marks_past_hours(store):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    app = create_app(store, FakeRouting(MINUTES), FakeForecast(), SETTINGS,
                     now=lambda tz: datetime(2026, 10, 17, 1, tzinfo=ZoneInfo(tz)))
    body = TestClient(app).get("/api/spots", params={"lat": CITY[1], "lon": CITY[0]}).json()
    assert body["night"] == "2026-10-16"
    assert body["spots"][0]["timeline"][0]["past"] is True


def test_spots_errors(client):
    r = client.get("/api/spots", params={"lat": 30, "lon": -90})
    assert r.status_code == 422 and r.json()["error"] == "out_of_coverage"
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0], "night": "2026-12-01"})
    assert r.status_code == 422 and r.json()["error"] == "night_out_of_range"
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0], "sort": "weird"})
    assert r.status_code == 422 and r.json()["error"] == "invalid_request"
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0], "max_drive": 5})
    assert r.status_code == 422


def test_rate_limit(client):
    params = {"lat": CITY[1], "lon": CITY[0]}
    codes = [client.get("/api/spots", params=params).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    assert client.get("/api/spots", params=params).json() == {"error": "rate_limited"}


def test_forwarded_for_used_for_rate_limit(client):
    params = {"lat": CITY[1], "lon": CITY[0]}
    for _ in range(3):
        client.get("/api/spots", params=params, headers={"X-Forwarded-For": "6.6.6.6, 1.1.1.1"})
    # spoofed left part does not evade the limit: same real (right-most) IP
    assert client.get("/api/spots", params=params, headers={"X-Forwarded-For": "7.7.7.7, 1.1.1.1"}).status_code == 429


def test_forwarded_for_distinct_clients(client):
    params = {"lat": CITY[1], "lon": CITY[0]}
    for _ in range(3):
        client.get("/api/spots", params=params, headers={"X-Forwarded-For": "1.1.1.1"})
    assert client.get("/api/spots", params=params, headers={"X-Forwarded-For": "2.2.2.2"}).status_code == 200


def test_cors(client):
    r = client.options("/api/spots", headers={"Origin": "https://app.example", "Access-Control-Request-Method": "GET"})
    assert r.headers["access-control-allow-origin"] == "https://app.example"
    r = client.options("/api/spots", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers


def test_internal_error_hides_details(store):
    class Boom:
        def drive_minutes(self, *a):
            raise RuntimeError("secret internals")

    app = create_app(store, Boom(), FakeForecast(), SETTINGS, today=fixed_today)
    r = TestClient(app, raise_server_exceptions=False).get("/api/spots", params={"lat": CITY[1], "lon": CITY[0]})
    assert r.status_code == 500 and r.json() == {"error": "internal"}
    assert "secret" not in r.text


def test_trusted_proxy_hops_from_settings(store):
    import dataclasses

    app = create_app(store, FakeRouting(MINUTES), FakeForecast(), dataclasses.replace(SETTINGS, trusted_proxy_hops=2),
                     limiter=SlidingWindowLimiter(3), today=fixed_today)
    c = TestClient(app)
    params = {"lat": CITY[1], "lon": CITY[0]}
    for _ in range(3):
        c.get("/api/spots", params=params, headers={"X-Forwarded-For": "6.6.6.6, 1.1.1.1, 10.0.0.1"})
    assert c.get("/api/spots", params=params,
                 headers={"X-Forwarded-For": "7.7.7.7, 1.1.1.1, 10.0.0.2"}).status_code == 429
    assert c.get("/api/spots", params=params,
                 headers={"X-Forwarded-For": "1.1.1.1, 3.3.3.3, 10.0.0.1"}).status_code == 200


def test_search_rate_limited(store):
    app = create_app(store, FakeRouting(MINUTES), FakeForecast(), SETTINGS,
                     search_limiter=SlidingWindowLimiter(2), today=fixed_today)
    c = TestClient(app)
    codes = [c.get("/api/search", params={"q": "lake"}).status_code for _ in range(3)]
    assert codes == [200, 200, 429]
    assert c.get("/api/search", params={"q": "lake"}).json() == {"error": "rate_limited"}
    assert c.get("/api/search", params={"q": "lake"}, headers={"X-Forwarded-For": "2.2.2.2"}).status_code == 200


def test_internal_error_keeps_cors_headers(store):
    class Boom:
        def drive_minutes(self, *a):
            raise RuntimeError("secret internals")

    app = create_app(store, Boom(), FakeForecast(), SETTINGS, today=fixed_today)
    r = TestClient(app, raise_server_exceptions=False).get(
        "/api/spots", params={"lat": CITY[1], "lon": CITY[0]}, headers={"Origin": "https://app.example"})
    assert r.status_code == 500 and r.json() == {"error": "internal"}
    assert r.headers["access-control-allow-origin"] == "https://app.example"


def test_large_responses_are_gzipped(client):
    r = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0]}, headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"
    small = client.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in small.headers


def test_spot_schema_documents_pass_through_fields(client):
    comps = client.get("/openapi.json").json()["components"]["schemas"]
    spot = comps["Spot"]["properties"]
    for f in ("category", "bortle", "sky_label", "radiance", "glare", "horizon", "access", "dark_sky_place",
              "unavailable_reason", "amenities", "why"):
        assert f in spot, f
    assert set(comps["Horizon"]["properties"]) == {"class", "open_frac", "closed_frac", "water_frac"}
    assert set(comps["Amenities"]["properties"]) == {"restroom", "fuel", "food"}
    assert "past" in comps["TimelineHour"]["properties"]


def test_spot_pass_through_values_serialized(client, store):
    top = client.get("/api/spots", params={"lat": CITY[1], "lon": CITY[0]}).json()["spots"][0]
    src = next(s for s in store.metros["test"].spots if s["id"] == top["id"])
    for f in ("category", "bortle", "glare", "horizon", "access", "amenities", "why", "dark_sky_place"):
        assert top[f] == src[f], f

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

from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

from darksky_api.cache import TTLCache
from darksky_api.forecast import ForecastClient, HourWeather, cell_of, hour_key

TIMES = ["2026-10-16T21:00", "2026-10-16T22:00"]


def payload(cloud=10):
    return {"hourly": {"time": TIMES, "cloud_cover": [cloud, cloud], "cloud_cover_low": [0, 80],
                       "visibility": [24000, None]}}


def client_with(handler, cache=None):
    return ForecastClient(httpx.Client(transport=httpx.MockTransport(handler)), cache=cache)


def test_cell_and_hour_key():
    assert cell_of(41.8349, -84.2512) == (41.8, -84.3)
    assert hour_key(datetime(2026, 10, 16, 21, 0, tzinfo=ZoneInfo("America/Detroit"))) == "2026-10-16T21:00"


def test_single_cell_parses():
    calls = []

    def handler(req):
        calls.append(req)
        assert req.url.params["hourly"] == "cloud_cover,cloud_cover_low,visibility"
        assert req.url.params["timezone"] == "America/Detroit"
        return httpx.Response(200, json=payload())

    out = client_with(handler).get([(41.8, -84.3)], "America/Detroit")
    assert out[(41.8, -84.3)]["2026-10-16T21:00"] == HourWeather(10, 0, 24000)
    assert out[(41.8, -84.3)]["2026-10-16T22:00"].visibility is None
    assert len(calls) == 1


def test_multi_cell_list_response():
    def handler(req):
        assert req.url.params["latitude"] == "41.8,42.0"
        return httpx.Response(200, json=[payload(10), payload(90)])

    out = client_with(handler).get([(41.8, -84.3), (42.0, -84.1)], "America/Detroit")
    assert out[(42.0, -84.1)]["2026-10-16T21:00"].cloud == 90


def test_cache_avoids_second_call():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(200, json=payload())

    c = client_with(handler, cache=TTLCache(3600))
    c.get([(41.8, -84.3)], "America/Detroit")
    c.get([(41.8, -84.3)], "America/Detroit")
    assert len(calls) == 1


def test_failure_returns_empty():
    def handler(req):
        return httpx.Response(503)

    assert client_with(handler).get([(41.8, -84.3)], "America/Detroit") == {}


def test_timeout_returns_empty():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    assert client_with(handler).get([(41.8, -84.3)], "America/Detroit") == {}

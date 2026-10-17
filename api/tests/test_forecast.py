from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx

from darksky_api.cache import TTLCache
from darksky_api.forecast import ForecastClient, HourWeather, cell_of, hour_key

T21 = int(datetime(2026, 10, 17, 1, tzinfo=timezone.utc).timestamp())  # 21:00 EDT
TIMES = [T21, T21 + 3600]


def payload(cloud=10):
    return {"hourly": {"time": TIMES, "cloud_cover": [cloud, cloud], "cloud_cover_low": [0, 80],
                       "visibility": [24000, None]}}


def client_with(handler, cache=None):
    return ForecastClient(httpx.Client(transport=httpx.MockTransport(handler)), cache=cache)


def test_cell_and_hour_key():
    assert cell_of(41.8349, -84.2512) == (41.8, -84.3)
    assert hour_key(datetime(2026, 10, 16, 21, 0, tzinfo=ZoneInfo("America/Detroit"))) == T21
    assert hour_key(datetime(2026, 10, 16, 21, 59, tzinfo=ZoneInfo("America/Detroit"))) == T21


def test_fall_back_repeated_hour_has_distinct_keys():
    tz = ZoneInfo("America/Detroit")
    first = datetime(2026, 11, 1, 1, 0, tzinfo=tz)  # EDT
    second = datetime(2026, 11, 1, 1, 0, fold=1, tzinfo=tz)  # EST
    assert hour_key(second) - hour_key(first) == 3600


def test_single_cell_parses():
    calls = []

    def handler(req):
        calls.append(req)
        assert req.url.params["hourly"] == "cloud_cover,cloud_cover_low,visibility"
        assert req.url.params["timezone"] == "America/Detroit"
        assert req.url.params["timeformat"] == "unixtime"
        return httpx.Response(200, json=payload())

    out = client_with(handler).get([(41.8, -84.3)], "America/Detroit")
    assert out[(41.8, -84.3)][T21] == HourWeather(10, 0, 24000)
    assert out[(41.8, -84.3)][T21 + 3600].visibility is None
    assert len(calls) == 1


def test_multi_cell_list_response():
    def handler(req):
        assert req.url.params["latitude"] == "41.8,42.0"
        return httpx.Response(200, json=[payload(10), payload(90)])

    out = client_with(handler).get([(41.8, -84.3), (42.0, -84.1)], "America/Detroit")
    assert out[(42.0, -84.1)][T21].cloud == 90


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

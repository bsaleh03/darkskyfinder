from datetime import date

import pytest

from darksky_api.service import QueryError, SpotsQuery, find_spots
from fakes import FakeForecast, FakeRouting, fixed_today
from fixtures import CITY, SPOTS, TEST_METRO, build_data_dir

MINUTES = {"sp_hudson": 30.0, "sp_camp": 40.0, "sp_city": 5.0, "sp_closed": 20.0, "sp_far": 70.0}


def run(store, routing=None, forecast=None, **kw):
    q = SpotsQuery(lat=CITY[1], lon=CITY[0], **kw)
    return find_spots(store, routing or FakeRouting(MINUTES), forecast or FakeForecast(), q, today=fixed_today)


def test_happy_path_shape(store):
    r = run(store)
    assert r["metro"] == "test" and r["night"] == "2026-10-16" and r["timezone"] == "America/Detroit"
    assert r["start"]["sqm"] == pytest.approx(18.0)
    assert r["forecast_status"] == "ok" and r["drive_status"] == "ok"
    assert r["verdict"]["rating"] == "good"
    assert r["verdict"]["dark"]["kind"] == "astronomical"
    assert r["verdict"]["moon"]["set"] is not None
    ranked = [s for s in r["spots"] if not s["unavailable"]]
    top = ranked[0]
    assert top["id"] == "sp_hudson"
    assert top["drive_minutes"] == 30 and top["drive_is_estimate"] is False
    assert top["darker_than_home"] == "~30× darker"
    assert set(top["scores"]) == {"site", "conditions", "best_view", "relevant"}
    assert top["timeline"][0]["time"].startswith("2026-10-16T21:00")
    assert top["best_window"] is not None


def test_unavailable_last_and_unscored(store):
    r = run(store)
    assert r["spots"][-1]["id"] == "sp_closed"
    assert r["spots"][-1]["scores"] is None and r["spots"][-1]["timeline"] == []


@pytest.mark.parametrize("sort,first", [("closest", "sp_city"), ("best_view", "sp_far"), ("relevant", "sp_hudson")])
def test_sorts(store, sort, first):
    assert run(store, sort=sort)["spots"][0]["id"] == first


def test_access_filter(store):
    ids = {s["id"] for s in run(store, access="likely")["spots"]}
    assert ids == {"sp_hudson", "sp_camp"}
    assert {s["id"] for s in run(store, access="verified")["spots"]} == {"sp_hudson"}


def test_max_drive_filter(store):
    ids = {s["id"] for s in run(store, max_drive=35)["spots"]}
    assert ids == {"sp_hudson", "sp_city", "sp_closed"}


def test_limit(store):
    ranked = [s for s in run(store, limit=2)["spots"] if not s["unavailable"]]
    assert len(ranked) == 2


def test_no_spots_in_range(store):
    r = run(store, routing=FakeRouting({}), max_drive=15)
    assert r["spots"] == [] and r["verdict"]["rating"] == "unknown"


def test_out_of_coverage(store):
    with pytest.raises(QueryError) as e:
        find_spots(store, FakeRouting(MINUTES), FakeForecast(), SpotsQuery(lat=30.0, lon=-90.0), today=fixed_today)
    assert e.value.code == "out_of_coverage" and e.value.detail["metros"] == ["test"]


@pytest.mark.parametrize("night", [date(2026, 10, 15), date(2026, 10, 23)])
def test_night_out_of_range(store, night):
    with pytest.raises(QueryError) as e:
        run(store, night=night)
    assert e.value.code == "night_out_of_range"


def test_forecast_unavailable_still_ranks(store):
    r = run(store, forecast=FakeForecast(fail=True))
    assert r["forecast_status"] == "unavailable"
    assert r["spots"][0]["timeline"][0]["cloud"] is None


def test_forecast_unavailable_verdict_is_unknown(store):
    v = run(store, forecast=FakeForecast(fail=True))["verdict"]
    assert v["rating"] == "unknown"
    assert v["sentence"].startswith("Forecast unavailable — ranked by darkness and drive time")
    assert v["sentence"].endswith(".")
    assert run(store)["verdict"]["rating"] == "good"


def test_forecast_partial(store):
    r = run(store, forecast=FakeForecast(fail_cells={(41.8, -84.2)}))
    assert r["forecast_status"] == "partial"


def test_estimates_flagged(store):
    r = run(store, routing=FakeRouting(None, estimate=True))
    assert r["drive_status"] == "approx"
    assert all(s["drive_is_estimate"] for s in r["spots"])


def test_cloudy_night_is_poor(store):
    assert run(store, forecast=FakeForecast(cloud=95.0))["verdict"]["rating"] == "poor"


def test_prefilter_caps_and_skips_far(store):
    routing = FakeRouting(MINUTES)
    run(store, routing=routing, max_drive=15)
    assert "sp_far" not in routing.calls[0][1]  # 28 km > 15 min × 1.2 km/min


def test_start_sqm_nan_is_safe(tmp_path):
    from darksky_api.data import DataStore
    from darksky_api.config import MetroInfo

    wide = MetroInfo("test", "Wide", (-85.5, 41.0, -83.0, 43.0), (-84.2, 41.9), 9, "America/Detroit", "X")
    build_data_dir(tmp_path)
    store = DataStore.load(tmp_path, {"test": wide})
    q = SpotsQuery(lat=42.9, lon=-85.4)  # inside bbox, outside the darkness grid
    r = find_spots(store, FakeRouting(None), FakeForecast(), q, today=fixed_today)
    assert r["start"]["sqm"] is None
    assert all(s["darker_than_home"] == "about the same" for s in r["spots"])

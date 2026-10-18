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


def test_estimates_flagged_per_spot(store):
    r = run(store, routing=FakeRouting(MINUTES, estimate={"sp_camp"}))
    assert r["drive_status"] == "approx"
    flags = {s["id"]: s["drive_is_estimate"] for s in r["spots"]}
    assert flags["sp_camp"] is True
    assert not any(v for k, v in flags.items() if k != "sp_camp")


def test_cloudy_night_is_poor(store):
    assert run(store, forecast=FakeForecast(cloud=95.0))["verdict"]["rating"] == "poor"


def test_prefilter_caps_and_skips_far(store):
    routing = FakeRouting(MINUTES)
    run(store, routing=routing, max_drive=15)
    assert "sp_far" not in routing.calls[0][1]  # 28 km > 15 min × 1.2 km/min


def test_start_sqm_nan_is_safe(tmp_path):
    from darksky_api.data import DataStore
    from darksky_api.config import MetroInfo

    wide = MetroInfo("test", "Wide", (-85.5, 41.0, -83.0, 43.0), (-84.2, 41.9), 9, "America/Detroit", "X", "US", "US-MI")
    build_data_dir(tmp_path)
    store = DataStore.load(tmp_path, {"test": wide})
    q = SpotsQuery(lat=42.9, lon=-85.4)  # inside bbox, outside the darkness grid
    r = find_spots(store, FakeRouting(None), FakeForecast(), q, today=fixed_today)
    assert r["start"]["sqm"] is None
    assert all(s["darker_than_home"] == "about the same" for s in r["spots"])


def _dense_store(tmp_path):
    from darksky_api.data import DataStore
    from fixtures import make_spot

    spots = [make_spot(f"b{i:02d}", f"City Park {i}", -84.05 + 0.0005 * (i % 10), 42.00 + 0.003 * (1 + i // 10), 18.2,
                       horizon="partial") for i in range(60)]
    spots.append(make_spot("dark1", "Dark Preserve", -84.39, 42.00, 21.8, horizon="open"))
    d = build_data_dir(tmp_path, spots=spots)
    return DataStore.load(d, {"test": TEST_METRO})


def test_prefilter_keeps_dark_site_beyond_dense_nearby_spots(tmp_path):
    st = _dense_store(tmp_path)
    routing = FakeRouting(None)
    r = run(st, routing=routing, sort="relevant", max_drive=90)
    assert r["spots"][0]["id"] == "dark1"
    assert "dark1" in routing.calls[0][1]
    assert len(routing.calls[0][1]) <= 50

    routing = FakeRouting(None)
    r = run(st, routing=routing, sort="closest", max_drive=90)
    assert r["spots"][0]["id"].startswith("b")
    assert "dark1" not in routing.calls[0][1]


def test_timestamps_have_no_seconds(store):
    import re

    r = run(store)
    top = r["spots"][0]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d", top["timeline"][0]["time"])
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d", r["verdict"]["dark"]["start"])
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d", top["best_window"]["end"])


def test_fall_back_hours_get_distinct_forecasts(store):
    from datetime import datetime, timezone

    from darksky_api.forecast import HourWeather

    edt_one = int(datetime(2026, 11, 1, 5, tzinfo=timezone.utc).timestamp())  # 01:00 EDT
    est_one = edt_one + 3600  # 01:00 EST

    class DstForecast:
        def get(self, cells, tz):
            hours = {t: HourWeather(50.0, 0.0, 24000.0) for t in range(edt_one - 12 * 3600, edt_one + 12 * 3600, 3600)}
            hours[edt_one] = HourWeather(0.0, 0.0, 24000.0)
            hours[est_one] = HourWeather(100.0, 0.0, 24000.0)
            return {c: hours for c in cells}

    q = SpotsQuery(lat=CITY[1], lon=CITY[0], night=date(2026, 10, 31))
    r = find_spots(store, FakeRouting(MINUTES), DstForecast(), q, today=lambda _tz: date(2026, 10, 31))
    ones = [h for h in r["spots"][0]["timeline"] if h["time"][11:13] == "01"]
    assert [h["time"][-6:] for h in ones] == ["-04:00", "-05:00"]
    assert [h["cloud"] for h in ones] == [0.0, 100.0]


def _at(y, mo, d, h, mi=0):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return lambda tz: datetime(y, mo, d, h, mi, tzinfo=ZoneInfo(tz))


def _run_now(store, now, **kw):
    q = SpotsQuery(lat=CITY[1], lon=CITY[0], **kw)
    return find_spots(store, FakeRouting(MINUTES), FakeForecast(), q, now=now)


def test_after_midnight_default_night_is_previous_date(store):
    now = _at(2026, 10, 17, 1)
    r = _run_now(store, now)
    assert r["night"] == "2026-10-16"
    assert _run_now(store, now, night=date(2026, 10, 16))["night"] == "2026-10-16"
    assert _run_now(store, now, night=date(2026, 10, 22))["night"] == "2026-10-22"
    with pytest.raises(QueryError) as e:
        _run_now(store, now, night=date(2026, 10, 23))
    assert e.value.detail == {"min": "2026-10-16", "max": "2026-10-22"}
    tl = r["spots"][0]["timeline"]
    assert [h["past"] for h in tl if h["time"] < "2026-10-17T01"] == [True] * 4  # 21:00..00:00 ended
    assert not any(h["past"] for h in tl if h["time"] >= "2026-10-17T01")


def test_after_dawn_default_night_is_today(store):
    r = _run_now(store, _at(2026, 10, 17, 9))
    assert r["night"] == "2026-10-17"
    with pytest.raises(QueryError):
        _run_now(store, _at(2026, 10, 17, 9), night=date(2026, 10, 16))


def test_late_evening_past_slots_excluded(store):
    r = _run_now(store, _at(2026, 10, 16, 23, 30))
    top = r["spots"][0]
    past = [h["time"][11:16] for h in top["timeline"] if h["past"]]
    assert past == ["21:00", "22:00"]
    assert top["best_window"]["start"] >= "2026-10-16T23:00"
    assert r["verdict"]["best_window"]["start"] >= "2026-10-16T23:00"
    assert "11:00 PM" in r["verdict"]["sentence"]


def test_future_night_has_no_past_slots(store):
    r = _run_now(store, _at(2026, 10, 16, 23, 30), night=date(2026, 10, 18))
    assert not any(h["past"] for h in r["spots"][0]["timeline"])
    assert all("past" in h for h in r["spots"][0]["timeline"])
    assert not any(h["past"] for h in run(store)["spots"][0]["timeline"])


# --- cross-border flag ---------------------------------------------------------------

@pytest.fixture()
def border_store(tmp_path):
    from darksky_api.data import DataStore
    from fixtures import CA_SPOT

    build_data_dir(tmp_path, spots=SPOTS + [CA_SPOT])
    return DataStore.load(tmp_path, {"test": TEST_METRO})


BORDER_MINUTES = {**MINUTES, "sp_ca": 25.0}


def test_crosses_border_flag(border_store):
    r = run(border_store, routing=FakeRouting(BORDER_MINUTES))
    flags = {s["id"]: s["crosses_border"] for s in r["spots"]}
    assert flags["sp_ca"] is True
    assert flags["sp_hudson"] is False and flags["sp_closed"] is False


def test_crosses_border_false_when_country_unknown(store):
    r = run(store)
    assert all(s["crosses_border"] is False for s in r["spots"])
    metro = store.metros["test"]
    saved = [s["country"] for s in metro.spots]
    try:
        for s in metro.spots:
            s["country"] = None
        assert all(s["crosses_border"] is False for s in run(store)["spots"])
    finally:
        for s, c in zip(metro.spots, saved):
            s["country"] = c


def test_border_exclude_removes_and_skips_routing(border_store):
    routing = FakeRouting(BORDER_MINUTES)
    r = run(border_store, routing=routing, border="exclude")
    assert "sp_ca" not in {s["id"] for s in r["spots"]}
    assert "sp_ca" not in routing.calls[0][1]
    routing2 = FakeRouting(BORDER_MINUTES)
    assert "sp_ca" in {s["id"] for s in run(border_store, routing=routing2)["spots"]}
    assert "sp_ca" in routing2.calls[0][1]


def test_border_exclude_also_drops_unavailable_cross_border(tmp_path):
    from darksky_api.data import DataStore
    from fixtures import make_spot

    ca_closed = make_spot("sp_ca_closed", "Closed CA", -84.1, 41.96, 21.5, unavailable=True, country="CA")
    build_data_dir(tmp_path, spots=SPOTS + [ca_closed])
    st = DataStore.load(tmp_path, {"test": TEST_METRO})
    m = {**MINUTES, "sp_ca_closed": 20.0}
    assert "sp_ca_closed" in {s["id"] for s in run(st, routing=FakeRouting(m))["spots"]}
    assert "sp_ca_closed" not in {s["id"] for s in run(st, routing=FakeRouting(m), border="exclude")["spots"]}


# --- cross-state flag ----------------------------------------------------------------

@pytest.fixture()
def state_store(tmp_path):
    from darksky_api.data import DataStore
    from fixtures import CA_SPOT, OH_SPOT

    build_data_dir(tmp_path, spots=SPOTS + [CA_SPOT, OH_SPOT])
    return DataStore.load(tmp_path, {"test": TEST_METRO})


STATE_MINUTES = {**MINUTES, "sp_ca": 25.0, "sp_oh": 22.0}


def test_crosses_state_rules(state_store):
    from darksky_api.service import _crosses_state

    metro = state_store.metros["test"]
    assert _crosses_state({"region": "US-OH", "country": "US"}, metro) is True
    assert _crosses_state({"region": "CA-ON", "country": "CA"}, metro) is False  # that is a country border
    assert _crosses_state({"region": "US-MI", "country": "US"}, metro) is False


def test_region_none_never_crosses(state_store):
    from darksky_api.service import _crosses_state

    metro = state_store.metros["test"]
    assert _crosses_state({"region": None, "country": "US"}, metro) is False
    assert _crosses_state({"country": "US"}, metro) is False


def test_crosses_state_flag_in_results(state_store):
    r = run(state_store, routing=FakeRouting(STATE_MINUTES))
    flags = {s["id"]: s["crosses_state"] for s in r["spots"]}
    assert flags["sp_oh"] is True
    assert flags["sp_ca"] is False and flags["sp_hudson"] is False and flags["sp_closed"] is False


def test_state_border_exclude_filters(state_store):
    routing = FakeRouting(STATE_MINUTES)
    r = run(state_store, routing=routing, state_border="exclude")
    ids = {s["id"] for s in r["spots"]}
    assert "sp_oh" not in ids and "sp_ca" in ids and "sp_hudson" in ids
    assert "sp_oh" not in routing.calls[0][1]
    assert "sp_oh" in {s["id"] for s in run(state_store, routing=FakeRouting(STATE_MINUTES))["spots"]}


ENTRY = {"lon": -84.251, "lat": 41.831}


def _entry_store(tmp_path):
    from darksky_api.data import DataStore

    spots = [dict(x) for x in SPOTS]
    spots[0]["entry"] = ENTRY
    return DataStore.load(build_data_dir(tmp_path, spots=spots), {"test": TEST_METRO})


def test_routes_to_entry_when_present(tmp_path):
    routing = FakeRouting(MINUTES)
    run(_entry_store(tmp_path), routing=routing)
    dests = {i: (lon, lat) for i, lon, lat in routing.dests[0]}
    assert dests["sp_hudson"] == (ENTRY["lon"], ENTRY["lat"])


def test_routes_to_spot_point_without_entry(tmp_path):
    routing = FakeRouting(MINUTES)
    run(_entry_store(tmp_path), routing=routing)
    dests = {i: (lon, lat) for i, lon, lat in routing.dests[0]}
    assert dests["sp_camp"] == (-84.15, 41.78)


def test_response_includes_entry(tmp_path):
    r = run(_entry_store(tmp_path))
    by_id = {s["id"]: s for s in r["spots"]}
    assert by_id["sp_hudson"]["entry"] == ENTRY and by_id["sp_camp"]["entry"] is None

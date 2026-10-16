import math
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from astral import Observer
from astral.sun import dusk

import darksky_api.sky as sky
from darksky_api.sky import DarkWindow, dark_window, hourly_slots, moon_illumination, moon_info, moon_up

DET = (42.3314, -83.0458)
TZ = "America/Detroit"


def test_detroit_october_window():
    w = dark_window(*DET, date(2026, 10, 16), TZ)
    assert w.kind == "astronomical"
    assert w.start.tzinfo is not None
    assert datetime(2026, 10, 16, 20, 10, tzinfo=ZoneInfo(TZ)) <= w.start <= datetime(2026, 10, 16, 20, 35, tzinfo=ZoneInfo(TZ))
    assert datetime(2026, 10, 17, 6, 0, tzinfo=ZoneInfo(TZ)) <= w.end <= datetime(2026, 10, 17, 6, 25, tzinfo=ZoneInfo(TZ))


def test_slots_are_full_hours_inside_window():
    w = dark_window(*DET, date(2026, 10, 16), TZ)
    slots = hourly_slots(w)
    assert slots[0].hour == 21 and slots[0].minute == 0
    assert all(w.start <= s < w.end for s in slots)
    assert all(b - a == timedelta(hours=1) for a, b in zip(slots, slots[1:]))


def test_slots_never_empty():
    tz = ZoneInfo(TZ)
    tiny = DarkWindow(datetime(2026, 6, 21, 23, 27, tzinfo=tz), datetime(2026, 6, 21, 23, 50, tzinfo=tz), "nautical")
    assert hourly_slots(tiny) == [datetime(2026, 6, 21, 23, 0, tzinfo=tz)]


def test_june_window_is_short_but_astronomical():
    w = dark_window(*DET, date(2026, 6, 21), TZ)
    assert w.kind == "astronomical"
    assert timedelta(hours=3) < w.end - w.start < timedelta(hours=5)


def test_far_north_summer_uses_synthetic_window():
    # Real astral raises here (sun never reaches -12 deg), so the synthetic 23:00-01:00 window is used.
    tz = ZoneInfo("Europe/London")
    w = dark_window(58.5, -3.0, date(2026, 6, 21), "Europe/London")
    assert w.kind == "nautical"
    assert w.start == datetime(2026, 6, 21, 23, tzinfo=tz)
    assert w.end == datetime(2026, 6, 22, 1, tzinfo=tz)


def test_astral_nautical_result_is_used_when_available():
    # At 52 N in June the sun reaches -12 deg, so astral's own nautical dusk is returned.
    tz = ZoneInfo("Europe/London")
    obs = Observer(latitude=52.0, longitude=0.0)
    w = dark_window(52.0, 0.0, date(2026, 6, 21), "Europe/London")
    assert w.kind == "nautical"
    assert w.start == dusk(obs, date(2026, 6, 21), tzinfo=tz, depression=12)
    assert w.start != datetime(2026, 6, 21, 23, tzinfo=tz)


def test_synthetic_fallback_when_sun_never_dark(monkeypatch):
    def always_raise(*args, **kwargs):
        raise ValueError("sun never reaches depression")

    monkeypatch.setattr(sky, "dusk", always_raise)
    tz = ZoneInfo(TZ)
    w = dark_window(*DET, date(2026, 10, 16), TZ)
    assert w.kind == "nautical"
    assert w.start == datetime(2026, 10, 16, 23, tzinfo=tz)
    assert w.end == datetime(2026, 10, 17, 1, tzinfo=tz)


def test_fall_back_night_slots_are_hourly_in_absolute_time():
    w = dark_window(*DET, date(2026, 10, 31), TZ)
    slots = hourly_slots(w)
    stamps = [s.timestamp() for s in slots]
    assert all(b - a == 3600 for a, b in zip(stamps, stamps[1:]))
    first = math.ceil(w.start.timestamp() / 3600) * 3600
    expected = math.ceil((w.end.timestamp() - first) / 3600)
    assert len(slots) == expected
    repeated = [s for s in slots if s.hour == 1]
    assert len(repeated) == 2
    assert repeated[0].utcoffset() != repeated[1].utcoffset()


def test_spring_forward_night_has_no_nonexistent_hour():
    w = dark_window(*DET, date(2027, 3, 13), TZ)
    slots = hourly_slots(w)
    assert all(s.hour != 2 for s in slots)
    stamps = [s.timestamp() for s in slots]
    assert all(b - a == 3600 for a, b in zip(stamps, stamps[1:]))


def test_moon_illumination_phases():
    # astral's phase is for 00:00 UTC of the given date; night + 1 day ~ US evening
    assert moon_illumination(date(2026, 10, 26)) > 0.95
    assert moon_illumination(date(2026, 11, 9)) < 0.05
    assert 0.3 < moon_illumination(date(2026, 10, 16)) < 0.45


def test_moon_info_and_up():
    w = dark_window(*DET, date(2026, 10, 16), TZ)
    m = moon_info(*DET, date(2026, 10, 16), TZ, w)
    assert m.rise is None
    assert m.set is not None and 22 <= m.set.hour <= 22
    tz = ZoneInfo(TZ)
    assert moon_up(*DET, datetime(2026, 10, 16, 21, 0, tzinfo=tz)) is True
    assert moon_up(*DET, datetime(2026, 10, 17, 1, 0, tzinfo=tz)) is False

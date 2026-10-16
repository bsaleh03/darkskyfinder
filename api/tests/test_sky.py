from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

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


def test_far_north_summer_falls_back_to_nautical():
    w = dark_window(58.5, -3.0, date(2026, 6, 21), "Europe/London")
    assert w.kind == "nautical" and w.end > w.start


def test_moon_illumination_phases():
    assert moon_illumination(date(2026, 10, 26)) > 0.97
    assert moon_illumination(date(2026, 11, 9)) < 0.03
    assert 0.2 < moon_illumination(date(2026, 10, 16)) < 0.35


def test_moon_info_and_up():
    w = dark_window(*DET, date(2026, 10, 16), TZ)
    m = moon_info(*DET, date(2026, 10, 16), TZ, w)
    assert m.rise is None
    assert m.set is not None and 22 <= m.set.hour <= 22
    tz = ZoneInfo(TZ)
    assert moon_up(*DET, datetime(2026, 10, 16, 21, 0, tzinfo=tz)) is True
    assert moon_up(*DET, datetime(2026, 10, 17, 1, 0, tzinfo=tz)) is False

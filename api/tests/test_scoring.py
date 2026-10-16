from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from darksky_api.scoring import (Slot, best_window, conditions_score, darker_than_home, format_time, hour_quality,
                                 relevant_score, site_score, verdict)
from fixtures import make_spot

TZ = ZoneInfo("America/Detroit")
T0 = datetime(2026, 10, 16, 21, tzinfo=TZ)


def slots(qualities):
    return [Slot(T0 + timedelta(hours=i), q, None, False, False) for i, q in enumerate(qualities)]


@pytest.mark.parametrize("args,expected", [
    ((0, 0, 24000, False, 0.0), (1.0, False)),
    ((50, 0, 24000, False, 0.0), (0.5, False)),
    ((0, 80, 24000, False, 0.0), (0.3, True)),
    ((0, 0, 1500, False, 0.0), (0.3, True)),
    ((0, 0, None, True, 1.0), (pytest.approx(0.2), False)),
    ((None, None, None, True, 0.5), (pytest.approx(0.6), False)),
])
def test_hour_quality(args, expected):
    assert hour_quality(*args) == expected


def test_best_window_longest_then_earliest():
    assert best_window(slots([0.7, 0.2, 0.8, 0.9, 0.1, 0.9, 0.9])) == (2, 4)
    assert best_window(slots([0.1, 0.2])) is None
    assert best_window([]) is None


def test_conditions_score():
    s = slots([0.9, 0.9, 0.1])
    assert conditions_score(s, (0, 2)) == pytest.approx(90.0)
    assert conditions_score(slots([0.8, 0.1]), (0, 1)) == pytest.approx(40.0)
    assert conditions_score(slots([0.5, 0.3]), None) == pytest.approx(25.0)
    assert conditions_score([], None) == 0.0


def test_site_score():
    assert site_score(make_spot("a", "A", 0, 0, 22.0, horizon="open", penalty=0.0)) == 100.0
    assert site_score(make_spot("b", "B", 0, 0, 20.0, horizon="enclosed", penalty=0.5)) == pytest.approx(35.0)
    assert site_score(make_spot("c", "C", 0, 0, 17.0, horizon="partial", penalty=1.0)) == 0.0


def test_relevant_score():
    assert relevant_score(80.0, 45.0, 90, "verified") == pytest.approx(72.5)
    assert relevant_score(80.0, 0.0, 90, "check_hours") == pytest.approx(80.0)


@pytest.mark.parametrize("spot,home,text", [
    (18.3, 18.0, "about the same"),
    (20.0, 18.0, "~6× darker"),
    (21.9, 18.25, "~30× darker"),
    (19.0, 18.0, "~3× darker"),
])
def test_darker_than_home(spot, home, text):
    assert darker_than_home(spot, home) == text


def test_darker_than_home_nan_home():
    assert darker_than_home(21.0, float("nan")) == "about the same"


def test_format_time():
    assert format_time(datetime(2026, 10, 16, 21, 30, tzinfo=TZ)) == "9:30 PM"
    assert format_time(datetime(2026, 10, 17, 0, 5, tzinfo=TZ)) == "12:05 AM"


def test_verdicts():
    w = (datetime(2026, 10, 16, 21, 30, tzinfo=TZ), datetime(2026, 10, 17, 0, 30, tzinfo=TZ))
    s = datetime(2026, 10, 16, 22, 40, tzinfo=TZ)
    good = verdict([80, 70, 65], w, 0.3, None, s, 10.0)
    assert good["rating"] == "good"
    assert good["sentence"] == "Good night to go — clear 9:30 PM–12:30 AM, moon sets 10:40 PM."
    assert verdict([50, 40, 30], w, 0.05, None, None, 30.0)["rating"] == "marginal"
    assert verdict([50, 40, 30], w, 0.05, None, None, 30.0)["sentence"] == "Possible — best 9:30 PM–12:30 AM, no moon."
    cloudy = verdict([10, 5, 0], None, 0.1, None, None, 90.0)
    assert cloudy == {"rating": "poor", "sentence": "Not great — clouds most of the night."}
    bright = verdict([20, 20, 20], None, 0.98, None, None, 5.0)
    assert bright["sentence"] == "Bright moon — bright stars and planets only."
    assert verdict([], None, 0.3, None, None, None) == {"rating": "unknown", "sentence": "No spots within reach."}

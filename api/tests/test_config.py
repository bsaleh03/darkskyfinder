from pathlib import Path

from darksky_api import config
from darksky_api.config import load_settings


def test_metros():
    assert set(config.METROS) == {"se_mi", "bay_area"}
    se = config.METROS["se_mi"]
    assert se.bbox == (-84.6, 41.65, -82.4, 44.1) and se.timezone == "America/Detroit"
    assert config.METROS["bay_area"].timezone == "America/Los_Angeles"
    for m in config.METROS.values():
        w, s, e, n = m.bbox
        assert w < m.center[0] < e and s < m.center[1] < n


def test_scoring_constants_match_spec():
    assert config.GOOD_HOUR_QUALITY == 0.6
    assert config.FOG_LOW_CLOUD_PCT == 70 and config.FOG_VISIBILITY_M == 2000 and config.FOG_CLEAR_FACTOR == 0.3
    assert config.MOON_MAX_PENALTY == 0.8
    assert config.HORIZON_BONUS == {"open": 5, "partial": 0, "enclosed": -5}
    assert config.BADGE_BONUS == {"verified": 5, "likely": 2, "check_hours": 0}
    assert config.DRIVE_PENALTY == 25 and config.GLARE_SITE_WEIGHT == 20
    assert (config.VERDICT_GOOD, config.VERDICT_MARGINAL, config.VERDICT_TOP_N) == (60, 35, 3)
    assert config.ORS_DAILY_BUDGET == 450 and config.RATE_LIMIT_PER_MIN == 20


def test_load_settings_defaults():
    s = load_settings({})
    assert s.ors_api_key is None
    assert s.allowed_origins == (config.DEV_ORIGIN,)
    assert s.data_dir == Path("data")


def test_load_settings_values():
    s = load_settings({"ORS_API_KEY": " k ", "ALLOWED_ORIGINS": "https://a.app, https://b.app ,",
                       "DATA_DIR": "/srv/data"})
    assert s.ors_api_key == "k"
    assert s.allowed_origins == ("https://a.app", "https://b.app", config.DEV_ORIGIN)
    assert s.data_dir == Path("/srv/data")


def test_blank_key_is_none():
    assert load_settings({"ORS_API_KEY": "  "}).ors_api_key is None

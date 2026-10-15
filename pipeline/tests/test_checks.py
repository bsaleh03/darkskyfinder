import pytest

from darksky_pipeline.checks import PipelineCheckError, assert_checks, run_checks
from darksky_pipeline.config import Metro
from overture_fixture import CITY, REGION_BBOX, TEST_EPSG

METRO = Metro("test", "Test", REGION_BBOX, TEST_EPSG, CITY, "Testville")


def spot(i, lon=-84.25, lat=41.83, sqm=21.6, badge="check_hours"):
    return {"id": i, "lon": lon, "lat": lat, "sqm": sqm, "access": {"badge": badge}}


def by_name(results):
    return {r.name: r for r in results}


def test_good_document_passes(darkness_grid, projector):
    doc = {"spots": [spot("a", badge="verified"), spot("b"), spot("c", sqm=17.0)]}
    results = run_checks(doc, darkness_grid, METRO, projector, (1, 10))
    assert all(r.ok for r in results), [r for r in results if not r.ok]
    assert_checks(results)


def test_failures_are_reported(darkness_grid, projector):
    doc = {"spots": [spot("a", lon=-90.0), spot("a", sqm=float("nan")), spot("b", sqm=17.0, badge="verified")]}
    r = by_name(run_checks(doc, darkness_grid, METRO, projector, (5, 10)))
    assert not r["spot_count"].ok
    assert not r["within_region"].ok
    assert not r["unique_ids"].ok
    assert not r["finite_sqm"].ok
    assert not r["verified_darker_than_home"].ok
    with pytest.raises(PipelineCheckError, match="spot_count"):
        assert_checks(list(r.values()))


def test_bright_top_spots_fail(darkness_grid, projector):
    doc = {"spots": [spot(str(i), sqm=18.0) for i in range(12)]}
    assert not by_name(run_checks(doc, darkness_grid, METRO, projector, (1, 100)))["top_spots_dark"].ok


def test_no_verified_spots_is_ok(darkness_grid, projector):
    doc = {"spots": [spot("a")]}
    assert by_name(run_checks(doc, darkness_grid, METRO, projector, (1, 10)))["verified_darker_than_home"].ok

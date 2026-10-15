import json
import math

import pytest

from darksky_pipeline.build import run_build
from darksky_pipeline.config import Metro
from darksky_pipeline.search_index import query
from overture_fixture import CITY, REGION_BBOX, RELEASE, TEST_EPSG

METRO = Metro("test", "Test", REGION_BBOX, TEST_EPSG, CITY, "Testville")


@pytest.fixture(scope="module")
def built(overture_root, viirs_path, tmp_path_factory):
    out = tmp_path_factory.mktemp("out")
    curated = out / "curated.yaml"
    curated.write_text(
        "spots:\n"
        "  - id: pl_hudson\n    verified: true\n    dark_sky_place: true\n    access_note: Open 24h\n"
        "  - id: pl_ghost\n    verified: true\n",
        encoding="utf-8")
    summary = run_build(METRO, RELEASE, viirs_path, out, curated_path=curated,
                        source_root=overture_root.as_posix(), count_range=(1, 10), skip_tiles=True)
    doc = json.loads((out / "spots_test.json").read_text(encoding="utf-8"))
    return summary, {s["id"]: s for s in doc["spots"]}, out


def test_outputs_exist(built):
    _, _, out = built
    for name in ("spots_test.json", "darkness_test.npz", "search_test.sqlite", "lightpollution_test.tif"):
        assert (out / name).exists(), name


def test_summary(built):
    summary, spots, _ = built
    assert summary.spots == 3
    # I2(e): the boat launch is now its own candidate; it has no drivable road within reach.
    assert summary.dropped_no_access == ["lu_woods", "pl_hudson_launch"]
    assert summary.curated_unknown_ids == ["pl_ghost"]
    assert all(c.ok for c in summary.checks)


def test_spot_set(built):
    _, spots, _ = built
    assert sorted(spots) == ["pl_camp", "pl_city", "pl_hudson"]


def test_hudson(built):
    _, spots, _ = built
    h = spots["pl_hudson"]
    # M6: Hudson Lot is inside the park -> parking true
    assert h["access"] == {"badge": "verified", "road_class": "tertiary", "paved": True, "parking": True,
                           "note": "Open 24h"}
    assert h["dark_sky_place"] is True
    assert h["horizon"]["class"] == "open"
    assert h["why"] == ["Open lake horizon", "Low glare", "Paved access", "Dark Sky Place"]
    assert h["sky_label"] in ("Milky Way vivid", "Milky Way visible")
    assert h["amenities"]["fuel"]["name"] == "Hudson Fuel"


def test_camp_and_city(built):
    _, spots, _ = built
    camp, city = spots["pl_camp"], spots["pl_city"]
    assert camp["access"]["badge"] == "likely" and camp["access"]["paved"] is False
    assert camp["access"]["parking"] is False
    assert camp["horizon"]["class"] == "enclosed"
    assert city["access"]["badge"] == "check_hours"
    assert city["glare"]["penalty"] >= 0.5
    assert spots["pl_hudson"]["sqm"] - city["sqm"] > 2.0


def test_radiance_present_and_finite(built):
    _, spots, _ = built
    for sp in spots.values():
        assert isinstance(sp["radiance"], float) and math.isfinite(sp["radiance"]) and sp["radiance"] >= 0
    assert spots["pl_city"]["radiance"] > spots["pl_hudson"]["radiance"]


def test_search_index_built(built):
    _, _, out = built
    assert query(out / "search_test.sqlite", "main st")[0]["kind"] == "address"


# --- I9: tile tooling checked up front; checks run before tiles ------------------

def _run(overture_root, viirs_path, out, **kw):
    return run_build(METRO, RELEASE, viirs_path, out, source_root=overture_root.as_posix(),
                     count_range=kw.pop("count_range", (1, 10)), **kw)


def test_missing_tile_tools_fail_before_any_work(overture_root, viirs_path, tmp_path, monkeypatch):
    from darksky_pipeline import build
    monkeypatch.setattr(build.shutil, "which", lambda name: None if name == "rio" else f"/bin/{name}")
    with pytest.raises(RuntimeError, match="rio"):
        _run(overture_root, viirs_path, tmp_path / "out", skip_tiles=False)
    assert not (tmp_path / "out" / "darkness_test.npz").exists()
    assert not (tmp_path / "out" / "spots_test.json").exists()


def test_checks_run_before_tiles(overture_root, viirs_path, tmp_path, monkeypatch):
    from darksky_pipeline import build
    order = []
    real_checks = build.run_checks
    monkeypatch.setattr(build.shutil, "which", lambda name: f"/bin/{name}")
    monkeypatch.setattr(build, "run_checks", lambda *a, **k: order.append("checks") or real_checks(*a, **k))
    monkeypatch.setattr(build, "run_commands", lambda cmds: order.append("tiles"))
    _run(overture_root, viirs_path, tmp_path / "out", skip_tiles=False)
    assert order == ["checks", "tiles"]


def test_failed_strict_checks_skip_tiles(overture_root, viirs_path, tmp_path, monkeypatch):
    from darksky_pipeline import build
    from darksky_pipeline.checks import PipelineCheckError
    ran = []
    monkeypatch.setattr(build.shutil, "which", lambda name: f"/bin/{name}")
    monkeypatch.setattr(build, "run_commands", lambda cmds: ran.append(cmds))
    with pytest.raises(PipelineCheckError, match="spot_count"):
        _run(overture_root, viirs_path, tmp_path / "out", skip_tiles=False, count_range=(100, 200))
    assert ran == []


# --- M5: curated path handling in main -------------------------------------------

@pytest.fixture
def fake_run_build(monkeypatch):
    from darksky_pipeline import build
    calls = []

    def fake(metro, release, viirs, out, **kw):
        calls.append(kw)
        return build.BuildSummary(metro=metro.key, spots=0, out_dir=out)

    monkeypatch.setattr(build, "run_build", fake)
    return calls


ARGS = ["--metro", "se_mi", "--release", "R", "--viirs", "v.tif", "--skip-tiles"]


def test_main_explicit_missing_curated_is_an_error(tmp_path, monkeypatch, fake_run_build):
    from darksky_pipeline.build import main
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit):
        main(ARGS + ["--curated", "nope.yaml"])
    assert fake_run_build == []


def test_main_default_missing_curated_warns(tmp_path, monkeypatch, fake_run_build, caplog):
    from darksky_pipeline.build import main
    monkeypatch.chdir(tmp_path)
    with caplog.at_level("WARNING"):
        main(ARGS)
    assert len(fake_run_build) == 1
    assert any("curated" in r.getMessage() and r.levelname == "WARNING" for r in caplog.records)


def test_main_explicit_existing_curated_is_used(tmp_path, monkeypatch, fake_run_build):
    from pathlib import Path

    from darksky_pipeline.build import main
    monkeypatch.chdir(tmp_path)
    Path("mine.yaml").write_text("spots: []\n", encoding="utf-8")
    main(ARGS + ["--curated", "mine.yaml"])
    assert fake_run_build[0]["curated_path"] == Path("mine.yaml")

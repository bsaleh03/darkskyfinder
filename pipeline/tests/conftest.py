from __future__ import annotations

import pytest

from overture_fixture import REGION_BBOX, RELEASE, build_overture_fixture


@pytest.fixture(scope="session")
def overture_root(tmp_path_factory):
    root = tmp_path_factory.mktemp("overture")
    build_overture_fixture(root)
    return root


@pytest.fixture(scope="session")
def overture_frames(overture_root):
    from darksky_pipeline.extract import THEMES, connect, extract_theme

    con = connect()
    frames = {k: extract_theme(con, k, REGION_BBOX, RELEASE, source_root=overture_root.as_posix())
              for k in THEMES}
    con.close()
    return frames


@pytest.fixture(scope="session")
def viirs_path(tmp_path_factory):
    from viirs_fixture import write_viirs_fixture

    return write_viirs_fixture(tmp_path_factory.mktemp("viirs") / "viirs.tif")


@pytest.fixture(scope="session")
def projector():
    from darksky_pipeline.geo import Projector
    from overture_fixture import TEST_EPSG

    return Projector(TEST_EPSG)


@pytest.fixture(scope="session")
def darkness_grid(viirs_path):
    from darksky_pipeline.darkness import build_darkness_grid
    from overture_fixture import TEST_EPSG

    return build_darkness_grid(viirs_path, REGION_BBOX, TEST_EPSG)


@pytest.fixture(scope="session")
def road_network(overture_frames, projector):
    from darksky_pipeline.roads import build_road_network

    return build_road_network(overture_frames["segments"], projector)


@pytest.fixture(scope="session")
def candidates(overture_frames, projector):
    from darksky_pipeline.spots import build_candidates

    return {c.id: c for c in build_candidates(overture_frames["places"], overture_frames["land_use"], projector)}

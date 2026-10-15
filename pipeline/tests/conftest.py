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

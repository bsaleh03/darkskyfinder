import json

import pytest

from darksky_api.sync_data import sync
from fixtures import build_data_dir


def test_sync_copies_three_files_per_metro(tmp_path):
    src = build_data_dir(tmp_path / "out")
    (src / "test" / "basemap_test_base.pmtiles").write_bytes(b"x")
    copied = sync(src, tmp_path / "data", ["test"])
    names = sorted(p.name for p, _ in copied)
    assert names == ["darkness_test.npz", "search_test.sqlite", "spots_test.json"]
    assert not (tmp_path / "data" / "test" / "basemap_test_base.pmtiles").exists()


def test_sync_rejects_old_schema(tmp_path):
    src = build_data_dir(tmp_path / "out", schema_version=2)
    with pytest.raises(SystemExit, match=r"schema_version 2 != 5"):
        sync(src, tmp_path / "data", ["test"])


def test_sync_rejects_huge_file(tmp_path, monkeypatch):
    import darksky_api.sync_data as sd

    src = build_data_dir(tmp_path / "out")
    monkeypatch.setattr(sd, "MAX_FILE_BYTES", 10)
    with pytest.raises(SystemExit, match="too large"):
        sync(src, tmp_path / "data", ["test"])

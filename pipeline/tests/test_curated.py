import pytest

from darksky_pipeline.curated import CuratedEntry, load_curated


def write(tmp_path, text):
    p = tmp_path / "c.yaml"
    p.write_text(text, encoding="utf-8")
    return p


def test_loads_entries_by_id(tmp_path):
    p = write(tmp_path, """
spots:
  - id: pl_hudson
    label: Lake Hudson
    verified: true
    dark_sky_place: true
    access_note: Open 24h
  - id: pl_city
    unavailable: true
    unavailable_reason: Closed for construction
""")
    data = load_curated(p)
    assert data["pl_hudson"] == CuratedEntry(id="pl_hudson", label="Lake Hudson", verified=True,
                                             dark_sky_place=True, access_note="Open 24h")
    assert data["pl_city"].unavailable and data["pl_city"].unavailable_reason == "Closed for construction"


def test_missing_file_is_empty(tmp_path):
    assert load_curated(tmp_path / "nope.yaml") == {}


def test_empty_list_is_empty(tmp_path):
    assert load_curated(write(tmp_path, "spots: []\n")) == {}


@pytest.mark.parametrize("text,msg", [
    ("spots:\n  - id: a\n  - id: a\n", "duplicate"),
    ("spots:\n  - label: x\n", "id"),
    ("spots:\n  - id: a\n    verifed: true\n", "unknown"),
])
def test_rejects_bad_files(tmp_path, text, msg):
    with pytest.raises(ValueError, match=msg):
        load_curated(write(tmp_path, text))

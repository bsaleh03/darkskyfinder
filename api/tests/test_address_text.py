from pathlib import Path

import pytest

from darksky_api import address_text
from darksky_api.address_text import TOKEN_MAP, display_street, normalize, tokens

PIPELINE_COPY = Path(__file__).resolve().parents[2] / "pipeline" / "darksky_pipeline" / "address_text.py"


@pytest.mark.skipif(not PIPELINE_COPY.exists(), reason="pipeline package not checked out")
def test_same_module_as_pipeline():
    """The pipeline normalizes the indexed street text with its copy; queries must normalize identically."""
    ours = Path(address_text.__file__).read_text(encoding="utf-8").replace("\r\n", "\n")
    assert PIPELINE_COPY.read_text(encoding="utf-8").replace("\r\n", "\n") == ours


def test_mapping():
    assert TOKEN_MAP["street"] == "st" and TOKEN_MAP["avenue"] == "ave" and TOKEN_MAP["trail"] == "trl"
    assert TOKEN_MAP["northeast"] == "ne" and TOKEN_MAP["west"] == "w"
    assert len(TOKEN_MAP) == 21


def test_normalize_query_forms():
    assert normalize("123 Main Street, Royal Oak") == "123 main st royal oak"
    assert tokens("South STATE Street") == ["s", "state", "st"]
    assert display_street("n main st") == "N Main St"

import json
import math

import pytest
import shapely

from darksky_pipeline.amenities import Amenity
from darksky_pipeline.assemble import (access_badge, assemble_spot, build_spots_document, why_chips,
                                       write_spots_json)
from darksky_pipeline.curated import CuratedEntry
from darksky_pipeline.features import Glare, Horizon
from darksky_pipeline.roads import ViewingPoint
from darksky_pipeline.spots import Candidate

CAND = Candidate("pl_x", "Lake X", "park", -84.25, 41.83, shapely.Point(0, 0).buffer(10), "place+polygon")
VP = ViewingPoint(0.0, 0.0, -84.2501234567, 41.8301234567, 21.6234, "tertiary", True, radiance=0.2345, parking=True)
GLARE = Glare(5, 12_000.0, 0.009)
HORIZON = Horizon("open", 0.95, 0.0, 0.45)
AMEN = {"restroom": None, "fuel": Amenity("Fuel", 3.4), "food": None}


def test_access_badge_priority():
    assert access_badge("park", CuratedEntry(id="a", verified=True)) == "verified"
    assert access_badge("campground", None) == "likely"
    assert access_badge("campground", CuratedEntry(id="a")) == "likely"
    assert access_badge("park", None) == "check_hours"


def test_why_chips():
    assert why_chips(HORIZON, GLARE, True, True) == ["Open lake horizon", "Low glare", "Paved access", "Dark Sky Place"]
    assert why_chips(Horizon("open", 0.9, 0.0, 0.0), Glare(500, None, 0.7), False, False) == ["Open horizon"]
    assert why_chips(Horizon("enclosed", 0.0, 1.0, 0.0), GLARE, False, False) == ["Low glare"]


def test_assemble_spot_schema_and_rounding():
    s = assemble_spot(CAND, VP, GLARE, HORIZON, AMEN, CuratedEntry(id="pl_x", verified=True, dark_sky_place=True,
                                                                     access_note="Open 24h"))
    assert s["id"] == "pl_x" and s["name"] == "Lake X" and s["category"] == "park"
    assert s["lon"] == -84.250123 and s["lat"] == 41.830123
    assert s["sqm"] == 21.62 and s["bortle"] == 4 and s["sky_label"] == "Milky Way vivid"
    assert s["radiance"] == 0.23  # I7
    assert s["glare"] == {"buildings_1km": 5, "highway_m": 12000.0, "penalty": 0.009}
    assert s["horizon"] == {"class": "open", "open_frac": 0.95, "closed_frac": 0.0, "water_frac": 0.45}
    # M6 adds access.parking
    assert s["access"] == {"badge": "verified", "road_class": "tertiary", "paved": True, "parking": True,
                           "note": "Open 24h"}
    assert s["dark_sky_place"] is True and s["unavailable"] is False and s["unavailable_reason"] is None
    assert s["amenities"] == {"restroom": None, "fuel": {"name": "Fuel", "km": 3.4}, "food": None}
    assert "Dark Sky Place" in s["why"]


def test_unavailable_curated_spot_is_kept_and_flagged():
    s = assemble_spot(CAND, VP, GLARE, HORIZON, AMEN,
                      CuratedEntry(id="pl_x", unavailable=True, unavailable_reason="Closed for repairs"))
    assert s["unavailable"] is True and s["unavailable_reason"] == "Closed for repairs"


def test_document_sorted_and_written(tmp_path):
    a = assemble_spot(CAND, VP, GLARE, HORIZON, AMEN, None)
    b = {**a, "id": "pl_a"}
    doc = build_spots_document("se_mi", "R1", [a, b], generated_at="2026-10-15T00:00:00Z")
    assert [s["id"] for s in doc["spots"]] == ["pl_a", "pl_x"]
    assert doc["schema_version"] == 4 and doc["metro"] == "se_mi" and doc["release"] == "R1"
    path = tmp_path / "spots.json"
    write_spots_json(doc, path)
    assert json.loads(path.read_text(encoding="utf-8")) == doc


def test_write_rejects_nan(tmp_path):
    doc = build_spots_document("se_mi", "R1", [{"id": "x", "sqm": math.nan}], generated_at="t")
    with pytest.raises(ValueError):
        write_spots_json(doc, tmp_path / "bad.json")


def test_write_is_atomic(tmp_path, monkeypatch):
    import os

    def boom(src, dst):
        raise OSError("disk full")

    path = tmp_path / "spots.json"
    path.write_text("old", encoding="utf-8")
    monkeypatch.setattr(os, "replace", boom)
    doc = build_spots_document("se_mi", "R1", [assemble_spot(CAND, VP, GLARE, HORIZON, AMEN, None)], generated_at="t")
    with pytest.raises(OSError):
        write_spots_json(doc, path)
    assert path.read_text(encoding="utf-8") == "old"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["spots.json"]


def test_recommended_and_sources_in_spot_and_chips():
    plain = assemble_spot(CAND, VP, GLARE, HORIZON, AMEN, None)
    assert plain["recommended"] is False and plain["sources"] == []
    src = [{"name": "Dark Sky Guide", "url": "https://example.com/g"}]
    s = assemble_spot(CAND, VP, GLARE, HORIZON, AMEN,
                      CuratedEntry(id="pl_x", dark_sky_place=True, recommended=True, sources=src))
    assert s["recommended"] is True and s["sources"] == src
    assert s["why"] == ["Open lake horizon", "Low glare", "Paved access", "Dark Sky Place", "Recommended"]
    assert "Recommended" not in assemble_spot(CAND, VP, GLARE, HORIZON, AMEN, CuratedEntry(id="pl_x"))["why"]

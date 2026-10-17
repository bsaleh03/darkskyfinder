from darksky_pipeline.dedupe import apply_display_names, merge_duplicates

LAT = 42.0
DEG_PER_KM = 1 / 111.32 / 0.7431  # lon degrees per km at 42N


def sp(id, name="Lake Park", km=0.0, sqm=20.0, badge="check_hours", dsp=False, unavail=False):
    return {"id": id, "name": name, "lon": -83.0 + km * DEG_PER_KM, "lat": LAT, "sqm": sqm,
            "access": {"badge": badge}, "dark_sky_place": dsp, "unavailable": unavail}


def ids(spots):
    return sorted(s["id"] for s in spots)


def test_close_same_name_merges_keeping_darkest():
    out, n = merge_duplicates([sp("a", km=0, sqm=20.0), sp("b", km=0.5, sqm=21.0)])
    assert ids(out) == ["b"] and n == 1


def test_name_normalized():
    out, n = merge_duplicates([sp("a", name="Lake Park!"), sp("b", name="lake  park", km=0.1, sqm=21)])
    assert ids(out) == ["b"] and n == 1


def test_far_same_name_kept():
    out, n = merge_duplicates([sp("a"), sp("b", km=5)])
    assert ids(out) == ["a", "b"] and n == 0


def test_different_names_kept():
    out, n = merge_duplicates([sp("a"), sp("b", name="Other", km=0.1)])
    assert ids(out) == ["a", "b"] and n == 0


def test_curated_beats_darker_uncurated():
    for kw in ({"badge": "verified"}, {"dsp": True}, {"unavail": True}):
        out, n = merge_duplicates([sp("a", sqm=19.0, **kw), sp("b", km=0.5, sqm=21.5)])
        assert ids(out) == ["a"] and n == 1


def test_tie_prefers_badge_then_id():
    out, _ = merge_duplicates([sp("a", badge="check_hours"), sp("b", km=0.1, badge="likely")])
    assert ids(out) == ["b"]
    out, _ = merge_duplicates([sp("z"), sp("c", km=0.1)])
    assert ids(out) == ["c"]


def test_transitive_chain():
    spots = [sp("a", km=0, sqm=19), sp("b", km=1.5, sqm=20), sp("c", km=3.0, sqm=21)]
    out, n = merge_duplicates(spots)
    assert ids(out) == ["c"] and n == 2


def test_display_name_collision_uses_area():
    spots = [{**sp("a"), "area": "Ann Arbor"}, {**sp("b", km=9), "area": "Ypsilanti"},
             {**sp("c", name="Unique"), "area": "Ann Arbor"}]
    apply_display_names(spots)
    d = {s["id"]: s["display_name"] for s in spots}
    assert d == {"a": "Lake Park \u00b7 Ann Arbor", "b": "Lake Park \u00b7 Ypsilanti", "c": "Unique"}


def test_display_name_collision_same_or_null_area_falls_back():
    spots = [{**sp("a"), "area": "X"}, {**sp("b", km=9), "area": "X"},
             {**sp("c", name="Foo"), "area": None}, {**sp("d", name="Foo", km=9), "area": "Y"}]
    apply_display_names(spots)
    d = {s["id"]: s["display_name"] for s in spots}
    assert d["a"] == d["b"] == "Lake Park"
    assert d["c"] == "Foo" and d["d"] == "Foo \u00b7 Y"


def test_recommended_beats_darker_uncurated():
    rec = {**sp("a", sqm=19.0), "recommended": True}
    out, n = merge_duplicates([rec, sp("b", km=0.5, sqm=21.5)])
    assert ids(out) == ["a"] and n == 1

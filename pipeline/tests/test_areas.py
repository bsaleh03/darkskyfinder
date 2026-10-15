import pandas as pd
import shapely

from darksky_pipeline.areas import AreaFinder


def sq(x0, y0, x1, y1):
    return shapely.box(x0, y0, x1, y1).wkb


def frame(*rows):
    return pd.DataFrame(rows, columns=["id", "name", "subtype", "country", "region", "wkb"])


def row(i, name, subtype, box):
    return (i, name, subtype, "US", "US-MI", sq(*box))


def test_locality():
    f = AreaFinder(frame(row("1", "Town", "locality", (0, 0, 1, 1))))
    assert f.area_for(0.5, 0.5) == "Town"


def test_county_only():
    f = AreaFinder(frame(row("1", "Wayne County", "county", (0, 0, 1, 1))))
    assert f.area_for(0.5, 0.5) == "Wayne County"


def test_none():
    f = AreaFinder(frame(row("1", "Town", "locality", (0, 0, 1, 1))))
    assert f.area_for(5, 5) is None
    assert AreaFinder(frame()).area_for(0, 0) is None


def test_preference_order():
    f = AreaFinder(frame(row("1", "County", "county", (0, 0, 10, 10)),
                         row("2", "Hood", "neighborhood", (0, 0, 5, 5)),
                         row("3", "Town", "localadmin", (0, 0, 8, 8))))
    assert f.area_for(1, 1) == "Town"
    assert f.area_for(9, 9) == "County"
    g = AreaFinder(frame(row("1", "County", "county", (0, 0, 10, 10)),
                         row("2", "Hood", "macrohood", (0, 0, 5, 5))))
    assert g.area_for(1, 1) == "Hood"


def test_smallest_within_rank_and_null_names_skipped():
    f = AreaFinder(frame(row("1", "Big", "locality", (0, 0, 10, 10)),
                         row("2", "Small", "locality", (0, 0, 2, 2)),
                         row("3", None, "locality", (0, 0, 1, 1))))
    assert f.area_for(0.5, 0.5) == "Small"

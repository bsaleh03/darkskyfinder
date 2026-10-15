import math

import numpy as np
import pandas as pd
import shapely

from darksky_pipeline import config
from darksky_pipeline.util import as_list, wkb_to_geoms


def test_metro_bboxes_are_valid_and_contain_home():
    for metro in config.METROS.values():
        w, s, e, n = metro.bbox
        assert w < e and s < n
        lon, lat = metro.reference_home
        assert w < lon < e and s < lat < n
        assert metro.utm_epsg in (32610, 32617)


def test_sky_label_thresholds_descend():
    thresholds = [t for t, _ in config.SKY_LABELS]
    assert thresholds == sorted(thresholds, reverse=True)
    assert thresholds[-1] == -math.inf
    labels = [label for _, label in config.SKY_LABELS]
    assert labels == ["Milky Way vivid", "Milky Way visible", "Milky Way faint", "Milky Way not visible"]


def test_bortle_thresholds_descend():
    thresholds = [t for t, _ in config.BORTLE_THRESHOLDS]
    assert thresholds == sorted(thresholds, reverse=True)


def test_as_list_handles_none_nan_arrays_and_lists():
    assert as_list(None) == []
    assert as_list(float("nan")) == []
    assert as_list([{"a": 1}]) == [{"a": 1}]
    assert as_list(np.array([{"a": 1}], dtype=object)) == [{"a": 1}]


def test_wkb_to_geoms_accepts_bytearray():
    wkb = shapely.to_wkb(shapely.Point(1, 2))
    geoms = wkb_to_geoms(pd.Series([bytearray(wkb), wkb]))
    assert [g.x for g in geoms] == [1.0, 1.0]

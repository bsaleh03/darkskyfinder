import math

import pytest

from darksky_api.data import DataError, DataStore
from darksky_api.grid import DarknessGrid
from fixtures import CITY, HUDSON, TEST_METRO, build_data_dir


def test_store_loads_metro(store):
    m = store.metros["test"]
    assert m.info is TEST_METRO
    assert len(m.spots) == 5 and m.release == "2099-01-01.0"
    assert store.release == "2099-01-01.0"
    assert m.search_path.name == "search_test.sqlite"


def test_grid_samples_city_and_dark(store):
    g = store.metros["test"].grid
    assert g.sample_lonlat(*CITY) == pytest.approx(18.0)
    assert g.sample_lonlat(*HUDSON) == pytest.approx(21.5)


def test_sample_outside_grid_is_nan(store):
    assert math.isnan(store.metros["test"].grid.sample_lonlat(-90.0, 30.0))


def test_metro_for(store):
    assert store.metro_for(*CITY).info.key == "test"
    assert store.metro_for(-100.0, 40.0) is None


def test_missing_metro_dir_fails_fast(tmp_path):
    with pytest.raises(DataError, match="test"):
        DataStore.load(tmp_path, {"test": TEST_METRO})


def test_wrong_schema_version_fails_fast(tmp_path):
    build_data_dir(tmp_path, schema_version=1)
    with pytest.raises(DataError, match="schema"):
        DataStore.load(tmp_path, {"test": TEST_METRO})


def test_grid_load_round_trip(data_dir):
    g = DarknessGrid.load(data_dir / "test" / "darkness_test.npz")
    assert g.epsg == 32617 and g.res == 500.0 and g.sqm.ndim == 2

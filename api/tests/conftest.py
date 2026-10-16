from __future__ import annotations

import pytest

from fixtures import TEST_METRO, build_data_dir


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory):
    return build_data_dir(tmp_path_factory.mktemp("data"))


@pytest.fixture(scope="session")
def store(data_dir):
    from darksky_api.data import DataStore

    return DataStore.load(data_dir, {"test": TEST_METRO})

import pytest

from darksky_pipeline.address_text import TOKEN_MAP, display_city, display_street, normalize


def test_token_map_is_the_agreed_mapping():
    assert TOKEN_MAP == {
        "street": "st", "avenue": "ave", "road": "rd", "drive": "dr", "boulevard": "blvd", "lane": "ln",
        "court": "ct", "place": "pl", "circle": "cir", "terrace": "ter", "parkway": "pkwy", "highway": "hwy",
        "trail": "trl", "av": "ave", "wy": "way",
        "north": "n", "south": "s", "east": "e", "west": "w",
        "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
    }


@pytest.mark.parametrize("raw, norm", [
    ("South STATE Street", "s state st"),
    ("Main St", "main st"),
    ("N. Woodward Avenue", "n woodward ave"),
    ("St. Mary's Lane", "st marys ln"),
    ("Dr Carlton B Goodlett Pl", "dr carlton b goodlett pl"),
    ("  12 Mile   ROAD ", "12 mile rd"),
    ("Old_Mill-Trail", "old mill trl"),
    ("Foothill AV", "foothill ave"),
    ("Skyline WY", "skyline way"),
    ("", ""),
])
def test_normalize(raw, norm):
    assert normalize(raw) == norm


def test_display_street_keeps_directions_upper():
    assert display_street("s state st") == "S State St"
    assert display_street("ne 12th ave") == "NE 12th Ave"
    assert display_street("dr carlton b goodlett pl") == "Dr Carlton B Goodlett Pl"


def test_display_city_title_case():
    assert display_city("ROYAL OAK") == "Royal Oak"
    assert display_city("St. Clair Shores") == "St. Clair Shores"
    assert display_city(None) == ""

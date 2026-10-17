"""Response models (documented in /docs; validate the service output shape)."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class Region(BaseModel):
    key: str
    name: str
    bbox: list[float]
    center: list[float]
    zoom: float
    timezone: str


class SearchHit(BaseModel):
    name: str
    kind: str
    lat: float
    lon: float
    metro: str


class Health(BaseModel):
    ok: bool
    metros: list[str]
    release: str


class Window(BaseModel):
    start: str
    end: str


class Moon(BaseModel):
    illumination: float
    rise: str | None
    set: str | None


class Dark(BaseModel):
    start: str
    end: str
    kind: str


class Verdict(BaseModel):
    rating: str
    sentence: str
    best_window: Window | None
    moon: Moon
    dark: Dark


class Start(BaseModel):
    lat: float
    lon: float
    sqm: float | None
    sky_label: str | None


class Scores(BaseModel):
    site: int
    conditions: int
    best_view: int
    relevant: int


class TimelineHour(BaseModel):
    time: str
    quality: float
    cloud: float | None
    fog: bool
    moon_up: bool
    past: bool


class Glare(BaseModel):
    buildings_1km: int
    highway_m: float | None
    penalty: float


class Horizon(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    class_: str = Field(alias="class")
    open_frac: float
    closed_frac: float
    water_frac: float


class Access(BaseModel):
    badge: str
    road_class: str | None
    paved: bool | None
    parking: bool | None
    note: str | None


class Amenity(BaseModel):
    name: str
    km: float


class Amenities(BaseModel):
    restroom: Amenity | None
    fuel: Amenity | None
    food: Amenity | None


class Source(BaseModel):
    name: str
    url: str


class Spot(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    name: str
    display_name: str
    area: str | None
    country: str | None
    crosses_border: bool
    recommended: bool
    sources: list[Source]
    category: str
    lon: float
    lat: float
    sqm: float
    bortle: int
    sky_label: str
    radiance: float
    glare: Glare
    horizon: Horizon
    access: Access
    dark_sky_place: bool
    unavailable: bool
    unavailable_reason: str | None
    amenities: Amenities
    why: list[str]
    drive_minutes: int
    drive_is_estimate: bool
    darker_than_home: str
    scores: Scores | None
    timeline: list[TimelineHour]
    best_window: Window | None


class SpotsResponse(BaseModel):
    metro: str
    night: str
    timezone: str
    start: Start
    verdict: Verdict
    forecast_status: str
    drive_status: str
    spots: list[Spot]

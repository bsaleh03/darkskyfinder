from datetime import date, datetime, timedelta, timezone

from darksky_api.forecast import HourWeather
from darksky_api.routing import estimate_minutes, haversine_km


class FakeRouting:
    def __init__(self, minutes=None, estimate=False):
        """estimate: True (all ids estimated), False, or a collection of estimated ids."""
        self.minutes = minutes
        self.estimate = estimate
        self.calls = []

    def drive_minutes(self, start, dests):
        self.calls.append((start, [d[0] for d in dests]))
        if self.minutes is None:
            out = {i: estimate_minutes(haversine_km(start[0], start[1], lon, lat)) for i, lon, lat in dests}
        else:
            out = {i: self.minutes[i] for i, _, _ in dests if i in self.minutes}
        if self.estimate is True:
            return out, set(out)
        return out, {i for i in out if i in (self.estimate or ())}


class FakeForecast:
    def __init__(self, cloud=10.0, low=0.0, vis=24000.0, fail=False, fail_cells=()):
        self.cloud, self.low, self.vis, self.fail, self.fail_cells = cloud, low, vis, fail, set(fail_cells)

    def get(self, cells, tz):
        if self.fail:
            return {}
        hours = {}
        t = datetime(2026, 10, 10, 0, 0, tzinfo=timezone.utc)
        while t < datetime(2026, 11, 10, 0, 0, tzinfo=timezone.utc):
            hours[int(t.timestamp())] = HourWeather(self.cloud, self.low, self.vis)
            t += timedelta(hours=1)
        return {c: hours for c in cells if c not in self.fail_cells}


def fixed_today(_tz):
    return date(2026, 10, 16)

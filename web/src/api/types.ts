// Mirrors api/darksky_api/schemas.py (schema v3).

export interface Region {
  key: string
  name: string
  bbox: number[]
  center: number[]
  zoom: number
  timezone: string
}

export interface SearchHit {
  name: string
  kind: string
  lat: number
  lon: number
  metro: string
  /** Overture's own index, or the openrouteservice geocoder fallback for street addresses. */
  source: 'overture' | 'openrouteservice'
}

export interface Health {
  ok: boolean
  metros: string[]
  release: string
}

export interface Window {
  start: string
  end: string
}

export type Rating = 'good' | 'marginal' | 'poor' | 'unknown'

export interface Verdict {
  rating: Rating
  sentence: string
  best_window: Window | null
  moon: { illumination: number; rise: string | null; set: string | null }
  dark: { start: string; end: string; kind: string }
}

export interface TimelineHour {
  time: string
  quality: number
  cloud: number | null
  fog: boolean
  moon_up: boolean
  past: boolean
}

export interface Amenity {
  name: string
  km: number
}

export interface Spot {
  id: string
  name: string
  display_name: string
  area: string | null
  country: string | null
  crosses_border: boolean
  crosses_state: boolean
  recommended: boolean
  sources: { name: string; url: string }[]
  category: string
  lon: number
  lat: number
  /** Road/parking point to navigate to; null when none was found (older responses omit it). */
  entry: { lon: number; lat: number } | null
  sqm: number
  bortle: number
  sky_label: string
  radiance: number
  glare: { buildings_1km: number; highway_m: number | null; penalty: number }
  horizon: { class: string; open_frac: number; closed_frac: number; water_frac: number }
  access: {
    badge: string
    road_class: string | null
    paved: boolean | null
    parking: boolean | null
    note: string | null
  }
  dark_sky_place: boolean
  unavailable: boolean
  unavailable_reason: string | null
  amenities: Record<'restroom' | 'fuel' | 'food', Amenity | null>
  why: string[]
  drive_minutes: number
  drive_is_estimate: boolean
  darker_than_home: string
  scores: { site: number; conditions: number; best_view: number; relevant: number } | null
  timeline: TimelineHour[]
  best_window: Window | null
}

export interface SpotsResponse {
  metro: string
  night: string
  timezone: string
  start: { lat: number; lon: number; sqm: number | null; sky_label: string | null }
  verdict: Verdict
  forecast_status: string
  drive_status: string
  spots: Spot[]
}

export type SortKey = 'relevant' | 'closest' | 'best_view'
export type AccessKey = 'all' | 'likely' | 'verified'
export type BorderKey = 'include' | 'exclude'
export type StateBorderKey = 'include' | 'exclude'

export interface SpotsParams {
  lat: number
  lon: number
  night?: string
  drive: number
  /** Omitted for night dots: the verdict does not depend on the sort order. */
  sort?: SortKey
  access: AccessKey
  border: BorderKey
  stateBorder: StateBorderKey
  limit: number
}

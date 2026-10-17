import type { Spot } from '../api/types'

const UNAVAILABLE = '#5A6280'
const BY_LABEL: Record<string, string> = {
  vivid: '#7FD6A0',
  visible: '#F0C070',
  faint: '#F0A070',
  'not visible': '#F0808A',
}

export function spotsToGeoJSON(spots: Spot[], selectedId: string | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: spots.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        id: s.id,
        color: s.unavailable ? UNAVAILABLE : (BY_LABEL[s.sky_label] ?? BY_LABEL['not visible']),
        selected: s.id === selectedId,
        darkSky: s.dark_sky_place,
        unavailable: s.unavailable,
      },
    })),
  }
}

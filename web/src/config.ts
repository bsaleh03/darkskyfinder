import type { Region } from './api/types'

export const config = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:8000',
  tilesUrl: (import.meta.env.VITE_TILES_URL as string | undefined) || '/tiles',
}

/**
 * Covered metros, mirrored from api/darksky_api/config.py METROS (in the API's /api/regions order),
 * so the map style, initial bounds and region chips never wait on a cold API. /api/regions may override.
 */
export const METROS: Region[] = [
  {
    key: 'bay_area',
    name: 'SF Bay Area',
    bbox: [-123.2, 36.4, -121.0, 38.6],
    center: [-122.27, 37.8],
    zoom: 8.5,
    timezone: 'America/Los_Angeles',
  },
  {
    key: 'se_mi',
    name: 'SE Michigan',
    bbox: [-84.6, 41.65, -82.4, 44.1],
    center: [-83.15, 42.48],
    zoom: 8.5,
    timezone: 'America/Detroit',
  },
]

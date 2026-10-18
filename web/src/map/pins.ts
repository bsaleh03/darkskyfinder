import type { Spot } from '../api/types'

const UNAVAILABLE = '#5A6280'
const BY_LABEL: Record<string, string> = {
  vivid: '#7FD6A0',
  visible: '#F0C070',
  faint: '#F0A070',
  'not visible': '#F0808A',
}

export const PIN_COLORS = [UNAVAILABLE, ...Object.values(BY_LABEL)]

/** Pin fill for a spot: grey when unavailable, else by sky label (the API's "Milky Way …" labels or the bare words). */
export function pinColor(spot: Spot): string {
  if (spot.unavailable) return UNAVAILABLE
  const key = (spot.sky_label ?? '').replace(/^Milky Way /i, '').toLowerCase()
  return BY_LABEL[key] ?? BY_LABEL['not visible']
}

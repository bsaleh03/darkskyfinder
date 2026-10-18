/**
 * Decide whether a render failed from the errors MapLibre reported (missing PMTiles, tile or GeoJSON fetch
 * failures, ...). Any error fails the render: MapLibre still reaches `idle` without the data, and the picture
 * would ship as water with no roads. Returns the failure message, or null when the render is clean.
 */
export function renderFailure(errors: string[]): string | null {
  if (errors.length === 0) return null
  const n = errors.length
  return `${n} map error${n === 1 ? '' : 's'} during render: ${errors.slice(0, 3).join(' | ')}`
}

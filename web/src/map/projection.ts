export type LonLat = { lon: number; lat: number }
export type Bounds = [number, number, number, number] // [west, south, east, north]

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

/** Fraction of the picture (x right, y down; (0,0) = west/north) for a lon/lat in Web Mercator. */
export function toFraction(p: LonLat, bounds: Bounds): { x: number; y: number } {
  const [w, s, e, n] = bounds
  const yTop = mercY(n)
  return {
    x: (p.lon - w) / (e - w),
    y: (yTop - mercY(p.lat)) / (yTop - mercY(s)),
  }
}

/** Inverse of toFraction's y: latitude at a vertical fraction. */
export function fractionToLat(y: number, bounds: Bounds): number {
  const yTop = mercY(bounds[3])
  const m = yTop - y * (yTop - mercY(bounds[1]))
  return ((2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180) / Math.PI
}

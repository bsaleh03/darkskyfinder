import { fractionToLat, type Bounds } from '../src/map/projection'

/** The fixed set of picture sizes: quarter, half and full width (ascending), heights from the region aspect. */
export function sizesFor(fullWidth: number, aspect: number): { w: number; h: number }[] {
  return [fullWidth / 4, fullWidth / 2, fullWidth].map((w) => ({ w, h: Math.round(w * aspect) }))
}

/**
 * Bounds [W, S, E, N] of tile (col, row) at `level`: the extent cut into 2^level x 2^level equal Web Mercator
 * pieces, column from the west, row from the north (the same grid the pipeline cuts the glow tiles on).
 */
export function tileBounds(bounds: Bounds, level: number, col: number, row: number): Bounds {
  const n = 2 ** level
  if (!Number.isInteger(level) || level < 0) throw new Error(`bad level ${level}`)
  for (const v of [col, row]) if (!Number.isInteger(v) || v < 0 || v >= n) throw new Error(`tile ${col},${row} is outside level ${level}`)
  const [w, , e] = bounds
  const lon = (f: number) => w + f * (e - w)
  return [lon(col / n), fractionToLat((row + 1) / n, bounds), lon((col + 1) / n), fractionToLat(row / n, bounds)]
}

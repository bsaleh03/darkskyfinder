import { describe, expect, it } from 'vitest'
import { sizesFor, tileBounds } from '../../render/sizes'
import { toFraction, type Bounds } from '../../src/map/projection'

describe('sizesFor', () => {
  it('returns quarter, half and full widths ascending with rounded heights', () => {
    expect(sizesFor(3500, 1.3)).toEqual([
      { w: 875, h: 1138 },
      { w: 1750, h: 2275 },
      { w: 3500, h: 4550 },
    ])
  })

  it('keeps the real region aspect (se_mi 3496x4576)', () => {
    const s = sizesFor(3496, 4576 / 3496)
    expect(s.map((x) => x.w)).toEqual([874, 1748, 3496])
    expect(s[2].h).toBe(4576)
    for (const { w, h } of s) expect(w * h).toBeLessThanOrEqual(16_000_000)
  })
})

describe('tileBounds', () => {
  const se_mi: Bounds = [-86.9, 41.65, -82.4, 45.9]
  const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-12)

  it('returns the whole extent at level 0', () => {
    tileBounds(se_mi, 0, 0, 0).forEach((v, i) => close(v, se_mi[i]))
  })

  it('cuts level l into 2^l x 2^l equal Mercator pieces (column from the west, row from the north)', () => {
    for (const level of [1, 2]) {
      const n = 2 ** level
      for (let col = 0; col < n; col++) {
        for (let row = 0; row < n; row++) {
          const [w, s, e, nn] = tileBounds(se_mi, level, col, row)
          const nw = toFraction({ lon: w, lat: nn }, se_mi)
          const se = toFraction({ lon: e, lat: s }, se_mi)
          close(nw.x, col / n)
          close(nw.y, row / n)
          close(se.x, (col + 1) / n)
          close(se.y, (row + 1) / n)
        }
      }
    }
  })

  it('is not a plain lat/lon split (the north row is shorter in latitude)', () => {
    const north = tileBounds(se_mi, 1, 0, 0)
    const south = tileBounds(se_mi, 1, 0, 1)
    expect(north[1]).toBe(south[3])
    expect(north[3] - north[1]).toBeLessThan(south[3] - south[1])
    expect(north[1]).not.toBeCloseTo((se_mi[1] + se_mi[3]) / 2, 6)
  })

  it('rejects a tile outside the grid', () => {
    expect(() => tileBounds(se_mi, 1, 2, 0)).toThrow()
    expect(() => tileBounds(se_mi, 1, 0, -1)).toThrow()
  })
})

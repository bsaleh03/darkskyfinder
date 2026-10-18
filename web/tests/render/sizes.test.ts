import { describe, expect, it } from 'vitest'
import { sizesFor } from '../../render/sizes'

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

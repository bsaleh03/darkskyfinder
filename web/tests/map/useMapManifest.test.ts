import { describe, expect, it } from 'vitest'
import { mapLevels, mapTileUrl, parseManifest } from '../../src/map/useMapManifest'

const V1 = {
  metro: 'se_mi',
  bounds: [-86.9, 41.65, -82.4, 45.9],
  aspect: 1.3089,
  widths: [874, 1748, 3496],
  files: { base: 'base_{w}.webp', base_red: 'base_red_{w}.webp', glow: 'glow_{w}.webp', glow_red: 'glow_red_{w}.webp' },
  labels: 'labels.json',
}
const V2 = {
  ...V1,
  levels: [
    { level: 0, cols: 1, rows: 1 },
    { level: 1, cols: 2, rows: 2 },
  ],
  tiles: {
    base: 'base_L{l}_{c}_{r}.webp',
    base_red: 'base_red_L{l}_{c}_{r}.webp',
  },
}

describe('parseManifest', () => {
  it('accepts a v2 manifest with its levels and tile templates', () => {
    const m = parseManifest(V2, 'se_mi')
    expect(mapLevels(m)).toEqual(V2.levels)
    expect(m.tiles).toEqual(V2.tiles)
  })

  it('needs only base and base_red tile templates above level 0; glow templates are optional and ignored', () => {
    const withGlow = { ...V2, tiles: { ...V2.tiles, glow: 'glow_L{l}_{c}_{r}.webp', glow_red: 'glow_red_L{l}_{c}_{r}.webp' } }
    expect(mapLevels(parseManifest(withGlow, 'se_mi'))).toEqual(V2.levels)
    expect(() => parseManifest({ ...V2, tiles: { base: V2.tiles.base } }, 'se_mi')).toThrow()
    expect(() => parseManifest({ ...V2, tiles: { ...V2.tiles, glow: 7 } }, 'se_mi')).not.toThrow()
  })

  it('old manifest works at level 0: a v1 manifest (no levels, no tiles) is level 0 only', () => {
    const m = parseManifest(V1, 'se_mi')
    expect(mapLevels(m)).toEqual([{ level: 0, cols: 1, rows: 1 }])
  })

  it('rejects broken levels or a level above 0 without tile templates', () => {
    expect(() => parseManifest({ ...V2, levels: [{ level: 1, cols: 0, rows: 2 }] }, 'se_mi')).toThrow()
    expect(() => parseManifest({ ...V2, levels: 'all' }, 'se_mi')).toThrow()
    expect(() => parseManifest({ ...V2, tiles: undefined }, 'se_mi')).toThrow()
    expect(() => parseManifest({ ...V2, tiles: { ...V2.tiles, base_red: 7 } }, 'se_mi')).toThrow()
    expect(() => parseManifest({ ...V2, metro: 'bay_area' }, 'se_mi')).toThrow()
  })
})

describe('mapTileUrl', () => {
  it('fills level, column and row into the variant template next to the manifest', () => {
    const m = parseManifest(V2, 'se_mi')
    expect(mapTileUrl(m, 'base_red', 1, 0, 1)).toMatch(/\/maps\/se_mi\/base_red_L1_0_1\.webp$/)
    expect(mapTileUrl(m, 'base', 1, 1, 0)).toMatch(/\/maps\/se_mi\/base_L1_1_0\.webp$/)
  })
})

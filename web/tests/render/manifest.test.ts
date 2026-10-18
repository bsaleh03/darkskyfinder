import { describe, expect, it } from 'vitest'
import { buildManifest, manifestFiles, tileFile } from '../../render/manifest'

const extent = { bounds: [-86.9, 41.65, -82.4, 45.9] as [number, number, number, number], width: 3496, height: 4576, levels: [0, 1] }

describe('buildManifest (v2)', () => {
  const m = buildManifest('se_mi', extent)

  it('keeps every v1 field the current app reads', () => {
    expect(m.metro).toBe('se_mi')
    expect(m.bounds).toEqual(extent.bounds)
    expect(m.aspect).toBe(4576 / 3496)
    expect(m.widths).toEqual([874, 1748, 3496])
    expect(m.files).toEqual({
      base: 'base_{w}.webp',
      base_red: 'base_red_{w}.webp',
      glow: 'glow_{w}.webp',
      glow_red: 'glow_red_{w}.webp',
    })
    expect(m.labels).toBe('labels.json')
  })

  it('adds the levels (2^l x 2^l grid each) and the tile name templates (base and base_red only: the glow stays at level 0)', () => {
    expect(m.levels).toEqual([
      { level: 0, cols: 1, rows: 1 },
      { level: 1, cols: 2, rows: 2 },
    ])
    expect(m.tiles).toEqual({
      base: 'base_L{l}_{c}_{r}.webp',
      base_red: 'base_red_L{l}_{c}_{r}.webp',
    })
  })

  it('survives a JSON round trip unchanged', () => {
    expect(JSON.parse(JSON.stringify(m))).toEqual(m)
  })
})

describe('tileFile', () => {
  it('fills level, column and row', () => {
    expect(tileFile('glow_red_L{l}_{c}_{r}.webp', 1, 0, 1)).toBe('glow_red_L1_0_1.webp')
  })
})

describe('manifestFiles', () => {
  it('lists manifest, labels, the level-0 widths of all four kinds and the level >= 1 base tiles (22 per region)', () => {
    const files = manifestFiles(buildManifest('se_mi', extent))
    expect(files).toHaveLength(2 + 4 * 3 + 2 * 4)
    expect(new Set(files).size).toBe(files.length)
    expect(files).toContain('manifest.json')
    expect(files).toContain('labels.json')
    expect(files).toContain('base_874.webp')
    expect(files).toContain('glow_red_3496.webp')
    expect(files).toContain('base_L1_1_1.webp')
    expect(files).toContain('base_red_L1_0_1.webp')
    expect(files.some((f) => f.startsWith('glow') && f.includes('_L1_'))).toBe(false)
    expect(files.some((f) => f.includes('_L0_'))).toBe(false)
  })
})

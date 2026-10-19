import { describe, expect, it } from 'vitest'
import { buildManifest, KEYS, manifestFiles, TILE_KEYS, tileFile } from '../../render/manifest'

const extent = { bounds: [-86.9, 41.65, -82.4, 45.9] as [number, number, number, number], width: 3496, height: 4576, levels: [0, 1] }

describe('buildManifest (v3: glow pre-composited into the picture)', () => {
  const m = buildManifest('se_mi', extent)

  it('keeps every v1 field the app reads; the files are base, base_red and the glow composites (no glow overlay)', () => {
    expect(m.metro).toBe('se_mi')
    expect(m.bounds).toEqual(extent.bounds)
    expect(m.aspect).toBe(4576 / 3496)
    expect(m.widths).toEqual([874, 1748, 3496])
    expect(m.files).toEqual({
      base: 'base_{w}.webp',
      base_red: 'base_red_{w}.webp',
      base_glow: 'base_glow_{w}.webp',
      base_glow_red: 'base_glow_red_{w}.webp',
    })
    expect(m.labels).toBe('labels.json')
    expect(KEYS).toEqual(['base', 'base_red', 'base_glow', 'base_glow_red'])
  })

  it('adds the levels (2^l x 2^l grid each) and tile templates for all four kinds', () => {
    expect(m.levels).toEqual([
      { level: 0, cols: 1, rows: 1 },
      { level: 1, cols: 2, rows: 2 },
    ])
    expect(TILE_KEYS).toEqual(KEYS)
    expect(m.tiles).toEqual({
      base: 'base_L{l}_{c}_{r}.webp',
      base_red: 'base_red_L{l}_{c}_{r}.webp',
      base_glow: 'base_glow_L{l}_{c}_{r}.webp',
      base_glow_red: 'base_glow_red_L{l}_{c}_{r}.webp',
    })
  })

  it('survives a JSON round trip unchanged', () => {
    expect(JSON.parse(JSON.stringify(m))).toEqual(m)
  })
})

describe('tileFile', () => {
  it('fills level, column and row', () => {
    expect(tileFile('base_glow_red_L{l}_{c}_{r}.webp', 1, 0, 1)).toBe('base_glow_red_L1_0_1.webp')
  })
})

describe('manifestFiles', () => {
  it('lists manifest, labels, the level-0 widths and the level >= 1 tiles of all four kinds (30 per region)', () => {
    const files = manifestFiles(buildManifest('se_mi', extent))
    expect(files).toHaveLength(2 + 4 * 3 + 4 * 4)
    expect(new Set(files).size).toBe(files.length)
    expect(files).toContain('manifest.json')
    expect(files).toContain('labels.json')
    expect(files).toContain('base_874.webp')
    expect(files).toContain('base_glow_red_3496.webp')
    expect(files).toContain('base_L1_1_1.webp')
    expect(files).toContain('base_red_L1_0_1.webp')
    expect(files).toContain('base_glow_L1_1_0.webp')
    expect(files).toContain('base_glow_red_L1_0_0.webp')
    // The separate glow overlay is gone.
    expect(files.some((f) => f.startsWith('glow'))).toBe(false)
    expect(files.some((f) => f.includes('_L0_'))).toBe(false)
  })
})

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildStyle } from '../../src/map/style'
import { toRed } from '../../src/map/color'

const base = { tilesUrl: 'https://t.example/tiles', metros: ['se_mi', 'bay_area'], glow: true, red: false }

const COLOR_PROPS = [
  'background-color', 'fill-color', 'line-color', 'text-color', 'text-halo-color',
  'fill-outline-color', 'circle-color',
]

function allColors(style: ReturnType<typeof buildStyle>): string[] {
  const out: string[] = []
  for (const l of style.layers) {
    const paint = (l as { paint?: Record<string, unknown> }).paint ?? {}
    for (const k of COLOR_PROPS) if (typeof paint[k] === 'string') out.push(paint[k] as string)
  }
  return out
}

function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = (h * 60 + 360) % 360
  return { h, s, l }
}
const isRedOrNeutral = (hex: string) => {
  const { h, s } = hsl(hex)
  return s < 0.1 || h <= 20 || h >= 340
}

const layer = (style: ReturnType<typeof buildStyle>, id: string) => {
  const l = style.layers.find((x) => x.id === id)
  if (!l) throw new Error(`missing layer ${id}`)
  return l as unknown as { paint: Record<string, unknown>; layout?: Record<string, unknown>; minzoom?: number; maxzoom?: number; filter?: unknown }
}

describe('buildStyle', () => {
  it('uses pmtiles URLs per metro and theme', () => {
    const s = buildStyle(base)
    for (const m of base.metros) {
      for (const t of ['base', 'transportation', 'buildings', 'divisions']) {
        expect(s.sources[`${m}-${t}`]).toMatchObject({
          type: 'vector',
          url: `pmtiles://https://t.example/tiles/${m}/basemap_${m}_${t}.pmtiles`,
        })
      }
      expect(s.sources[`${m}-glow`]).toBeUndefined()
    }
  })

  it('red mode uses the red-only glow tiles without greyscale tricks', () => {
    const s = buildStyle({ ...base, red: true })
    expect(s.sources['us-glow']).toMatchObject({ url: 'pmtiles://https://t.example/tiles/us/lightpollution_us_red.pmtiles' })
    expect(layer(s, 'glow-us').paint['raster-saturation']).toBeUndefined()
    expect(layer(s, 'glow-us').layout?.visibility).toBe('visible')
  })

  it('one lower-48 glow source covers the whole map, independent of metros', () => {
    for (const metros of [['se_mi', 'bay_area'], []]) {
      const s = buildStyle({ ...base, metros })
      expect(s.sources['us-glow']).toMatchObject({
        type: 'raster',
        url: 'pmtiles://https://t.example/tiles/us/lightpollution_us.pmtiles',
        tileSize: 256,
      })
      expect(s.layers.filter((l) => l.id.startsWith('glow')).map((l) => l.id)).toEqual(['glow-us'])
    }
  })

  it('metro basemaps only from z7, so the zoomed-out map is just the US glow (no tile-footprint blocks)', () => {
    const s = buildStyle(base)
    const metroLayers = s.layers.filter((l) => 'source' in l && base.metros.some((m) => String(l.source).startsWith(`${m}-`)))
    expect(metroLayers.length).toBeGreaterThan(0)
    for (const l of metroLayers) expect(l.minzoom ?? 0).toBeGreaterThanOrEqual(7)
    expect(layer(s, 'road-minor-se_mi').minzoom).toBe(11) // stricter per-layer minzooms are kept
    expect(layer(s, 'glow-us').minzoom).toBeUndefined()
  })

  it('US-wide borders: water background, land shapes, country/state lines and state names at every zoom', () => {
    for (const metros of [['se_mi', 'bay_area'], []]) {
      const s = buildStyle({ ...base, metros })
      expect(s.sources['us-divisions']).toMatchObject({
        type: 'vector',
        url: 'pmtiles://https://t.example/tiles/us/basemap_us_divisions.pmtiles',
      })
      const ids = s.layers.map((l) => l.id)
      expect(ids.slice(0, 2)).toEqual(['background', 'land-us'])
      expect(layer(s, 'background').paint['background-color']).toBe('#0C1734') // water
      expect(layer(s, 'land-us').filter).toEqual(['==', ['get', 'class'], 'land'])
      for (const id of ['boundaries-country-us', 'boundaries-region-us', 'labels-regions-us']) {
        expect(ids).toContain(id)
        expect(layer(s, id).minzoom ?? 0).toBeLessThan(7)
      }
      expect(ids.indexOf('glow-us')).toBeLessThan(ids.indexOf('boundaries-region-us'))
      expect(layer(s, 'labels-regions-us').maxzoom).toBe(7) // metro labels take over when zoomed in
    }
  })

  it('state/country borders come from the land-only GeoJSON at every zoom (no lines through lakes)', () => {
    const s = buildStyle(base)
    expect(s.sources['us-borders']).toMatchObject({ type: 'geojson', data: 'https://t.example/tiles/us/borders.geojson' })
    expect(s.sources['us-state-lines']).toBeUndefined()
    const filters: [string, unknown][] = [
      ['boundaries-region-us', ['all', ['==', ['get', 'subtype'], 'region'], ['!', ['get', 'water']]]],
      ['boundaries-country-us', ['all', ['==', ['get', 'subtype'], 'country'], ['!', ['get', 'water']]]],
      ['boundaries-country-water-us', ['all', ['==', ['get', 'subtype'], 'country'], ['get', 'water']]],
    ]
    for (const [id, filter] of filters) {
      const l = layer(s, id) as unknown as { source: string; filter: unknown; minzoom?: number; maxzoom?: number }
      expect(l.source).toBe('us-borders')
      expect(l.filter).toEqual(filter)
      expect(l.minzoom).toBeUndefined()
      expect(l.maxzoom).toBeUndefined()
    }
    expect(s.layers.some((l) => 'source-layer' in l && l['source-layer'] === 'division_boundary' && l.id.endsWith('-us'))).toBe(false)
    // Over water the country border is drawn dashed and fainter than on land.
    const water = layer(s, 'boundaries-country-water-us')
    expect(water.paint['line-dasharray']).toBeDefined()
    expect(layer(s, 'boundaries-country-us').paint['line-dasharray']).toBeUndefined()
    expect(water.paint['line-opacity']).toBeLessThan(1)

  })

  it('metro county lines sit under the metro water, and states/countries are left to the GeoJSON', () => {
    const s = buildStyle(base)
    const ids = s.layers.map((l) => l.id)
    for (const m of base.metros) {
      expect(layer(s, `boundaries-${m}`).filter).toEqual(['all', ['==', ['get', 'class'], 'land'], ['==', ['get', 'subtype'], 'county']])
      expect(ids.indexOf(`boundaries-${m}`)).toBeLessThan(ids.indexOf(`water-${m}`))
    }
  })

  it('metro sources carry their bbox as bounds, so other metros never get tile requests for this area', () => {
    const s = buildStyle(base)
    expect(s.sources['se_mi-base']).toMatchObject({ bounds: [-86.9, 41.65, -82.4, 45.9] }) // whole Lower Peninsula map
    expect(s.sources['bay_area-transportation']).toMatchObject({ bounds: [-123.2, 36.4, -121.0, 38.6] })
  })

  it('glow layer below first road layer and hidden when glow=false', () => {
    const s = buildStyle(base)
    const ids = s.layers.map((l) => l.id)
    const glow = ids.findIndex((i) => i.startsWith('glow'))
    const road = ids.findIndex((i) => i.startsWith('road'))
    expect(glow).toBeGreaterThan(-1)
    expect(glow).toBeLessThan(road)
    expect(layer(s, 'glow-us').layout?.visibility).toBe('visible')
    expect(layer(s, 'glow-us').paint['raster-opacity']).toBe(0.55)
    const off = buildStyle({ ...base, glow: false })
    expect(layer(off, 'glow-us').layout?.visibility).toBe('none')
  })

  it('buildings minzoom 13', () => {
    expect(layer(buildStyle(base), 'buildings-se_mi').minzoom).toBe(13)
  })

  it('no land_cover layers: ESA-derived shapes are pixel-blocky and read as water patches', () => {
    const s = buildStyle(base)
    expect(s.layers.filter((l) => 'source-layer' in l && l['source-layer'] === 'land_cover')).toEqual([])
  })

  it('moonlit colors match spec', () => {
    const s = buildStyle(base)
    expect(layer(s, 'background').paint['background-color']).toBe('#0C1734') // water; land comes from land-us
    expect(layer(s, 'land-us').paint['fill-color']).toBe('#141A2E')
    expect(layer(s, 'land-se_mi').paint['fill-color']).toBe('#141A2E')
    expect(layer(s, 'water-se_mi').paint['fill-color']).toBe('#0C1734')
    expect(layer(s, 'landuse-parks-se_mi').paint['fill-color']).toBe('#18302A')
    expect(layer(s, 'buildings-se_mi').paint['fill-color']).toBe('#1B2238')
    expect(layer(s, 'road-major-se_mi').paint['line-color']).toBe('#59658F')
    expect(layer(s, 'road-mid-se_mi').paint['line-color']).toBe('#3D4870')
    expect(layer(s, 'road-minor-se_mi').paint['line-color']).toBe('#2C3552')
    expect(layer(s, 'road-minor-se_mi').minzoom).toBe(11)
    expect(layer(s, 'boundaries-se_mi').paint['line-color']).toBe('#3A4466')
    expect(layer(s, 'boundaries-se_mi').paint['line-dasharray']).toBeTruthy()
    expect(layer(s, 'labels-places-se_mi').paint['text-color']).toBe('#9AA6C8')
    expect(layer(s, 'labels-places-se_mi').paint['text-halo-color']).toBe('#0B0F2A')
  })

  it('red style contains no non-red hues', () => {
    const colors = allColors(buildStyle({ ...base, red: true }))
    expect(colors.length).toBeGreaterThan(10)
    for (const c of colors) expect(isRedOrNeutral(c), c).toBe(true)
  })

  it('no shadow-like paint props', () => {
    for (const red of [false, true]) {
      for (const l of buildStyle({ ...base, red }).layers) {
        const paint = (l as { paint?: Record<string, unknown> }).paint ?? {}
        for (const [k, v] of Object.entries(paint)) {
          if (k.endsWith('-halo-blur')) expect(Number(v)).toBeLessThanOrEqual(1)
          expect(k).not.toMatch(/shadow|translate-anchor/)
        }
      }
    }
  })
})

describe('style validity', () => {
  it('passes the MapLibre style spec validator (normal and red)', () => {
    for (const red of [false, true]) {
      expect(validateStyleMin(buildStyle({ ...base, red }) as never)).toEqual([])
    }
  })

  it('default glyphs URL is same-origin and fonts are shipped', () => {
    const g = buildStyle(base).glyphs!
    expect(g.startsWith(import.meta.env.BASE_URL)).toBe(true)
    expect(g).not.toMatch(/^https?:/)
    for (const l of buildStyle(base).layers) {
      const f = (l as { layout?: { 'text-font'?: string[] } }).layout?.['text-font']
      if (f) for (const n of f) expect(existsSync(`public/glyphs/${n}/0-255.pbf`), n).toBe(true)
    }
  })
})

describe('attribution', () => {
  it('credits Overture, OSM, TomTom, ESA and VIIRS on the sources', () => {
    const src = buildStyle(base).sources as Record<string, { attribution?: string }>
    for (const m of base.metros) {
      for (const t of ['base', 'transportation', 'buildings', 'divisions']) {
        expect(src[`${m}-${t}`].attribution).toContain('Overture Maps Foundation')
        expect(src[`${m}-${t}`].attribution).toContain('© OpenStreetMap contributors')
      }
      expect(src[`${m}-transportation`].attribution).toContain('TomTom')
      expect(src[`${m}-base`].attribution).toContain('ESA WorldCover')
    }
    expect(src['us-glow'].attribution).toContain('VIIRS VNL, EOG / Colorado School of Mines')
  })

  it('attribution links open safely in a new tab', () => {
    const src = buildStyle(base).sources as Record<string, { attribution?: string }>
    const links = Object.values(src).flatMap((s) => [...(s.attribution ?? '').matchAll(/<a [^>]*>/g)].map((m) => m[0]))
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) {
      expect(a).toContain('target="_blank"')
      expect(a).toContain('rel="noopener noreferrer"')
    }
  })
})

describe('toRed', () => {
  it('preserves relative luminance order', () => {
    const lum = (hex: string) => hsl(hex).l
    const input = ['#0B0F2A', '#0C1734', '#141A2E', '#18302A', '#1B2238', '#2C3552', '#3D4870', '#59658F', '#9AA6C8']
    const out = input.map(toRed)
    const srcY = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const sortedIn = [...input].sort((a, b) => srcY(a) - srcY(b))
    const sortedOut = [...out].sort((a, b) => lum(a) - lum(b))
    expect(sortedIn.map(toRed)).toEqual(sortedOut)
    expect(toRed('#000000')).toBe('#000000')
    expect(toRed('#ffffff')).toMatch(/^#[0-9A-F]{2}0000$/)
  })
})

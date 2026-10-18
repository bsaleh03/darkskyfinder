import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'
import { toRed } from '../../src/map/color'
import { renderStyle } from '../../render/style'

const base = {
  tilesUrl: 'https://t.example/tiles',
  metro: 'se_mi',
  red: false,
  bordersUrl: 'https://t.example/tiles/maps/se_mi/borders.geojson',
}
type Style = ReturnType<typeof renderStyle>

const COLOR_PROPS = ['background-color', 'fill-color', 'line-color', 'fill-outline-color']

function allColors(style: Style): string[] {
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

const layer = (style: Style, id: string) => {
  const l = style.layers.find((x) => x.id === id)
  if (!l) throw new Error(`missing layer ${id}`)
  return l as unknown as {
    source?: string; 'source-layer'?: string; paint: Record<string, unknown>
    layout?: Record<string, unknown>; minzoom?: number; maxzoom?: number; filter?: unknown
  }
}

describe('renderStyle', () => {
  it('uses pmtiles URLs for the metro base, transportation and divisions themes', () => {
    for (const metro of ['se_mi', 'bay_area']) {
      const s = renderStyle({ ...base, metro })
      for (const t of ['base', 'transportation', 'divisions']) {
        expect(s.sources[`${metro}-${t}`]).toMatchObject({
          type: 'vector',
          url: `pmtiles://https://t.example/tiles/${metro}/basemap_${metro}_${t}.pmtiles`,
        })
      }
      expect(Object.keys(s.sources).some((k) => k.startsWith('us-'))).toBe(false)
    }
  })

  it('water background, then land from the metro divisions (class land)', () => {
    const s = renderStyle(base)
    expect(s.layers.slice(0, 2).map((l) => l.id)).toEqual(['background', 'land'])
    const land = layer(s, 'land')
    expect(land.source).toBe('se_mi-divisions')
    expect(land['source-layer']).toBe('division_area')
    expect(land.filter).toEqual(['==', ['get', 'class'], 'land'])
  })

  it('moonlit colors match spec', () => {
    const s = renderStyle(base)
    expect(layer(s, 'background').paint['background-color']).toBe('#0C1734')
    expect(layer(s, 'land').paint['fill-color']).toBe('#141A2E')
    expect(layer(s, 'water').paint['fill-color']).toBe('#0C1734')
    expect(layer(s, 'landuse-parks').paint['fill-color']).toBe('#18302A')
    expect(layer(s, 'road-major').paint['line-color']).toBe('#59658F')
    expect(layer(s, 'road-mid').paint['line-color']).toBe('#3D4870')
    expect(layer(s, 'road-minor').paint['line-color']).toBe('#2C3552')
    expect(layer(s, 'boundaries-county').paint['line-color']).toBe('#3A4466')
    expect(layer(s, 'boundaries-county').paint['line-dasharray']).toBeTruthy()
  })

  it('parks and water come from the metro base theme', () => {
    const s = renderStyle(base)
    expect(layer(s, 'landuse-parks')).toMatchObject({
      source: 'se_mi-base', 'source-layer': 'land_use',
      filter: ['in', ['get', 'subtype'], ['literal', ['park', 'protected', 'recreation']]],
    })
    expect(layer(s, 'water')).toMatchObject({ source: 'se_mi-base', 'source-layer': 'water' })
  })

  it('roads by class, minor from z11, minor drawn first so major roads sit on top', () => {
    const s = renderStyle(base)
    const ids = s.layers.map((l) => l.id)
    expect(layer(s, 'road-minor').minzoom).toBe(11)
    expect(layer(s, 'road-mid').minzoom).toBeUndefined()
    expect(layer(s, 'road-major').minzoom).toBeUndefined()
    expect(ids.indexOf('road-minor')).toBeLessThan(ids.indexOf('road-mid'))
    expect(ids.indexOf('road-mid')).toBeLessThan(ids.indexOf('road-major'))
    for (const id of ['road-minor', 'road-mid', 'road-major']) {
      expect(layer(s, id)).toMatchObject({ source: 'se_mi-transportation', 'source-layer': 'segment' })
    }
    expect(layer(s, 'road-major').filter).toEqual([
      'all', ['==', ['get', 'subtype'], 'road'], ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
    ])
  })

  it('draws attribute-less segments (most low-zoom road pieces in Overture tiles) as minor roads, under the classes', () => {
    const s = renderStyle(base)
    const ids = s.layers.map((l) => l.id)
    const l = layer(s, 'road-unclassified')
    expect(l).toMatchObject({ source: 'se_mi-transportation', 'source-layer': 'segment', filter: ['!', ['has', 'subtype']] })
    expect(l.minzoom).toBeUndefined()
    expect(l.paint['line-color']).toBe('#2C3552')
    expect(ids.indexOf('road-unclassified')).toBeLessThan(ids.indexOf('road-minor'))
  })

  it('county lines sit under the water', () => {
    const s = renderStyle(base)
    const ids = s.layers.map((l) => l.id)
    expect(layer(s, 'boundaries-county').filter).toEqual([
      'all', ['==', ['get', 'class'], 'land'], ['==', ['get', 'subtype'], 'county'],
    ])
    expect(layer(s, 'boundaries-county').source).toBe('se_mi-divisions')
    expect(ids.indexOf('boundaries-county')).toBeLessThan(ids.indexOf('water'))
  })

  it('borders come from the land-only GeoJSON; country over water is dashed and fainter', () => {
    const s = renderStyle(base)
    expect(s.sources.borders).toMatchObject({ type: 'geojson', data: base.bordersUrl })
    const filters: [string, unknown][] = [
      ['boundaries-region', ['all', ['==', ['get', 'subtype'], 'region'], ['!', ['get', 'water']]]],
      ['boundaries-country', ['all', ['==', ['get', 'subtype'], 'country'], ['!', ['get', 'water']]]],
      ['boundaries-country-water', ['all', ['==', ['get', 'subtype'], 'country'], ['get', 'water']]],
    ]
    for (const [id, filter] of filters) {
      expect(layer(s, id).source).toBe('borders')
      expect(layer(s, id).filter).toEqual(filter)
    }
    expect(layer(s, 'boundaries-region').paint['line-dasharray']).toBeDefined()
    expect(layer(s, 'boundaries-country').paint['line-dasharray']).toBeUndefined()
    expect(layer(s, 'boundaries-country-water').paint['line-dasharray']).toBeDefined()
    expect(layer(s, 'boundaries-country-water').paint['line-opacity']).toBe(0.6)
    // Borders draw over roads and water.
    const ids = s.layers.map((l) => l.id)
    expect(ids.indexOf('boundaries-region')).toBeGreaterThan(ids.indexOf('road-major'))
    expect(ids.indexOf('boundaries-country')).toBeGreaterThan(ids.indexOf('water'))
  })

  it('has no symbol layers and no glyphs', () => {
    for (const red of [false, true]) {
      const s = renderStyle({ ...base, red })
      expect(s.glyphs).toBeUndefined()
      expect(s.layers.filter((l) => l.type === 'symbol')).toEqual([])
    }
  })

  it('has no land_cover or raster layers', () => {
    const s = renderStyle(base)
    expect(s.layers.filter((l) => 'source-layer' in l && l['source-layer'] === 'land_cover')).toEqual([])
    expect(s.layers.filter((l) => l.type === 'raster')).toEqual([])
    expect(Object.values(s.sources).filter((x) => x.type === 'raster')).toEqual([])
    expect(s.layers.some((l) => l.id.includes('glow') || l.id.includes('building'))).toBe(false)
  })

  it('red maps every color through toRed', () => {
    const normal = allColors(renderStyle(base))
    const red = allColors(renderStyle({ ...base, red: true }))
    expect(red.length).toBeGreaterThanOrEqual(10)
    expect(red).toEqual(normal.map(toRed))
    for (const c of red) expect(isRedOrNeutral(c), c).toBe(true)
  })

  it('passes the MapLibre style spec validator (normal and red)', () => {
    for (const red of [false, true]) expect(validateStyleMin(renderStyle({ ...base, red }) as never)).toEqual([])
  })
})

describe('attribution', () => {
  it('credits Overture, OSM, TomTom and ESA on the sources', () => {
    const src = renderStyle(base).sources as Record<string, { attribution?: string }>
    for (const t of ['base', 'transportation', 'divisions']) {
      expect(src[`se_mi-${t}`].attribution).toContain('Overture Maps Foundation')
      expect(src[`se_mi-${t}`].attribution).toContain('© OpenStreetMap contributors')
    }
    expect(src['se_mi-transportation'].attribution).toContain('TomTom')
    expect(src['se_mi-base'].attribution).toContain('ESA WorldCover')
    expect(src.borders.attribution).toContain('Overture Maps Foundation')
  })
})

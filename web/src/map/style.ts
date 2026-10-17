import type { StyleSpecification, LayerSpecification, SourceSpecification } from 'maplibre-gl'
import { toRed } from './color'

export interface StyleOpts {
  tilesUrl: string
  metros: string[]
  glow: boolean
  red: boolean
  glyphs?: string
}

const THEMES = ['base', 'transportation', 'buildings', 'divisions'] as const
const FONT_PLACE = ['Noto Sans Bold']
const FONT_ROAD = ['Noto Sans Regular']
// Verified against real tiles: segment.class is the road class, subtype is road|rail;
// land_use.subtype park|protected|recreation|golf; land_cover.subtype forest.
const MAJOR = ['motorway', 'trunk']
const MID = ['primary', 'secondary']

const C = {
  land: '#141A2E', water: '#0C1734', parks: '#18302A', forest: '#111729', buildings: '#1B2238',
  major: '#59658F', mid: '#3D4870', minor: '#2C3552', boundary: '#3A4466',
  label: '#9AA6C8', halo: '#0B0F2A',
}

const zoomWidth = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 4, a, 14, b]
const inList = (prop: string, vals: string[]) => ['in', ['get', prop], ['literal', vals]]

export function buildStyle(opts: StyleOpts): StyleSpecification {
  const col = (hex: string) => (opts.red ? toRed(hex) : hex)
  const vis = (v: boolean) => ({ visibility: v ? 'visible' : 'none' }) as const
  const sources: Record<string, SourceSpecification> = {}
  const base = opts.tilesUrl.replace(/\/+$/, '')
  for (const m of opts.metros) {
    for (const t of THEMES) {
      sources[`${m}-${t}`] = { type: 'vector', url: `pmtiles://${base}/${m}/basemap_${m}_${t}.pmtiles` }
    }
    sources[`${m}-glow`] = {
      type: 'raster',
      url: `pmtiles://${base}/${m}/lightpollution_${m}.pmtiles`,
      tileSize: 256,
    }
  }

  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': col(C.land) } },
  ]
  const each = (fn: (m: string) => LayerSpecification[]) => opts.metros.forEach((m) => layers.push(...fn(m)))

  each((m) => [{ id: `land-${m}`, type: 'fill', source: `${m}-base`, 'source-layer': 'land', paint: { 'fill-color': col(C.land) } }])
  each((m) => [{
    id: `landcover-forest-${m}`, type: 'fill', source: `${m}-base`, 'source-layer': 'land_cover',
    filter: ['==', ['get', 'subtype'], 'forest'], paint: { 'fill-color': col(C.forest) },
  }])
  each((m) => [{
    id: `landuse-parks-${m}`, type: 'fill', source: `${m}-base`, 'source-layer': 'land_use',
    filter: inList('subtype', ['park', 'protected', 'recreation']) as never, paint: { 'fill-color': col(C.parks) },
  }])
  each((m) => [{ id: `water-${m}`, type: 'fill', source: `${m}-base`, 'source-layer': 'water', paint: { 'fill-color': col(C.water) } }])
  each((m) => [{
    id: `glow-${m}`, type: 'raster', source: `${m}-glow`, layout: vis(opts.glow),
    paint: { 'raster-opacity': 0.55, ...(opts.red ? { 'raster-saturation': -1 } : {}) },
  }])
  each((m) => [{
    id: `buildings-${m}`, type: 'fill', source: `${m}-buildings`, 'source-layer': 'building', minzoom: 13,
    paint: { 'fill-color': col(C.buildings) },
  }])

  const road = (m: string, cls: string, filter: unknown, color: string, a: number, b: number, minzoom?: number): LayerSpecification => ({
    id: `road-${cls}-${m}`, type: 'line', source: `${m}-transportation`, 'source-layer': 'segment',
    ...(minzoom !== undefined ? { minzoom } : {}),
    filter: ['all', ['==', ['get', 'subtype'], 'road'], filter] as never,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': col(color), 'line-width': zoomWidth(a, b) as never },
  })
  // minor first so major roads draw on top
  each((m) => [road(m, 'minor', ['!', inList('class', [...MAJOR, ...MID])], C.minor, 0.4, 1.4, 11)])
  each((m) => [road(m, 'mid', inList('class', MID), C.mid, 0.7, 2.2)])
  each((m) => [road(m, 'major', inList('class', MAJOR), C.major, 1.2, 3)])

  each((m) => [{
    id: `boundaries-${m}`, type: 'line', source: `${m}-divisions`, 'source-layer': 'division_boundary',
    filter: ['==', ['get', 'class'], 'land'],
    paint: { 'line-color': col(C.boundary), 'line-width': 1, 'line-dasharray': [3, 2] },
  }])

  const text = { 'text-color': col(C.label), 'text-halo-color': col(C.halo), 'text-halo-width': 1.5, 'text-halo-blur': 0 }
  each((m) => [{
    id: `labels-places-${m}`, type: 'symbol', source: `${m}-divisions`, 'source-layer': 'division_area',
    filter: inList('subtype', ['locality', 'county', 'region']) as never,
    layout: {
      'text-field': ['get', '@name'], 'text-font': FONT_PLACE,
      'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 13] as never,
    },
    paint: text,
  }])
  each((m) => [{
    id: `labels-roads-${m}`, type: 'symbol', source: `${m}-transportation`, 'source-layer': 'segment',
    filter: ['all', ['==', ['get', 'subtype'], 'road'], inList('class', MAJOR)] as never,
    minzoom: 8,
    layout: { 'symbol-placement': 'line', 'text-field': ['get', '@name'], 'text-font': FONT_ROAD, 'text-size': 11 },
    paint: text,
  }])

  return {
    version: 8,
    glyphs: opts.glyphs ?? `${import.meta.env.BASE_URL}glyphs/{fontstack}/{range}.pbf`,
    sources,
    layers,
  }
}

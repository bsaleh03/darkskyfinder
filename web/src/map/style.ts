import type { StyleSpecification, LayerSpecification, SourceSpecification } from 'maplibre-gl'
import { METRO_MAP_BOUNDS } from '../config'
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
// land_use.subtype park|protected|recreation|golf.
const MAJOR = ['motorway', 'trunk']
const MID = ['primary', 'secondary']
const METRO_MINZOOM = 7
// Borders on land only: Overture also has maritime lines (territorial-waters limits) that run offshore.
const LAND_LINE = ['==', ['get', 'class'], 'land']

// Attribution shown in MapLibre's compact control (Overture themes are ODbL/CC BY sources; see README credits).
const OVERTURE = '<a href="https://overturemaps.org" target="_blank" rel="noopener noreferrer">Overture Maps Foundation</a>'
const OSM = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>'
export const ATTRIBUTION: Record<(typeof THEMES)[number] | 'glow', string> = {
  base: `${OVERTURE}, ${OSM}, © ESA WorldCover project 2020`,
  transportation: `${OVERTURE}, ${OSM}, TomTom`,
  buildings: `${OVERTURE}, ${OSM}`,
  divisions: `${OVERTURE}, ${OSM}`,
  glow: 'VIIRS VNL, EOG / Colorado School of Mines',
}

const C = {
  land: '#141A2E', water: '#0C1734', parks: '#18302A', buildings: '#1B2238',
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
  const bounds = METRO_MAP_BOUNDS
  for (const m of opts.metros) {
    for (const t of THEMES) {
      sources[`${m}-${t}`] = {
        type: 'vector',
        url: `pmtiles://${base}/${m}/basemap_${m}_${t}.pmtiles`,
        attribution: ATTRIBUTION[t],
        // Only ask this metro's archive for tiles over this metro (each miss costs a directory lookup).
        ...(bounds[m] ? { bounds: bounds[m] } : {}),
      }
    }
  }
  // US-wide layers (any zoom): the lower-48 glow raster, plus Overture divisions to z7 for land shapes,
  // country/state borders and state names, so the map reads correctly beyond the metros.
  sources['us-glow'] = {
    type: 'raster',
    // Red mode swaps in a red-only rendering of the same raster so the glow keeps night vision.
    url: `pmtiles://${base}/us/lightpollution_us${opts.red ? '_red' : ''}.pmtiles`,
    tileSize: 256,
    attribution: ATTRIBUTION.glow,
  }
  sources['us-divisions'] = {
    type: 'vector',
    url: `pmtiles://${base}/us/basemap_us_divisions.pmtiles`,
    attribution: ATTRIBUTION.divisions,
  }
  // Country/state/province borders cut to land by the pipeline (Overture's lines run through the Great Lakes
  // and rivers, and its tiles drop state lines below z4), one GeoJSON for every zoom.
  sources['us-borders'] = {
    type: 'geojson',
    data: `${base}/us/borders.geojson`,
    attribution: ATTRIBUTION.divisions,
  }

  // Water is the background; land-clipped division areas draw the coasts and the Great Lakes.
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': col(C.water) } },
    {
      id: 'land-us', type: 'fill', source: 'us-divisions', 'source-layer': 'division_area',
      filter: ['==', ['get', 'class'], 'land'], paint: { 'fill-color': col(C.land) },
    },
  ]
  const each = (fn: (m: string) => LayerSpecification[]) => opts.metros.forEach((m) => layers.push(...fn(m)))

  each((m) => [{ id: `land-${m}`, type: 'fill', source: `${m}-base`, 'source-layer': 'land', paint: { 'fill-color': col(C.land) } }])
  // No land_cover layer: Overture's land cover is traced from ESA satellite pixels, so it draws blocky
  // dark patches (e.g. floodplain forest along rivers) that read as water on this palette.
  each((m) => [{
    id: `landuse-parks-${m}`, type: 'fill', source: `${m}-base`, 'source-layer': 'land_use',
    filter: inList('subtype', ['park', 'protected', 'recreation']) as never, paint: { 'fill-color': col(C.parks) },
  }])
  // County lines go under the metro water so their lake/river stretches are hidden.
  each((m) => [{
    id: `boundaries-${m}`, type: 'line', source: `${m}-divisions`, 'source-layer': 'division_boundary',
    filter: ['all', LAND_LINE, ['==', ['get', 'subtype'], 'county']] as never,
    paint: { 'line-color': col(C.boundary), 'line-width': 1, 'line-dasharray': [3, 2] },
  }])
  each((m) => [{ id: `water-${m}`, type: 'fill', source: `${m}-base`, 'source-layer': 'water', paint: { 'fill-color': col(C.water) } }])
  layers.push({
    id: 'glow-us', type: 'raster', source: 'us-glow', layout: vis(opts.glow),
    paint: { 'raster-opacity': 0.55 },
  })
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

  const onLand = ['!', ['get', 'water']]
  const country = ['==', ['get', 'subtype'], 'country']
  layers.push(
    {
      id: 'boundaries-region-us', type: 'line', source: 'us-borders',
      filter: ['all', ['==', ['get', 'subtype'], 'region'], onLand] as never,
      paint: { 'line-color': col(C.boundary), 'line-width': zoomWidth(0.6, 1.2) as never, 'line-dasharray': [3, 2] },
    },
    {
      // Where the country border crosses lakes and rivers it is drawn dashed and fainter, so it doesn't read as a shore.
      id: 'boundaries-country-water-us', type: 'line', source: 'us-borders',
      filter: ['all', country, ['get', 'water']] as never,
      paint: {
        'line-color': col(C.major), 'line-width': zoomWidth(0.8, 1.4) as never,
        'line-dasharray': [4, 3], 'line-opacity': 0.6,
      },
    },
    {
      id: 'boundaries-country-us', type: 'line', source: 'us-borders', filter: ['all', country, onLand] as never,
      paint: { 'line-color': col(C.major), 'line-width': zoomWidth(1, 1.8) as never },
    },
  )

  const text = { 'text-color': col(C.label), 'text-halo-color': col(C.halo), 'text-halo-width': 1.5, 'text-halo-blur': 0 }
  layers.push({
    id: 'labels-regions-us', type: 'symbol', source: 'us-divisions', 'source-layer': 'division',
    filter: ['==', ['get', 'subtype'], 'region'], minzoom: 4, maxzoom: METRO_MINZOOM,
    layout: {
      'text-field': ['get', '@name'], 'text-font': FONT_PLACE,
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 7, 12] as never,
    },
    paint: { ...text, 'text-opacity': 0.8 },
  })
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

  // Metro extracts are whole low-zoom tiles that reach far past each metro, so zoomed out they would draw
  // lakes/labels inside big rectangles only. Below METRO_MINZOOM the map is just the US-wide layers.
  for (const l of layers) {
    if ('source' in l && !String(l.source).startsWith('us-')) l.minzoom = Math.max(l.minzoom ?? 0, METRO_MINZOOM)
  }

  return {
    version: 8,
    glyphs: opts.glyphs ?? `${import.meta.env.BASE_URL}glyphs/{fontstack}/{range}.pbf`,
    sources,
    layers,
  }
}

import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl'
import { toRed } from '../src/map/color'

// Style for the pre-rendered base pictures (dev-only render page). Adapted from the app's live-map style:
// one metro, Moonlit colors, no labels (the app draws them), no glyphs, no glow (separate image), no land cover.

export interface RenderStyleOpts {
  tilesUrl: string
  metro: string
  red: boolean
  bordersUrl: string
}

const THEMES = ['base', 'transportation', 'divisions'] as const
// Verified against real tiles: segment.class is the road class, subtype is road|rail;
// land_use.subtype park|protected|recreation|golf.
const MAJOR = ['motorway', 'trunk']
const MID = ['primary', 'secondary']
// Division lines on land only: Overture also has maritime lines (territorial-waters limits) that run offshore.
const LAND_LINE = ['==', ['get', 'class'], 'land']

// Kept on the sources for provenance; the app prints the attribution line over the picture.
const OVERTURE = 'Overture Maps Foundation'
const OSM = '© OpenStreetMap contributors'
export const ATTRIBUTION: Record<(typeof THEMES)[number], string> = {
  base: `${OVERTURE}, ${OSM}, © ESA WorldCover project 2020`,
  transportation: `${OVERTURE}, ${OSM}, TomTom`,
  divisions: `${OVERTURE}, ${OSM}`,
}

const C = {
  land: '#141A2E', water: '#0C1734', parks: '#18302A',
  major: '#59658F', mid: '#3D4870', minor: '#2C3552', boundary: '#3A4466',
}

const zoomWidth = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 4, a, 14, b]
const inList = (prop: string, vals: string[]) => ['in', ['get', prop], ['literal', vals]]

export function renderStyle(opts: RenderStyleOpts): StyleSpecification {
  const col = (hex: string) => (opts.red ? toRed(hex) : hex)
  const m = opts.metro
  const base = opts.tilesUrl.replace(/\/+$/, '')
  const sources: Record<string, SourceSpecification> = {}
  for (const t of THEMES) {
    sources[`${m}-${t}`] = {
      type: 'vector',
      url: `pmtiles://${base}/${m}/basemap_${m}_${t}.pmtiles`,
      attribution: ATTRIBUTION[t],
    }
  }
  // Country/state borders cut to land by the pipeline (Overture's lines run through lakes and rivers).
  sources.borders = { type: 'geojson', data: opts.bordersUrl, attribution: ATTRIBUTION.divisions }

  const road = (cls: string, filter: unknown, color: string, a: number, b: number, minzoom?: number): LayerSpecification => ({
    id: `road-${cls}`, type: 'line', source: `${m}-transportation`, 'source-layer': 'segment',
    ...(minzoom !== undefined ? { minzoom } : {}),
    filter: ['all', ['==', ['get', 'subtype'], 'road'], filter] as never,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': col(color), 'line-width': zoomWidth(a, b) as never },
  })
  const onLand = ['!', ['get', 'water']]
  const country = ['==', ['get', 'subtype'], 'country']

  // Water is the background; land-clipped division areas draw the coasts and the Great Lakes / bays.
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': col(C.water) } },
    {
      id: 'land', type: 'fill', source: `${m}-divisions`, 'source-layer': 'division_area',
      filter: ['==', ['get', 'class'], 'land'], paint: { 'fill-color': col(C.land) },
    },
    // No land_cover layer: Overture's land cover is traced from ESA satellite pixels and draws blocky patches.
    {
      id: 'landuse-parks', type: 'fill', source: `${m}-base`, 'source-layer': 'land_use',
      filter: inList('subtype', ['park', 'protected', 'recreation']) as never, paint: { 'fill-color': col(C.parks) },
    },
    // County lines go under the water so their lake/river stretches are hidden.
    {
      id: 'boundaries-county', type: 'line', source: `${m}-divisions`, 'source-layer': 'division_boundary',
      filter: ['all', LAND_LINE, ['==', ['get', 'subtype'], 'county']] as never,
      paint: { 'line-color': col(C.boundary), 'line-width': 1, 'line-dasharray': [3, 2] },
    },
    { id: 'water', type: 'fill', source: `${m}-base`, 'source-layer': 'water', paint: { 'fill-color': col(C.water) } },
    // Below z14 Overture's transportation tiles strip the attributes from most segments (including stretches of
    // motorways and the arterial network), so the class filters alone leave broken fragments. Draw those
    // attribute-less lines as minor roads underneath the classified ones.
    {
      id: 'road-unclassified', type: 'line', source: `${m}-transportation`, 'source-layer': 'segment',
      filter: ['!', ['has', 'subtype']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': col(C.minor), 'line-width': zoomWidth(0.4, 1.4) as never },
    },
    // minor first so major roads draw on top
    road('minor', ['!', inList('class', [...MAJOR, ...MID])], C.minor, 0.4, 1.4, 11),
    road('mid', inList('class', MID), C.mid, 0.7, 2.2),
    road('major', inList('class', MAJOR), C.major, 1.2, 3),
    {
      id: 'boundaries-region', type: 'line', source: 'borders',
      filter: ['all', ['==', ['get', 'subtype'], 'region'], onLand] as never,
      paint: { 'line-color': col(C.boundary), 'line-width': zoomWidth(0.6, 1.2) as never, 'line-dasharray': [3, 2] },
    },
    {
      // Where the country border crosses lakes and rivers it is dashed and fainter, so it doesn't read as a shore.
      id: 'boundaries-country-water', type: 'line', source: 'borders',
      filter: ['all', country, ['get', 'water']] as never,
      paint: {
        'line-color': col(C.major), 'line-width': zoomWidth(0.8, 1.4) as never,
        'line-dasharray': [4, 3], 'line-opacity': 0.6,
      },
    },
    {
      id: 'boundaries-country', type: 'line', source: 'borders', filter: ['all', country, onLand] as never,
      paint: { 'line-color': col(C.major), 'line-width': zoomWidth(1, 1.8) as never },
    },
  ]

  return { version: 8, sources, layers }
}

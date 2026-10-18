// Dev-only render page: draws one region's base picture with MapLibre from the local PMTiles extracts.
// Driven by scripts/render-maps.mjs: render/index.html?metro=<key>&red=0|1&w=<W>&h=<H>[&bounds=W,S,E,N][&zoom=<z>][&level=<l>]
// Without bounds the picture is the region's extent (extent.json). With bounds (a level >= 1 tile) the map shows
// exactly those bounds: fitted, or centred on their Web Mercator middle at the given zoom (level-0 zoom + level).
// level (default 0) picks the style variant (level >= 1 tiles draw minor roads from one zoom earlier).
import maplibregl, { type AddProtocolAction } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { fractionToLat, type Bounds } from '../src/map/projection'
import { renderStyle } from './style'

declare global {
  interface Window {
    __renderDone?: boolean
    __renderError?: string
    __renderErrors?: string[]
    __renderInfo?: { zoom: number; nw: [number, number]; se: [number, number]; canvas: [number, number] }
  }
}

async function main() {
  const q = new URLSearchParams(location.search)
  const metro = q.get('metro') ?? ''
  const red = q.get('red') === '1'
  const w = Number(q.get('w'))
  const h = Number(q.get('h'))
  if (!/^[a-z_]+$/.test(metro) || !(w > 0) || !(h > 0)) throw new Error('need ?metro=<key>&red=0|1&w=<W>&h=<H>')

  const tilesUrl = `${location.origin}/tiles`
  const dataUrl = `${location.origin}/render-data`
  const zoom = q.has('zoom') ? Number(q.get('zoom')) : null
  if (zoom !== null && !Number.isFinite(zoom)) throw new Error('bad ?zoom')
  const level = Number(q.get('level') ?? 0)
  if (!Number.isInteger(level) || level < 0) throw new Error('bad ?level')
  let bounds: Bounds
  if (q.has('bounds')) {
    const b = (q.get('bounds') ?? '').split(',').map(Number)
    if (b.length !== 4 || !b.every(Number.isFinite) || !(b[0] < b[2] && b[1] < b[3])) throw new Error('bad ?bounds=W,S,E,N')
    bounds = b as Bounds
  } else {
    const res = await fetch(`${dataUrl}/${metro}/extent.json`)
    if (!res.ok) throw new Error(`extent.json: HTTP ${res.status}`)
    bounds = ((await res.json()) as { bounds: Bounds }).bounds
  }

  const el = document.getElementById('map')!
  el.style.width = `${w}px`
  el.style.height = `${h}px`

  maplibregl.addProtocol('pmtiles', new Protocol().tile as AddProtocolAction)
  const map = new maplibregl.Map({
    container: el,
    style: renderStyle({ tilesUrl, metro, red, level, bordersUrl: `${dataUrl}/${metro}/borders.geojson` }),
    interactive: false,
    attributionControl: false,
    preserveDrawingBuffer: true,
    pixelRatio: 1,
    maxCanvasSize: [16384, 16384],
    fadeDuration: 0,
  })
  if (zoom === null) map.fitBounds(bounds, { padding: 0, animate: false })
  else map.jumpTo({ center: [(bounds[0] + bounds[2]) / 2, fractionToLat(0.5, bounds)], zoom })
  // Every source/tile error is recorded live: the script fails the render on the first one (see render/errors.ts).
  // A source whose archive is missing never loads, so `idle` may never come; the script must not wait for it.
  const errors: string[] = []
  window.__renderErrors = errors
  map.on('error', (e) => {
    const src = (e as { sourceId?: string }).sourceId
    const msg = `${src ? `${src}: ` : ''}${e.error?.message ?? String(e.error ?? 'unknown error')}`
    errors.push(msg)
    console.error('map error', msg)
  })
  map.once('idle', () => {
    const [west, south, east, north] = bounds
    const nw = map.project([west, north])
    const se = map.project([east, south])
    const c = map.getCanvas()
    window.__renderInfo = { zoom: map.getZoom(), nw: [nw.x, nw.y], se: [se.x, se.y], canvas: [c.width, c.height] }
    window.__renderDone = true
  })
}

main().catch((e: unknown) => {
  window.__renderError = e instanceof Error ? e.message : String(e)
})

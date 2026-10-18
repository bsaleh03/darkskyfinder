// Dev-only render page: draws one region's base picture with MapLibre from the local PMTiles extracts.
// Driven by scripts/render-maps.mjs: render/index.html?metro=<key>&red=0|1&w=<W>&h=<H>
import maplibregl, { type AddProtocolAction } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { renderStyle } from './style'

declare global {
  interface Window {
    __renderDone?: boolean
    __renderError?: string
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
  const res = await fetch(`${tilesUrl}/maps/${metro}/extent.json`)
  if (!res.ok) throw new Error(`extent.json: HTTP ${res.status}`)
  const { bounds } = (await res.json()) as { bounds: [number, number, number, number] }

  const el = document.getElementById('map')!
  el.style.width = `${w}px`
  el.style.height = `${h}px`

  maplibregl.addProtocol('pmtiles', new Protocol().tile as AddProtocolAction)
  const map = new maplibregl.Map({
    container: el,
    style: renderStyle({ tilesUrl, metro, red, bordersUrl: `${tilesUrl}/maps/${metro}/borders.geojson` }),
    interactive: false,
    attributionControl: false,
    preserveDrawingBuffer: true,
    pixelRatio: 1,
    maxCanvasSize: [16384, 16384],
    fadeDuration: 0,
  })
  map.fitBounds(bounds, { padding: 0, animate: false })
  map.on('error', (e) => console.error('map error', e.error?.message ?? e))
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

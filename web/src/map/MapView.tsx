import maplibregl, { type Map as MlMap, type Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import { useEffect, useRef, useState } from 'react'
import type { Region, Spot } from '../api/types'
import { config } from '../config'
import { toRed } from './color'
import { regionBounds, styleChange, unionBounds } from './helpers'
import './MapView.css'
import { spotsToGeoJSON } from './pins'
import { buildStyle } from './style'

export interface MapViewProps {
  spots: Spot[]
  start: { lat: number; lon: number } | null
  selectedId: string | null
  glow: boolean
  red: boolean
  regions: Region[]
  focusRegion?: string
  onSelect(id: string): void
  onSetStart(p: { lat: number; lon: number }): void
  onToggleGlow(): void
}

const SRC = 'spots'
const PIN_LAYERS = ['spots-ring', 'spots-pin']
const PIN_COLORS = ['#7FD6A0', '#F0C070', '#F0A070', '#F0808A', '#5A6280']
const AMBER = '#F5C96B'
const VIOLET = '#A58BE0'

let protocolRegistered = false
function registerPmtiles() {
  if (protocolRegistered) return
  protocolRegistered = true
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const isCoarse = () => window.matchMedia?.('(pointer: coarse)').matches ?? false
const metroList = (metros: string) => (metros ? metros.split(',') : [])

function addPins(map: MlMap, data: GeoJSON.FeatureCollection, red: boolean) {
  const color = red
    ? ['match', ['get', 'color'], ...PIN_COLORS.flatMap((c) => [c, toRed(c)]), toRed('#F0808A')]
    : ['get', 'color']
  map.addSource(SRC, { type: 'geojson', data })
  map.addLayer({
    id: 'spots-ring', type: 'circle', source: SRC, filter: ['==', ['get', 'darkSky'], true],
    paint: {
      'circle-radius': ['case', ['get', 'selected'], 15, 11],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 2,
      'circle-stroke-color': red ? toRed(VIOLET) : VIOLET,
    },
  })
  map.addLayer({
    id: 'spots-pin', type: 'circle', source: SRC,
    paint: {
      'circle-radius': ['case', ['get', 'selected'], 10, 6],
      'circle-color': color as never,
      'circle-stroke-width': ['case', ['get', 'selected'], 3, 1.5],
      'circle-stroke-color': red ? toRed('#EEF0F7') : '#EEF0F7',
    },
  })
}

export function MapView(props: MapViewProps) {
  const { spots, start, selectedId, glow, red, regions, focusRegion } = props
  const box = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const prevStyle = useRef<{ glow: boolean; red: boolean; metros: string }>()
  const latest = useRef(props)
  latest.current = props
  const [pending, setPending] = useState<{ lat: number; lon: number } | null>(null)
  const metros = regions.map((r) => r.key).join(',')

  // Create the map once.
  useEffect(() => {
    registerPmtiles()
    const map = new maplibregl.Map({
      container: box.current!,
      style: buildStyle({ tilesUrl: config.tilesUrl, metros: metroList(metros), glow, red }),
      center: [-95, 39],
      zoom: 3,
      attributionControl: { compact: true },
    })
    prevStyle.current = { glow, red, metros }
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    // setStyle drops our source and layers, so (re)add them on every style load.
    map.on('style.load', () => {
      const p = latest.current
      addPins(map, spotsToGeoJSON(p.spots, p.selectedId), p.red)
    })
    map.on('click', (e) => {
      const layers = PIN_LAYERS.filter((l) => map.getLayer(l))
      const hit = layers.length ? map.queryRenderedFeatures(e.point, { layers })[0] : undefined
      if (hit) return latest.current.onSelect(String(hit.properties?.id))
      const p = { lat: e.lngLat.lat, lon: e.lngLat.lng }
      if (isCoarse()) setPending(p)
      else latest.current.onSetStart(p)
    })
    map.on('mousemove', 'spots-pin', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'spots-pin', () => { map.getCanvas().style.cursor = '' })
    return () => {
      markerRef.current?.remove()
      markerRef.current = null
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // glow / red / metro changes update the existing map instead of recreating it.
  useEffect(() => {
    const map = mapRef.current
    const prev = prevStyle.current
    if (!map || !prev) return
    const next = { glow, red, metros }
    const change = prev.metros !== metros ? 'restyle' : styleChange(prev, next)
    prevStyle.current = next
    if (change === 'restyle') {
      map.setStyle(buildStyle({ tilesUrl: config.tilesUrl, metros: metroList(metros), glow, red }), { diff: false })
    } else if (change === 'glow') {
      for (const l of map.getStyle().layers) {
        if (l.id.startsWith('glow-')) map.setLayoutProperty(l.id, 'visibility', glow ? 'visible' : 'none')
      }
    }
  }, [glow, red, metros])

  // Spots and selection only touch the GeoJSON source.
  useEffect(() => {
    const src = mapRef.current?.getSource(SRC) as maplibregl.GeoJSONSource | undefined
    src?.setData(spotsToGeoJSON(spots, selectedId))
  }, [spots, selectedId])

  // Start marker.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!start) {
      markerRef.current?.remove()
      markerRef.current = null
      return
    }
    if (!markerRef.current) {
      const m = new maplibregl.Marker({ draggable: true, color: AMBER }).setLngLat([start.lon, start.lat]).addTo(map)
      m.getElement().setAttribute('aria-label', 'Your starting point (drag to move)')
      m.on('dragend', () => {
        const ll = m.getLngLat()
        latest.current.onSetStart({ lat: ll.lat, lon: ll.lng })
      })
      markerRef.current = m
    } else {
      markerRef.current.setLngLat([start.lon, start.lat])
    }
  }, [start])

  // Fly to the selected spot.
  const selectedKey = spots.find((s) => s.id === selectedId)?.id
  useEffect(() => {
    const map = mapRef.current
    const s = latest.current.spots.find((x) => x.id === selectedKey)
    if (!map || !s) return
    map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 11), duration: reducedMotion() ? 0 : 1200 })
  }, [selectedKey])

  // Fit the focused region, or all regions when none is focused.
  const region = regions.find((r) => r.key === focusRegion)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const b = region ? regionBounds(region) : unionBounds(latest.current.regions)
    if (b) map.fitBounds(b, { padding: 40, duration: reducedMotion() || !region ? 0 : 1200 })
  }, [region, metros])

  return (
    <div className="map-view">
      <div ref={box} className="map-canvas" data-testid="map" />
      <button type="button" className="map-glow-btn" aria-pressed={glow} onClick={props.onToggleGlow}>
        Light pollution glow
      </button>
      {pending && (
        <div className="map-toast" role="alertdialog" aria-label="Confirm start location">
          <span>Set start here?</span>
          <button type="button" onClick={() => { props.onSetStart(pending); setPending(null) }}>Yes</button>
          <button type="button" onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
    </div>
  )
}

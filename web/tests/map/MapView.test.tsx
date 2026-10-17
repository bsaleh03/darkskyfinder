import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

type Handler = (e?: unknown) => void

const h = vi.hoisted(() => {
  const state = {
    mapHandlers: {} as Record<string, ((e?: unknown) => void)[]>,
    styleLoaded: true,
    layersPresent: true,
    map: null as any,
    marker: null as any,
    sourceSetData: null as any,
  }
  return { state, addProtocol: vi.fn() }
})

function makeMap() {
  const s = h.state
  s.mapHandlers = {}
  s.sourceSetData = vi.fn()
  const map = {
    addControl: vi.fn(),
    on: vi.fn((ev: string, ...rest: unknown[]) => {
      const fn = rest[rest.length - 1] as Handler
      ;(s.mapHandlers[ev] ??= []).push(fn)
    }),
    once: vi.fn(),
    remove: vi.fn(),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    getLayer: vi.fn((id: string) => (s.layersPresent && id.startsWith('glow-') ? {} : undefined)),
    getSource: vi.fn(() => ({ setData: s.sourceSetData })),
    getStyle: vi.fn(() => ({ layers: [{ id: 'glow-se_mi' }, { id: 'land-se_mi' }] })),
    isStyleLoaded: vi.fn(() => s.styleLoaded),
    setStyle: vi.fn(),
    setLayoutProperty: vi.fn(),
    flyTo: vi.fn(),
    fitBounds: vi.fn(),
    getZoom: vi.fn(() => 5),
    getCanvas: vi.fn(() => document.createElement('canvas')),
    queryRenderedFeatures: vi.fn(() => []),
  }
  s.map = map
  return map
}

function makeMarker() {
  const handlers: Record<string, Handler> = {}
  const el = document.createElement('div')
  const m = {
    handlers, el,
    setLngLat: vi.fn(() => m),
    addTo: vi.fn(() => m),
    remove: vi.fn(),
    getElement: vi.fn(() => el),
    getLngLat: vi.fn(() => ({ lat: 1.5, lng: 2.5 })),
    on: vi.fn((ev: string, fn: Handler) => { handlers[ev] = fn; return m }),
  }
  h.state.marker = m
  return m
}

vi.mock('maplibre-gl', () => ({
  default: {
    Map: vi.fn(() => makeMap()),
    NavigationControl: vi.fn(),
    Marker: vi.fn(() => makeMarker()),
    addProtocol: h.addProtocol,
  },
}))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))

import maplibregl from 'maplibre-gl'
import type { Region, Spot } from '../../src/api/types'
import { MapView, type MapViewProps } from '../../src/map/MapView'

const region = (key: string, bbox: number[]): Region => ({ key, name: key, bbox, center: [0, 0], zoom: 8, timezone: 'UTC' })
const spot = (id: string): Spot => ({ id, lat: 42, lon: -83, sky_label: 'vivid', unavailable: false, dark_sky_place: false }) as Spot

let base: MapViewProps
let mm: (q: string) => void // set matchMedia matches by query substring

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  h.state.styleLoaded = true
  h.state.layersPresent = true
  base = {
    spots: [], start: null, selectedId: null, glow: true, red: false,
    regions: [region('se_mi', [-84, 41, -82, 43])],
    onSelect: vi.fn(), onSetStart: vi.fn(), onToggleGlow: vi.fn(),
  }
  const on = new Set<string>()
  mm = (q) => on.add(q)
  window.matchMedia = vi.fn((q: string) => ({
    matches: [...on].some((x) => q.includes(x)),
    media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as never
})

const fire = (ev: string, e?: unknown) => act(() => { h.state.mapHandlers[ev]?.forEach((fn) => fn(e)) })
const click = (target: EventTarget = document.body) =>
  fire('click', { point: { x: 1, y: 1 }, lngLat: { lat: 10, lng: 20 }, originalEvent: { target } })

test('registers pmtiles once and creates the map once across restyles', () => {
  const { rerender } = render(<MapView {...base} />)
  rerender(<MapView {...base} glow={false} />)
  rerender(<MapView {...base} red />)
  expect(h.addProtocol).toHaveBeenCalledTimes(1)
  expect(h.addProtocol).toHaveBeenCalledWith('pmtiles', expect.any(Function))
  expect(maplibregl.Map).toHaveBeenCalledTimes(1)
})

test('red toggle restyles and style.load re-adds pins with current data', () => {
  const { rerender } = render(<MapView {...base} spots={[spot('a')]} />)
  fire('style.load')
  expect(h.state.map.addSource).toHaveBeenCalledTimes(1)
  rerender(<MapView {...base} spots={[spot('a')]} red />)
  expect(h.state.map.setStyle).toHaveBeenCalledTimes(1)
  fire('style.load')
  expect(h.state.map.addSource).toHaveBeenCalledTimes(2)
  expect(h.state.map.addSource.mock.calls[1][1].data.features).toHaveLength(1)
  expect(h.state.map.addLayer).toHaveBeenCalledTimes(4)
})

test('spots and selection changes call setData, never setStyle', () => {
  const { rerender } = render(<MapView {...base} />)
  h.state.sourceSetData.mockClear()
  rerender(<MapView {...base} spots={[spot('a')]} />)
  rerender(<MapView {...base} spots={[spot('a')]} selectedId="a" />)
  expect(h.state.sourceSetData).toHaveBeenCalledTimes(2)
  expect(h.state.sourceSetData.mock.calls[1][0].features[0].properties.selected).toBe(true)
  expect(h.state.map.setStyle).not.toHaveBeenCalled()
})

test('glow-only change applies even when isStyleLoaded is false but layers exist', () => {
  const { rerender } = render(<MapView {...base} />)
  h.state.styleLoaded = false
  rerender(<MapView {...base} glow={false} />)
  expect(h.state.map.setLayoutProperty).toHaveBeenCalledWith('glow-se_mi', 'visibility', 'none')
})

test('unmount cancels the pending dragend timer', () => {
  vi.useFakeTimers()
  try {
    const { unmount } = render(<MapView {...base} start={{ lat: 1, lon: 2 }} />)
    act(() => h.state.marker.handlers.dragend())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('glow-only change sets layer visibility, not setStyle; deferred until layers exist', () => {
  const { rerender } = render(<MapView {...base} />)
  rerender(<MapView {...base} glow={false} />)
  expect(h.state.map.setStyle).not.toHaveBeenCalled()
  expect(h.state.map.setLayoutProperty).toHaveBeenCalledTimes(1)
  expect(h.state.map.setLayoutProperty).toHaveBeenCalledWith('glow-se_mi', 'visibility', 'none')
  h.state.layersPresent = false
  rerender(<MapView {...base} glow />)
  expect(h.state.map.setLayoutProperty).toHaveBeenCalledTimes(1)
  h.state.layersPresent = true
  fire('style.load') // applies current glow state
  expect(h.state.map.setLayoutProperty).toHaveBeenLastCalledWith('glow-se_mi', 'visibility', 'visible')
})

test('desktop click sets start immediately', () => {
  render(<MapView {...base} />)
  click()
  expect(base.onSetStart).toHaveBeenCalledWith({ lat: 10, lon: 20 })
  expect(screen.queryByText('Set start here?')).toBeNull()
})

test('coarse pointer click shows toast; only Yes sets start; Cancel and Escape dismiss', async () => {
  mm('pointer: coarse')
  render(<MapView {...base} />)
  click()
  expect(base.onSetStart).not.toHaveBeenCalled()
  expect(screen.getByText('Set start here?')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Yes' })).toHaveFocus()
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(base.onSetStart).not.toHaveBeenCalled()
  click()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByText('Set start here?')).toBeNull()
  click()
  await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
  expect(base.onSetStart).toHaveBeenCalledTimes(1)
  expect(base.onSetStart).toHaveBeenCalledWith({ lat: 10, lon: 20 })
})

test('clicks on the start marker are ignored', () => {
  render(<MapView {...base} start={{ lat: 1, lon: 2 }} />)
  const inner = document.createElement('span')
  h.state.marker.el.appendChild(inner)
  click(inner)
  expect(base.onSetStart).not.toHaveBeenCalled()
})

test('click right after dragend is ignored, then works again next tick', async () => {
  vi.useFakeTimers()
  try {
    render(<MapView {...base} start={{ lat: 1, lon: 2 }} />)
    act(() => h.state.marker.handlers.dragend())
    base.onSetStart = base.onSetStart as never
    ;(base.onSetStart as ReturnType<typeof vi.fn>).mockClear()
    click()
    expect(base.onSetStart).not.toHaveBeenCalled()
    act(() => { vi.runAllTimers() })
    click()
    expect(base.onSetStart).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

test('dragend reports the new position through the latest callback', () => {
  const { rerender } = render(<MapView {...base} start={{ lat: 1, lon: 2 }} />)
  const next = vi.fn()
  rerender(<MapView {...base} start={{ lat: 1, lon: 2 }} onSetStart={next} />)
  act(() => h.state.marker.handlers.dragend())
  expect(next).toHaveBeenCalledWith({ lat: 1.5, lon: 2.5 })
  expect(base.onSetStart).not.toHaveBeenCalled()
})

test('selecting a spot flies; reduced motion uses duration 0', () => {
  const { rerender } = render(<MapView {...base} spots={[spot('a')]} />)
  rerender(<MapView {...base} spots={[spot('a')]} selectedId="a" />)
  expect(h.state.map.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 1200 }))
  mm('prefers-reduced-motion')
  rerender(<MapView {...base} spots={[spot('a'), spot('b')]} selectedId="b" />)
  expect(h.state.map.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 0 }))
})

test('fit effect keys on focusRegion, not region identity', () => {
  const { rerender } = render(<MapView {...base} />)
  const calls = h.state.map.fitBounds.mock.calls.length
  rerender(<MapView {...base} regions={[region('se_mi', [-84, 41, -82, 43])]} />)
  expect(h.state.map.fitBounds).toHaveBeenCalledTimes(calls)
  rerender(<MapView {...base} focusRegion="se_mi" />)
  expect(h.state.map.fitBounds).toHaveBeenCalledTimes(calls + 1)
})

test('unmount removes marker and map', () => {
  const { unmount } = render(<MapView {...base} start={{ lat: 1, lon: 2 }} />)
  const marker = h.state.marker
  const map = h.state.map
  unmount()
  expect(marker.remove).toHaveBeenCalled()
  expect(map.remove).toHaveBeenCalled()
})

test('glow button calls back', async () => {
  render(<MapView {...base} />)
  await userEvent.click(screen.getByRole('button', { name: /glow/i }))
  expect(base.onToggleGlow).toHaveBeenCalled()
})

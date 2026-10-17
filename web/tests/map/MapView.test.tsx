import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

const h = vi.hoisted(() => {
  const map = {
    addControl: vi.fn(), on: vi.fn(), remove: vi.fn(), getLayer: vi.fn(), getSource: vi.fn(),
    getStyle: vi.fn(() => ({ layers: [] })), setStyle: vi.fn(), setLayoutProperty: vi.fn(),
    flyTo: vi.fn(), fitBounds: vi.fn(), getZoom: vi.fn(() => 5), getCanvas: vi.fn(),
  }
  return { map, addProtocol: vi.fn() }
})
vi.mock('maplibre-gl', () => ({
  default: {
    Map: vi.fn(() => h.map), NavigationControl: vi.fn(), Marker: vi.fn(), addProtocol: h.addProtocol,
  },
}))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))

import { MapView } from '../../src/map/MapView'

const base = {
  spots: [], start: null, selectedId: null, glow: true, red: false, regions: [],
  onSelect: vi.fn(), onSetStart: vi.fn(), onToggleGlow: vi.fn(),
}

test('registers pmtiles once, creates map once, glow toggle calls back', async () => {
  const { rerender } = render(<MapView {...base} />)
  rerender(<MapView {...base} glow={false} />)
  rerender(<MapView {...base} red />)
  expect(h.addProtocol).toHaveBeenCalledTimes(1)
  expect(h.addProtocol).toHaveBeenCalledWith('pmtiles', expect.any(Function))
  const maplibre = (await import('maplibre-gl')).default
  expect(maplibre.Map).toHaveBeenCalledTimes(1)
  expect(h.map.setStyle).toHaveBeenCalledTimes(1) // red change restyles the same map
  await userEvent.click(screen.getByRole('button', { name: /glow/i }))
  expect(base.onToggleGlow).toHaveBeenCalled()
})

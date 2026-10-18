import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Spot } from '../../src/api/types'
import { toRed } from '../../src/map/color'
import { StaticMap } from '../../src/map/StaticMap'
import type { useMapManifest as UseMapManifest } from '../../src/map/useMapManifest'
import { restoreView, stubView } from '../viewStub'

const hook = vi.hoisted(() => ({
  value: {
    manifest: {
      metro: 'se_mi',
      bounds: [-86.9, 41.65, -82.4, 45.9],
      aspect: 1.3089,
      widths: [875, 1750, 3500],
      files: { base: 'base_{w}.webp', base_red: 'base_red_{w}.webp', glow: 'glow_{w}.webp', glow_red: 'glow_red_{w}.webp' },
      labels: 'labels.json',
    },
    labels: [{ name: 'Detroit', lon: -83.4, lat: 42.6, rank: 1 }],
    status: 'ready',
  } as ReturnType<typeof UseMapManifest>,
}))
vi.mock('../../src/map/useMapManifest', async (orig) => ({
  ...(await orig<typeof import('../../src/map/useMapManifest')>()),
  useMapManifest: () => hook.value,
}))

const READY = hook.value

const spot = (over: Partial<Spot>): Spot =>
  ({
    id: 's1',
    display_name: 'Lake Park Beach',
    lon: -83.5,
    lat: 42.5,
    sky_label: 'Milky Way vivid',
    dark_sky_place: false,
    unavailable: false,
    ...over,
  }) as Spot

const SPOTS = [
  spot({}),
  spot({ id: 's2', display_name: 'Hidden Lake', lon: -83.7, lat: 42.7, dark_sky_place: true }),
]
// Spots near opposite corners: the framing covers about the whole picture.
const CORNERS = [spot({ lon: -86.8, lat: 41.7 }), spot({ id: 's2', display_name: 'Far', lon: -82.5, lat: 45.8 })]
const START = { lon: -83.14, lat: 42.49 }

function renderMap(over: Partial<Parameters<typeof StaticMap>[0]> = {}) {
  const props = {
    metro: 'se_mi',
    spots: SPOTS,
    start: START,
    selectedId: null,
    glow: true,
    red: false,
    driveMinutes: 90,
    onSelect: vi.fn(),
    onToggleGlow: vi.fn(),
    ...over,
  }
  return { props, ...render(<StaticMap {...props} />) }
}

const srcs = (c: HTMLElement) => [...c.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')
const layerWidth = (c: HTMLElement) => parseFloat((c.querySelector('.static-map-image') as HTMLElement).style.width)

afterEach(() => {
  hook.value = READY
  restoreView()
})

describe('StaticMap', () => {
  it('renders pins as buttons that select spots', () => {
    stubView(400, 300)
    const { props } = renderMap({ selectedId: 's1' })
    const pin = screen.getByRole('button', { name: 'Hidden Lake' })
    fireEvent.click(pin)
    expect(props.onSelect).toHaveBeenCalledWith('s2')
    expect(pin.className).toContain('static-map-pin--dark-sky')
    const selected = screen.getByRole('button', { name: 'Lake Park Beach' })
    expect(selected.className).toContain('static-map-pin--selected')
    expect(selected.style.getPropertyValue('--pin')).toBe('#7FD6A0')
  })

  it('start pin is labelled', () => {
    stubView(400, 300)
    renderMap()
    expect(screen.getByRole('img', { name: 'Your start' })).toBeInTheDocument()
  })

  it('glow image only when glow', () => {
    stubView(400, 300)
    const { container, props, rerender } = renderMap({ glow: false })
    expect(srcs(container)).toEqual([expect.stringMatching(/\/base_\d+\.webp$/)])
    const toggle = screen.getByRole('button', { name: 'Light pollution glow' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(props.onToggleGlow).toHaveBeenCalledOnce()
    rerender(<StaticMap {...props} glow />)
    expect(srcs(container)).toEqual([expect.stringMatching(/\/base_\d+\.webp$/), expect.stringMatching(/\/glow_\d+\.webp$/)])
    expect(screen.getByRole('button', { name: 'Light pollution glow' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('red mode uses only red files', () => {
    stubView(400, 300)
    const { container } = renderMap({ red: true })
    const all = srcs(container)
    expect(all).toHaveLength(2)
    for (const s of all) expect(s).toContain('_red_')
    expect(screen.getByRole('button', { name: 'Lake Park Beach' }).style.getPropertyValue('--pin')).toBe(toRed('#7FD6A0'))
  })

  it('picks the smallest sharp width', () => {
    stubView(400, 200, 2)
    const { container } = renderMap({ spots: CORNERS })
    expect(layerWidth(container)).toBeLessThanOrEqual(437)
    expect(srcs(container)[0]).toMatch(/\/base_875\.webp$/)
  })

  it('refits and re-chooses width on resize', () => {
    const view = stubView(400, 200, 2)
    const { container } = renderMap({ spots: CORNERS })
    const before = layerWidth(container)
    view.resize(1200, 900)
    expect(layerWidth(container)).toBeGreaterThan(before)
    expect(srcs(container)[0]).toMatch(/\/base_1750\.webp$/)
  })

  it('shows unavailable state when the manifest fails', () => {
    stubView(400, 300)
    hook.value = { manifest: null, labels: [], status: 'error' }
    const { container } = renderMap()
    expect(screen.getByText('Map unavailable right now')).toBeInTheDocument()
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })

  it('attribution line text', () => {
    stubView(400, 300)
    renderMap()
    expect(
      screen.getByText(
        'Overture Maps Foundation · © OpenStreetMap contributors · TomTom · ESA WorldCover · VIIRS VNL (EOG / Colorado School of Mines)',
      ),
    ).toBeInTheDocument()
  })

  it('places manifest labels as decorative text', () => {
    stubView(400, 300)
    renderMap()
    expect(screen.getByText('Detroit')).toHaveAttribute('aria-hidden', 'true')
  })
})

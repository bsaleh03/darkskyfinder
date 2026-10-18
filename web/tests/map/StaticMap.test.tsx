import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Spot } from '../../src/api/types'
import { toRed } from '../../src/map/color'
import { FIT_INSET, overlayRects, PIN_R, START_R, StaticMap } from '../../src/map/StaticMap'
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
      levels: [
        { level: 0, cols: 1, rows: 1 },
        { level: 1, cols: 2, rows: 2 },
      ],
      tiles: {
        base: 'base_L{l}_{c}_{r}.webp',
        base_red: 'base_red_L{l}_{c}_{r}.webp',
        glow: 'glow_L{l}_{c}_{r}.webp',
        glow_red: 'glow_red_L{l}_{c}_{r}.webp',
      },
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
const baseImgs = (c: HTMLElement) => [...c.querySelectorAll('img')].filter((i) => /\/base(_red)?_\d+\.webp$/.test(i.getAttribute('src') ?? ''))
const baseSrcs = (c: HTMLElement) => baseImgs(c).map((i) => i.getAttribute('src') ?? '')
const glowSrcs = (c: HTMLElement) => srcs(c).filter((s) => /\/glow(_red)?_/.test(s))
const tileImgs = (c: HTMLElement) => [...c.querySelectorAll<HTMLImageElement>('img.static-map-tile')]
/** "c_r" of every level-1 tile image, in DOM order. */
const tileKeys = (c: HTMLElement) =>
  tileImgs(c).map((i) => /_L1_(\d)_(\d)\.webp$/.exec(i.getAttribute('src') ?? '')!.slice(1).join('_'))
const layerWidth = (c: HTMLElement) => parseFloat((c.querySelector('.static-map-image') as HTMLElement).style.width)

/** Screen position (view px) and hit radius of the start and every pin. */
function markPositions(c: HTMLElement) {
  const layer = c.querySelector('.static-map-image') as HTMLElement
  const [, tx, ty] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(layer.style.transform)!.map(Number)
  const w = parseFloat(layer.style.width)
  const h = parseFloat(layer.style.height)
  return [...c.querySelectorAll<HTMLElement>('.static-map-pin, .static-map-start')].map((m) => ({
    x: tx + (parseFloat(m.style.left) / 100) * w,
    y: ty + (parseFloat(m.style.top) / 100) * h,
    r: m.classList.contains('static-map-start') ? START_R : PIN_R,
  }))
}

/** The mark, with its hit radius, is outside both top-corner buttons and the collapsed attribution. */
function expectClear(m: { x: number; y: number; r: number }, viewW: number, viewH: number) {
  for (const o of Object.values(overlayRects(viewW, viewH))) {
    const inside = m.x > o.x0 - m.r && m.x < o.x1 + m.r && m.y > o.y0 - m.r && m.y < o.y1 + m.r
    expect(inside, `mark at ${m.x.toFixed(1)},${m.y.toFixed(1)} under overlay ${JSON.stringify(o)}`).toBe(false)
  }
}

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

  it('keeps every pin and the start clear of the buttons and the attribution on a phone view', () => {
    stubView(375, 200)
    // A wide spread of spots so the fit is limited by both axes in turn.
    const spread = [
      spot({ id: 'n', display_name: 'North', lon: -83.3, lat: 43.2 }),
      spot({ id: 's', display_name: 'South', lon: -83.2, lat: 42.0 }),
      spot({ id: 'w', display_name: 'West', lon: -84.4, lat: 42.6 }),
      spot({ id: 'e', display_name: 'East', lon: -82.6, lat: 42.5 }),
    ]
    for (const spots of [spread, CORNERS, SPOTS]) {
      const { container, unmount } = renderMap({ spots })
      const marks = markPositions(container)
      expect(marks.length).toBe(spots.length + 1)
      for (const m of marks) {
        expect(m.x).toBeGreaterThanOrEqual(FIT_INSET - 1e-6)
        expect(m.x).toBeLessThanOrEqual(375 - FIT_INSET + 1e-6)
        expect(m.y).toBeGreaterThanOrEqual(FIT_INSET - 1e-6)
        expect(m.y).toBeLessThanOrEqual(200 - FIT_INSET + 1e-6)
        expectClear(m, 375, 200)
      }
      unmount()
    }
  })

  it('uses most of a phone mini map height while keeping pins clear of the corner buttons and attribution', () => {
    stubView(358, 198)
    // Three spots about 1 degree apart north to south, plus the start.
    const spots = [
      spot({ id: 'n', display_name: 'North', lon: -83.2, lat: 43.0 }),
      spot({ id: 'm', display_name: 'Middle', lon: -83.0, lat: 42.5 }),
      spot({ id: 's', display_name: 'South', lon: -83.3, lat: 42.0 }),
    ]
    const { container } = renderMap({ spots })
    const marks = markPositions(container)
    expect(marks).toHaveLength(4)
    const ys = marks.map((m) => m.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(0.6 * 198)
    for (const m of marks) expectClear(m, 358, 198)
  })

  it('switching to red mounts fresh images instead of keeping the normal picture on screen', () => {
    stubView(400, 300)
    const { container, props, rerender } = renderMap()
    const [base, glowImg] = [...container.querySelectorAll('img')]
    rerender(<StaticMap {...props} red />)
    expect(base.isConnected).toBe(false)
    expect(glowImg.isConnected).toBe(false)
    for (const s of srcs(container)) expect(s).toContain('_red_')
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
    expect(baseSrcs(container).at(-1)).toMatch(/\/base_1750\.webp$/)
  })

  it('a tighter framing upgrades the width; the old picture stays until the new one loads', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: CORNERS })
    const [old] = baseImgs(container)
    expect(old.getAttribute('src')).toMatch(/\/base_875\.webp$/)
    rerender(<StaticMap {...props} spots={SPOTS} />)
    // The sharper file loads on top; the one on screen stays mounted meanwhile.
    expect(old.isConnected).toBe(true)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_875\.webp$/), expect.stringMatching(/\/base_3500\.webp$/)])
    const sharper = baseImgs(container)[1]
    fireEvent.load(sharper)
    expect(old.isConnected).toBe(false)
    expect(sharper.isConnected).toBe(true)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
  })

  it('a wider framing does not downgrade the width', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
    const img = baseImgs(container)[0]
    rerender(<StaticMap {...props} spots={CORNERS} />)
    expect(baseImgs(container)).toEqual([img])
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
  })

  it('a new mode starts the width tiers over', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    rerender(<StaticMap {...props} spots={CORNERS} />)
    rerender(<StaticMap {...props} spots={CORNERS} red />)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_red_875\.webp$/)])
    expect(tileImgs(container)).toHaveLength(0)
  })

  it('glow follows the base width at level 0 (not the smallest width)', () => {
    const view = stubView(400, 300, 2)
    const { container } = renderMap({ spots: CORNERS })
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_875\.webp$/)])
    expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_875\.webp$/)])
    view.resize(1200, 900)
    for (const img of [...container.querySelectorAll('img')]) fireEvent.load(img)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_1750\.webp$/)])
    expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_1750\.webp$/)])
    expect(tileImgs(container)).toHaveLength(0)
  })

  it('a sharper glow loads on top; the glow on screen stays until it has loaded', () => {
    const view = stubView(400, 300, 2)
    const { container } = renderMap({ spots: CORNERS })
    const glowImg = () => [...container.querySelectorAll('img')].filter((i) => /\/glow_/.test(i.getAttribute('src')!))
    const [old] = glowImg()
    view.resize(1200, 900)
    expect(old.isConnected).toBe(true)
    expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_875\.webp$/), expect.stringMatching(/\/glow_1750\.webp$/)])
    fireEvent.load(glowImg()[1])
    expect(old.isConnected).toBe(false)
  })

  it('at level 1 the glow stays at the level-0 full width (no glow tiles)', () => {
    stubView(400, 300, 2)
    const { container } = renderMap({ spots: SPOTS })
    expect(tileImgs(container).length).toBeGreaterThan(0)
    expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_3500\.webp$/)])
  })

  it('a tight framing loads the visible level-1 tiles over the full level-0 picture, in the pins layer', () => {
    stubView(400, 300, 2)
    const { container } = renderMap({ spots: SPOTS })
    // Level 0 stays underneath at its full width: never a blank or partial picture.
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
    // Royal Oak and the spots sit in the south-east quarter.
    expect(tileKeys(container)).toEqual(['1_1'])
    const tile = tileImgs(container)[0]
    expect(tile.getAttribute('src')).toMatch(/\/maps\/se_mi\/base_L1_1_1\.webp$/)
    expect(tile.closest('.static-map-image')).toBe(container.querySelector('.static-map-image'))
    expect(tile.style.left).toBe('50%')
    expect(tile.style.top).toBe('50%')
    expect(tile.style.width).toBe('50%')
    expect(tile.style.height).toBe('50%')
    // Above the base picture, below the glow.
    const order = srcs(container)
    expect(order.findIndex((s) => s.includes('/base_3500'))).toBeLessThan(order.findIndex((s) => s.includes('_L1_')))
    expect(order.findIndex((s) => s.includes('_L1_'))).toBeLessThan(order.findIndex((s) => s.includes('/glow_')))
  })

  it('a tile fades in only once it has loaded', () => {
    stubView(400, 300, 2)
    const { container } = renderMap({ spots: SPOTS })
    const tile = tileImgs(container)[0]
    expect(tile.className).not.toContain('static-map-tile--loaded')
    fireEvent.load(tile)
    expect(tile.className).toContain('static-map-tile--loaded')
  })

  it('tile error keeps level 0: a failing tile stays hidden and the picture stays', () => {
    stubView(400, 300, 2)
    const { container } = renderMap({ spots: SPOTS })
    fireEvent.error(tileImgs(container)[0])
    expect(tileImgs(container).filter((t) => t.className.includes('static-map-tile--loaded'))).toHaveLength(0)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('resize keeps level and loads visible tiles', () => {
    const view = stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    expect(tileKeys(container)).toEqual(['1_1'])
    const tile = tileImgs(container)[0]
    fireEvent.load(tile)
    // A smaller view alone would pick level 0: the level stays, the loaded tile stays.
    view.resize(200, 150)
    expect(tileImgs(container)).toContain(tile)
    expect(tile.className).toContain('static-map-tile--loaded')
    // The whole picture in view: every tile it now shows loads, still at level 1.
    rerender(<StaticMap {...props} spots={CORNERS} />)
    expect([...tileKeys(container)].sort()).toEqual(['0_0', '0_1', '1_0', '1_1'])
    expect(tileImgs(container)).toContain(tile)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
  })

  it('red mode at level 1 requests only _red tile files', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    expect(tileImgs(container)).toHaveLength(1)
    rerender(<StaticMap {...props} spots={SPOTS} red />)
    const tiles = tileImgs(container)
    expect(tiles).toHaveLength(1)
    expect(tiles[0].getAttribute('src')).toMatch(/\/base_red_L1_1_1\.webp$/)
    for (const s of srcs(container)) expect(s).toContain('_red_')
  })

  it('old manifest works at level 0: a v1 manifest never asks for tiles', () => {
    stubView(1200, 900, 3)
    const { levels: _l, tiles: _t, ...v1 } = READY.manifest!
    hook.value = { ...READY, manifest: v1 }
    const { container } = renderMap({ spots: SPOTS })
    expect(tileImgs(container)).toHaveLength(0)
    expect(srcs(container).filter((s) => s.includes('_L'))).toEqual([])
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
    expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_3500\.webp$/)])
  })

  it('selected pin is pressed', () => {
    stubView(400, 300)
    renderMap({ selectedId: 's1' })
    expect(screen.getByRole('button', { name: 'Lake Park Beach' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Hidden Lake' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('the status region stays mounted and gets the unavailable text', () => {
    stubView(400, 300)
    const { props, rerender } = renderMap()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('')
    hook.value = { manifest: null, labels: [], status: 'error' }
    rerender(<StaticMap {...props} />)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Map unavailable right now')
  })

  it('a broken picture retries when the start changes', () => {
    stubView(400, 300)
    const { container, props, rerender } = renderMap()
    fireEvent.error(baseImgs(container)[0])
    expect(screen.getByRole('status')).toHaveTextContent('Map unavailable right now')
    expect(container.querySelectorAll('img')).toHaveLength(0)
    rerender(<StaticMap {...props} start={{ lon: -83.2, lat: 42.45 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(baseImgs(container)).toHaveLength(1)
  })

  it('a broken glow hides the glow; the toggle then retries it', () => {
    stubView(400, 300)
    const { container, props } = renderMap({ glow: true })
    const glowImg = () => [...container.querySelectorAll('img')].find((i) => i.getAttribute('src')!.includes('/glow_'))
    fireEvent.error(glowImg()!)
    expect(glowImg()).toBeUndefined()
    const toggle = screen.getByRole('button', { name: 'Light pollution glow' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(props.onToggleGlow).not.toHaveBeenCalled()
    expect(glowImg()).toBeDefined()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('attribution is one line with an info button that expands it', () => {
    stubView(400, 300)
    const { container } = renderMap()
    const btn = screen.getByRole('button', { name: 'Map data sources' })
    const box = container.querySelector('.static-map-attribution')!
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(box.className).not.toContain('static-map-attribution--open')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(box.className).toContain('static-map-attribution--open')
  })

  it('labels never overlap a pin or the start', () => {
    stubView(400, 300)
    // A label right on the selected pin is dropped; one clear of every pin stays.
    hook.value = {
      ...READY,
      labels: [
        { name: 'Pinned', lon: -83.5, lat: 42.5, rank: 1 },
        { name: 'Started', lon: -83.14, lat: 42.49, rank: 2 },
        { name: 'Clear', lon: -83.3, lat: 42.65, rank: 3 },
      ],
    }
    renderMap({ selectedId: 's1' })
    expect(screen.queryByText('Pinned')).toBeNull()
    expect(screen.queryByText('Started')).toBeNull()
    expect(screen.getByText('Clear')).toBeInTheDocument()
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

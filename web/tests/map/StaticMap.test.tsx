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
      files: {
        base: 'base_{w}.webp',
        base_red: 'base_red_{w}.webp',
        base_glow: 'base_glow_{w}.webp',
        base_glow_red: 'base_glow_red_{w}.webp',
      },
      labels: 'labels.json',
      levels: [
        { level: 0, cols: 1, rows: 1 },
        { level: 1, cols: 2, rows: 2 },
      ],
      tiles: {
        base: 'base_L{l}_{c}_{r}.webp',
        base_red: 'base_red_L{l}_{c}_{r}.webp',
        base_glow: 'base_glow_L{l}_{c}_{r}.webp',
        base_glow_red: 'base_glow_red_L{l}_{c}_{r}.webp',
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
/** An older (v2) manifest: a separate transparent glow picture laid over the base at level 0, base tiles only. */
const LEGACY = {
  ...READY,
  manifest: {
    ...READY.manifest!,
    files: { base: 'base_{w}.webp', base_red: 'base_red_{w}.webp', glow: 'glow_{w}.webp', glow_red: 'glow_red_{w}.webp' },
    tiles: { base: 'base_L{l}_{c}_{r}.webp', base_red: 'base_red_L{l}_{c}_{r}.webp' },
  },
}

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
/** The whole level-0 pictures (base or base_glow, normal or red), in DOM order: the one on screen, then any loading. */
const baseImgs = (c: HTMLElement) =>
  [...c.querySelectorAll('img')].filter((i) => /\/base(_glow)?(_red)?_\d+\.webp$/.test(i.getAttribute('src') ?? ''))
const baseSrcs = (c: HTMLElement) => baseImgs(c).map((i) => i.getAttribute('src') ?? '')
/** The separate glow overlay of an older manifest. */
const glowSrcs = (c: HTMLElement) => srcs(c).filter((s) => /\/glow(_red)?_/.test(s))
/** Every picture finishes loading (in DOM order), as in a browser: sharper files replace the ones on screen. */
const settle = (c: HTMLElement) => {
  for (const img of [...c.querySelectorAll('img')]) fireEvent.load(img)
}
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
    settle(container)
    const [base] = baseImgs(container)
    rerender(<StaticMap {...props} red />)
    expect(base.isConnected).toBe(false)
    for (const s of srcs(container)) expect(s).toContain('_red_')
  })

  it('start pin is labelled', () => {
    stubView(400, 300)
    renderMap()
    expect(screen.getByRole('img', { name: 'Your start' })).toBeInTheDocument()
  })

  it('glow on shows the picture with the glow drawn in (no overlay picture); glow off shows the base', () => {
    stubView(400, 300)
    const { container, props, rerender } = renderMap({ glow: false })
    settle(container)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_\d+\.webp$/)])
    const toggle = screen.getByRole('button', { name: 'Light pollution glow' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(props.onToggleGlow).toHaveBeenCalledOnce()
    rerender(<StaticMap {...props} glow />)
    settle(container)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_\d+\.webp$/)])
    expect(glowSrcs(container)).toEqual([])
    expect(screen.getByRole('button', { name: 'Light pollution glow' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('switching the glow keeps the picture on screen until the other one has loaded', () => {
    stubView(400, 300)
    const { container, props, rerender } = renderMap({ spots: CORNERS, glow: true })
    settle(container)
    const [lit] = baseImgs(container)
    expect(lit.getAttribute('src')).toMatch(/\/base_glow_875\.webp$/)
    rerender(<StaticMap {...props} glow={false} />)
    expect(lit.isConnected).toBe(true)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_875\.webp$/), expect.stringMatching(/\/base_875\.webp$/)])
    fireEvent.load(baseImgs(container)[1])
    expect(lit.isConnected).toBe(false)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_875\.webp$/)])
    // And back on: the base stays until the glow picture has loaded.
    const [plain] = baseImgs(container)
    rerender(<StaticMap {...props} glow />)
    expect(plain.isConnected).toBe(true)
    fireEvent.load(baseImgs(container)[1])
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_875\.webp$/)])
  })

  it('switching the glow keeps the width already reached', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    settle(container)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
    rerender(<StaticMap {...props} spots={CORNERS} glow={false} />)
    settle(container)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
  })

  it('red mode uses only red files', () => {
    stubView(400, 300)
    const { container } = renderMap({ red: true })
    settle(container)
    const all = srcs(container)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_red_\d+\.webp$/)])
    for (const s of all) expect(s).toContain('_red_')
    expect(screen.getByRole('button', { name: 'Lake Park Beach' }).style.getPropertyValue('--pin')).toBe(toRed('#7FD6A0'))
  })

  it('red mode with the glow switched never shows a normal-colour picture', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS, red: true })
    for (const s of srcs(container)) expect(s).toContain('_red_')
    rerender(<StaticMap {...props} spots={SPOTS} red glow={false} />)
    for (const s of srcs(container)) expect(s).toContain('_red_')
    settle(container)
    for (const s of srcs(container)) expect(s).toContain('_red_')
  })

  it('first paint loads the smallest width first, then the chosen width on top', () => {
    stubView(400, 300, 2)
    const { container } = renderMap({ spots: SPOTS })
    // Nothing on screen yet: the quarter width comes first, the sharp one loads over it.
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_875\.webp$/), expect.stringMatching(/\/base_glow_3500\.webp$/)])
    const [small, sharp] = baseImgs(container)
    fireEvent.load(small)
    expect(small.isConnected).toBe(true)
    fireEvent.load(sharp)
    expect(small.isConnected).toBe(false)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
  })

  it('first paint at the smallest width loads just that one file', () => {
    stubView(400, 200, 2)
    const { container } = renderMap({ spots: CORNERS })
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_875\.webp$/)])
  })

  it('a failed first small picture does not blank the map: the chosen one shows alone', () => {
    stubView(400, 300, 2)
    const { container } = renderMap({ spots: SPOTS })
    const [small] = baseImgs(container)
    fireEvent.error(small)
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
    expect(screen.getByRole('button', { name: 'Light pollution glow' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('picks the smallest sharp width', () => {
    stubView(400, 200, 2)
    const { container } = renderMap({ spots: CORNERS })
    expect(layerWidth(container)).toBeLessThanOrEqual(437)
    expect(srcs(container)[0]).toMatch(/\/base_glow_875\.webp$/)
  })

  it('refits and re-chooses width on resize', () => {
    const view = stubView(400, 200, 2)
    const { container } = renderMap({ spots: CORNERS })
    const before = layerWidth(container)
    view.resize(1200, 900)
    expect(layerWidth(container)).toBeGreaterThan(before)
    expect(baseSrcs(container).at(-1)).toMatch(/\/base_glow_1750\.webp$/)
  })

  it('a tighter framing upgrades the width; the old picture stays until the new one loads', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: CORNERS })
    const [old] = baseImgs(container)
    expect(old.getAttribute('src')).toMatch(/\/base_glow_875\.webp$/)
    rerender(<StaticMap {...props} spots={SPOTS} />)
    // The sharper file loads on top; the one on screen stays mounted meanwhile.
    expect(old.isConnected).toBe(true)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_875\.webp$/), expect.stringMatching(/\/base_glow_3500\.webp$/)])
    const sharper = baseImgs(container)[1]
    fireEvent.load(sharper)
    expect(old.isConnected).toBe(false)
    expect(sharper.isConnected).toBe(true)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
  })

  it('a wider framing does not downgrade the width', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    settle(container)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
    const img = baseImgs(container)[0]
    rerender(<StaticMap {...props} spots={CORNERS} />)
    expect(baseImgs(container)).toEqual([img])
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
  })

  it('a new mode starts the width tiers over', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    rerender(<StaticMap {...props} spots={CORNERS} />)
    rerender(<StaticMap {...props} spots={CORNERS} red />)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_red_875\.webp$/)])
    expect(tileImgs(container)).toHaveLength(0)
  })

  it('a tight framing loads the visible level-1 tiles over the full level-0 picture, in the pins layer', () => {
    stubView(400, 300, 2)
    const { container } = renderMap({ spots: SPOTS })
    settle(container)
    // Level 0 stays underneath at its full width: never a blank or partial picture.
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
    // Royal Oak and the spots sit in the south-east quarter.
    expect(tileKeys(container)).toEqual(['1_1'])
    const tile = tileImgs(container)[0]
    expect(tile.getAttribute('src')).toMatch(/\/maps\/se_mi\/base_glow_L1_1_1\.webp$/)
    expect(tile.closest('.static-map-image')).toBe(container.querySelector('.static-map-image'))
    expect(tile.style.left).toBe('50%')
    expect(tile.style.top).toBe('50%')
    expect(tile.style.width).toBe('50%')
    expect(tile.style.height).toBe('50%')
    // Above the level-0 picture; no glow overlay at all.
    const order = srcs(container)
    expect(order.findIndex((s) => s.includes('/base_glow_3500'))).toBeLessThan(order.findIndex((s) => s.includes('_L1_')))
    expect(glowSrcs(container)).toEqual([])
  })

  it('glow off at level 1 loads the plain base tiles', () => {
    stubView(400, 300, 2)
    const { container } = renderMap({ spots: SPOTS, glow: false })
    expect(tileImgs(container).map((t) => t.getAttribute('src'))).toEqual([expect.stringMatching(/\/base_L1_1_1\.webp$/)])
  })

  it('switching the glow at level 1 keeps each tile on screen until its other kind has loaded', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    settle(container)
    const [lit] = tileImgs(container)
    expect(lit.className).toContain('static-map-tile--loaded')
    rerender(<StaticMap {...props} glow={false} />)
    expect(lit.isConnected).toBe(true)
    expect(lit.className).toContain('static-map-tile--loaded')
    const tiles = tileImgs(container)
    expect(tiles.map((t) => t.getAttribute('src'))).toEqual([
      expect.stringMatching(/\/base_glow_L1_1_1\.webp$/),
      expect.stringMatching(/\/base_L1_1_1\.webp$/),
    ])
    expect(tiles[1].className).not.toContain('static-map-tile--loaded')
    fireEvent.load(tiles[1])
    expect(lit.isConnected).toBe(false)
    expect(tileImgs(container)).toEqual([tiles[1]])
    expect(tiles[1].className).toContain('static-map-tile--loaded')
    // It replaces a tile that was on screen: no fade in from the picture underneath.
    expect(tiles[1].className).toContain('static-map-tile--swapped')
    expect(lit.className).not.toContain('static-map-tile--swapped')
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
    for (const img of baseImgs(container)) fireEvent.load(img)
    fireEvent.error(tileImgs(container)[0])
    expect(tileImgs(container)).toHaveLength(0)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('resize keeps level and loads visible tiles', () => {
    const view = stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    settle(container)
    expect(tileKeys(container)).toEqual(['1_1'])
    const tile = tileImgs(container)[0]
    // A smaller view alone would pick level 0: the level stays, the loaded tile stays.
    view.resize(200, 150)
    expect(tileImgs(container)).toContain(tile)
    expect(tile.className).toContain('static-map-tile--loaded')
    // The whole picture in view: every tile it now shows loads, still at level 1.
    rerender(<StaticMap {...props} spots={CORNERS} />)
    expect([...tileKeys(container)].sort()).toEqual(['0_0', '0_1', '1_0', '1_1'])
    expect(tileImgs(container)).toContain(tile)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_glow_3500\.webp$/)])
  })

  it('red mode at level 1 requests only _red tile files', () => {
    stubView(400, 300, 2)
    const { container, props, rerender } = renderMap({ spots: SPOTS })
    expect(tileImgs(container)).toHaveLength(1)
    rerender(<StaticMap {...props} spots={SPOTS} red />)
    const tiles = tileImgs(container)
    expect(tiles).toHaveLength(1)
    expect(tiles[0].getAttribute('src')).toMatch(/\/base_glow_red_L1_1_1\.webp$/)
    for (const s of srcs(container)) expect(s).toContain('_red_')
  })

  it('a broken glow picture falls back to the base and unpresses the toggle; the toggle then retries it', () => {
    stubView(400, 300)
    const { container, props } = renderMap({ spots: CORNERS, glow: true })
    const [lit] = baseImgs(container)
    fireEvent.error(lit)
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(baseSrcs(container).at(-1)).toMatch(/\/base_875\.webp$/)
    const toggle = screen.getByRole('button', { name: 'Light pollution glow' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    settle(container)
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_875\.webp$/)])
    fireEvent.click(toggle)
    expect(props.onToggleGlow).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(baseSrcs(container).at(-1)).toMatch(/\/base_glow_875\.webp$/)
  })

  it('a glow picture that fails to load over the base unpresses the toggle and keeps the base', () => {
    stubView(400, 300)
    const { container, props, rerender } = renderMap({ spots: CORNERS, glow: false })
    settle(container)
    rerender(<StaticMap {...props} glow />)
    fireEvent.error(baseImgs(container)[1])
    expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_875\.webp$/)])
    expect(screen.getByRole('button', { name: 'Light pollution glow' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  describe('older manifest (separate glow overlay)', () => {
    it('lays the level-0 glow picture over the base', () => {
      stubView(400, 300)
      hook.value = LEGACY
      const { container } = renderMap({ spots: CORNERS })
      expect(srcs(container)).toEqual([expect.stringMatching(/\/base_875\.webp$/), expect.stringMatching(/\/glow_875\.webp$/)])
    })

    it('glow follows the base width at level 0; at level 1 it stays at the level-0 full width over base tiles', () => {
      const view = stubView(400, 300, 2)
      hook.value = LEGACY
      const { container, props, rerender } = renderMap({ spots: CORNERS })
      expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_875\.webp$/)])
      view.resize(1200, 900)
      settle(container)
      expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_1750\.webp$/)])
      expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_1750\.webp$/)])
      rerender(<StaticMap {...props} spots={SPOTS} />)
      settle(container)
      expect(tileImgs(container).map((t) => t.getAttribute('src'))).toEqual([expect.stringMatching(/\/base_L1_1_1\.webp$/)])
      expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_3500\.webp$/)])
      const order = srcs(container)
      expect(order.findIndex((s) => s.includes('_L1_'))).toBeLessThan(order.findIndex((s) => s.includes('/glow_')))
    })

    it('red mode uses the red base and red glow only', () => {
      stubView(400, 300)
      hook.value = LEGACY
      const { container } = renderMap({ spots: CORNERS, red: true })
      expect(srcs(container)).toEqual([expect.stringMatching(/\/base_red_875\.webp$/), expect.stringMatching(/\/glow_red_875\.webp$/)])
    })

    it('a broken glow hides the glow; the toggle then retries it', () => {
      stubView(400, 300)
      hook.value = LEGACY
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

    it('a v1 manifest never asks for tiles', () => {
      stubView(1200, 900, 3)
      const { levels: _l, tiles: _t, ...v1 } = LEGACY.manifest
      hook.value = { ...LEGACY, manifest: v1 }
      const { container } = renderMap({ spots: SPOTS })
      settle(container)
      expect(tileImgs(container)).toHaveLength(0)
      expect(srcs(container).filter((s) => s.includes('_L'))).toEqual([])
      expect(baseSrcs(container)).toEqual([expect.stringMatching(/\/base_3500\.webp$/)])
      expect(glowSrcs(container)).toEqual([expect.stringMatching(/\/glow_3500\.webp$/)])
    })
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
    const { container, props, rerender } = renderMap({ glow: false })
    settle(container)
    fireEvent.error(baseImgs(container)[0])
    expect(screen.getByRole('status')).toHaveTextContent('Map unavailable right now')
    expect(container.querySelectorAll('img')).toHaveLength(0)
    rerender(<StaticMap {...props} start={{ lon: -83.2, lat: 42.45 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('')
    settle(container)
    expect(baseImgs(container)).toHaveLength(1)
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

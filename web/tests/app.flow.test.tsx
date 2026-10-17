import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { resetWarmupForTests } from '../src/api/queries'
import * as client from '../src/api/client'
import { ApiError } from '../src/api/client'
import type { Region, Spot, SpotsResponse } from '../src/api/types'
import type { MapViewProps } from '../src/map/MapView'

// maplibre-gl does not run in jsdom: replace MapView with a stub that exposes its props.
const mapProps: { current: MapViewProps | null } = { current: null }
vi.mock('../src/map/MapView', () => ({
  MapView: (p: MapViewProps) => {
    mapProps.current = p
    return (
      <div data-testid="map" data-focus={p.focusRegion ?? ''} data-glow={String(p.glow)} data-pins={p.spots.length}>
        <button type="button" onClick={() => p.onSetStart({ lat: 42.3, lon: -83.4 })}>
          mock drop pin
        </button>
      </div>
    )
  },
}))

vi.mock('../src/api/client', async (orig) => {
  const actual = await orig<typeof import('../src/api/client')>()
  return {
    ...actual,
    fetchSpots: vi.fn(),
    fetchRegions: vi.fn(),
    fetchHealth: vi.fn(),
    fetchSearch: vi.fn(),
  }
})
const fetchSpots = vi.mocked(client.fetchSpots)
const fetchRegions = vi.mocked(client.fetchRegions)
const fetchHealth = vi.mocked(client.fetchHealth)
const fetchSearch = vi.mocked(client.fetchSearch)

const REGIONS: Region[] = [
  { key: 'se_mi', name: 'SE Michigan', bbox: [-84.6, 41.65, -82.4, 44.1], center: [-83.15, 42.48], zoom: 8.5, timezone: 'America/Detroit' },
  { key: 'bay_area', name: 'SF Bay Area', bbox: [-123.2, 36.4, -121.0, 38.6], center: [-122.27, 37.8], zoom: 8.5, timezone: 'America/Los_Angeles' },
]

const spot = (over: Partial<Spot> = {}): Spot => ({
  id: 's1',
  name: 'Lake Park',
  display_name: 'Lake Park Beach',
  area: 'Oakland County',
  country: 'US',
  crosses_border: false,
  recommended: false,
  sources: [],
  category: 'park',
  lon: -83.5,
  lat: 42.5,
  sqm: 21.4,
  bortle: 3,
  sky_label: 'Milky Way vivid',
  radiance: 0.2,
  glare: { buildings_1km: 3, highway_m: 800, penalty: 0.1 },
  horizon: { class: 'open', open_frac: 0.8, closed_frac: 0.1, water_frac: 0.1 },
  access: { badge: 'likely', road_class: 'service', paved: true, parking: true, note: null },
  dark_sky_place: false,
  unavailable: false,
  unavailable_reason: null,
  amenities: { restroom: null, fuel: null, food: null },
  why: [],
  drive_minutes: 45,
  drive_is_estimate: false,
  darker_than_home: '',
  scores: null,
  timeline: [],
  best_window: null,
  ...over,
})

const response = (spots: Spot[] = [spot(), spot({ id: 's2', display_name: 'Hidden Lake', drive_minutes: 60 })]): SpotsResponse => ({
  metro: 'se_mi',
  night: '2026-10-17',
  timezone: 'America/Detroit',
  start: { lat: 42.49, lon: -83.14, sqm: 19.2, sky_label: 'Faint' },
  verdict: {
    rating: 'good',
    sentence: 'Great night for stars.',
    best_window: null,
    moon: { illumination: 0.1, rise: null, set: null },
    dark: { start: '2026-10-17T20:30:00-04:00', end: '2026-10-18T06:00:00-04:00', kind: 'astronomical' },
  },
  forecast_status: 'ok',
  drive_status: 'ok',
  spots,
})

const START = '/?lat=42.49&lon=-83.14'

function go(url: string) {
  window.history.replaceState(null, '', url)
}

async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
  }
}

beforeEach(() => {
  resetWarmupForTests()
  mapProps.current = null
  fetchSpots.mockReset()
  fetchRegions.mockReset().mockResolvedValue(REGIONS)
  fetchHealth.mockReset().mockResolvedValue({ ok: true, metros: ['se_mi', 'bay_area'], release: 'test' })
  fetchSearch.mockReset().mockResolvedValue([])
  try {
    localStorage.clear()
  } catch {
    // ignore
  }
  delete document.documentElement.dataset.red
  Element.prototype.scrollIntoView = vi.fn()
  go('/')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('App flow', () => {
  it('welcome when no start', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: "Where's the closest dark sky tonight?" })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Search for a place' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeInTheDocument()
    const chip = await screen.findByRole('button', { name: 'SE Michigan' })
    expect(screen.getByRole('button', { name: 'SF Bay Area' })).toBeInTheDocument()
    fireEvent.click(chip)
    expect(screen.getByTestId('map')).toHaveAttribute('data-focus', 'se_mi')
    expect(fetchSpots).not.toHaveBeenCalled()
    expect(fetchHealth).toHaveBeenCalled()

    // Tapping the map sets a "Dropped pin" start and shows results.
    fetchSpots.mockResolvedValue(response())
    fireEvent.click(screen.getByRole('button', { name: 'mock drop pin' }))
    expect(new URLSearchParams(window.location.search).get('lat')).toBe('42.3')
    expect(await screen.findByRole('button', { name: 'Dropped pin' })).toBeInTheDocument()
    // Focus moves to the results heading.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: /Dark skies near Dropped pin/ }))
  })

  it('results render verdict and cards', async () => {
    go(START)
    fetchSpots.mockResolvedValue(
      response([
        spot({ id: 'u1', display_name: 'Closed Park', unavailable: true, unavailable_reason: 'Closed for season' }),
        spot(),
        spot({ id: 's2', display_name: 'Hidden Lake', drive_minutes: 60 }),
      ]),
    )
    render(<App />)
    expect(await screen.findByText('Great night for stars.')).toBeInTheDocument()
    const cards = document.querySelectorAll('[data-spot-id]')
    expect([...cards].map((c) => c.getAttribute('data-spot-id'))).toEqual(['s1', 's2', 'u1'])
    expect(screen.getByText('Lake Park Beach')).toBeInTheDocument()
    expect(screen.getByText(/Not available right now/)).toBeInTheDocument()
    // Reloaded start with no remembered label shows "Dropped pin".
    expect(screen.getByRole('button', { name: 'Dropped pin' })).toBeInTheDocument()
    expect(screen.getByTestId('map')).toHaveAttribute('data-pins', '3')
    expect(screen.getByRole('group', { name: 'Choose a night' })).toBeInTheDocument()
    const args = fetchSpots.mock.calls[0][0]
    expect(args).toMatchObject({ lat: 42.49, lon: -83.14, drive: 90, limit: 25 })
  })

  it('opening a card sets spot in URL', async () => {
    go(START)
    fetchSpots.mockResolvedValue(response())
    render(<App />)
    const head = await screen.findByRole('button', { name: /Hidden Lake/ })
    const before = window.history.length
    fireEvent.click(head)
    expect(new URLSearchParams(window.location.search).get('spot')).toBe('s2')
    expect(window.history.length).toBe(before + 1)
    expect(screen.getByRole('button', { name: /Hidden Lake/ })).toHaveAttribute('aria-expanded', 'true')
    expect(mapProps.current?.selectedId).toBe('s2')
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
    // Tapping its pin does the same for another spot.
    act(() => mapProps.current!.onSelect('s1'))
    expect(new URLSearchParams(window.location.search).get('spot')).toBe('s1')
    expect(screen.getByRole('button', { name: /Lake Park Beach/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('out-of-coverage start shows coverage message', async () => {
    go('/?lat=40.7&lon=-74')
    fetchSpots.mockRejectedValue(new ApiError('out_of_coverage', 422, { error: 'out_of_coverage' }))
    render(<App />)
    expect(await screen.findByText('We cover SE Michigan and the SF Bay Area so far.')).toBeInTheDocument()
    const chips = screen.getByRole('group', { name: 'Regions' })
    expect(within(chips).getByRole('button', { name: 'SE Michigan' })).toBeInTheDocument()
    fireEvent.click(within(chips).getByRole('button', { name: 'SF Bay Area' }))
    expect(window.location.search).not.toContain('lat=')
    expect(screen.getByTestId('map')).toHaveAttribute('data-focus', 'bay_area')
    const h1 = screen.getByRole('heading', { name: "Where's the closest dark sky tonight?" })
    expect(document.activeElement).toBe(h1) // focus returns to the Welcome headline
  })

  it('night_out_of_range resets to tonight', async () => {
    go(`${START}&night=2026-01-01`)
    fetchSpots.mockImplementation((p) =>
      p.night === '2026-01-01'
        ? Promise.reject(new ApiError('night_out_of_range', 422, { error: 'night_out_of_range' }))
        : Promise.resolve(response()),
    )
    const before = window.history.length
    render(<App />)
    expect(await screen.findByText('Great night for stars.')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('night')).toBeNull()
    expect(window.history.length).toBe(before) // replaced, not pushed
    const mains = fetchSpots.mock.calls.map((c) => c[0]).filter((p) => p.limit === 25)
    expect(mains[0].night).toBe('2026-01-01')
    expect(mains[1].night).toBeUndefined()
  })

  it('empty state offers widen', async () => {
    go(START)
    fetchSpots.mockResolvedValue(response([]))
    render(<App />)
    expect(await screen.findByText('Nothing within 90 min.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Widen to 120 min' }))
    expect(new URLSearchParams(window.location.search).get('drive')).toBe('120')
    expect(await screen.findByText('Nothing within 120 min.')).toBeInTheDocument()
  })

  it('empty state widen is disabled at 180', async () => {
    go(`${START}&drive=180`)
    fetchSpots.mockResolvedValue(response([]))
    render(<App />)
    expect(await screen.findByText('Nothing within 180 min.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Already at max distance' })).toBeDisabled()
  })

  it('429 shows rate-limit copy', async () => {
    go(START)
    fetchSpots.mockRejectedValue(new ApiError('rate_limited', 429, { error: 'rate_limited' }))
    render(<App />)
    expect(await screen.findByText('Too many searches — try again in a minute.')).toBeInTheDocument()
  })

  it('waking state shows Waking up copy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    go(START)
    fetchSpots.mockReturnValue(new Promise(() => {}))
    render(<App />)
    expect(screen.queryByText('Waking up the stargazing engine…')).toBeNull()
    await advance(3200)
    expect(screen.getByText('Waking up the stargazing engine…')).toBeInTheDocument()
  })

  it('invalid request shows plain copy without retry', async () => {
    go(START)
    fetchSpots.mockRejectedValue(new ApiError('invalid', 422, {}))
    render(<App />)
    expect(await screen.findByText(/didn’t look right/)).toBeInTheDocument()
    // invalid errors are not retryable; only network/5xx get the retry button
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('search pick shows the picked name as start label', async () => {
    fetchSearch.mockResolvedValue([{ name: 'Royal Oak', kind: 'Locality', lat: 42.49, lon: -83.14, metro: 'se_mi' }])
    fetchSpots.mockResolvedValue(response())
    render(<App />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'royal' } })
    fireEvent.click(await screen.findByRole('option', { name: /Royal Oak/ }))
    expect(await screen.findByRole('button', { name: 'Royal Oak' })).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('lat')).toBe('42.49')
    expect(await screen.findByText('Great night for stars.')).toBeInTheDocument()
  })

  it('entering red mode turns glow off with replace, and the user can turn it back on', async () => {
    go(START)
    fetchSpots.mockResolvedValue(response())
    render(<App />)
    await screen.findByText('Great night for stars.')
    expect(screen.getByTestId('map')).toHaveAttribute('data-glow', 'true')
    const before = window.history.length
    fireEvent.click(screen.getByRole('switch', { name: 'Red mode' }))
    expect(document.documentElement.dataset.red).toBe('true')
    await waitFor(() => expect(screen.getByTestId('map')).toHaveAttribute('data-glow', 'false'))
    expect(new URLSearchParams(window.location.search).get('glow')).toBe('0')
    expect(window.history.length).toBe(before)
    act(() => mapProps.current!.onToggleGlow())
    expect(screen.getByTestId('map')).toHaveAttribute('data-glow', 'true')
    expect(new URLSearchParams(window.location.search).get('glow')).toBeNull()
  })

  it('drive slider drag adds at most one history entry', async () => {
    go(START)
    fetchSpots.mockResolvedValue(response())
    render(<App />)
    await screen.findByText('Great night for stars.')
    const before = window.history.length
    const slider = screen.getByRole('slider')
    for (const v of ['105', '120', '135', '150']) fireEvent.change(slider, { target: { value: v } })
    fireEvent.pointerUp(slider)
    expect(new URLSearchParams(window.location.search).get('drive')).toBe('150')
    expect(window.history.length).toBe(before + 1)
  })

  it('full map is cleared when the viewport becomes desktop', async () => {
    const listeners: ((e: { matches: boolean }) => void)[] = []
    const mql = {
      matches: false,
      media: '(min-width: 900px)',
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.push(l),
      removeEventListener: vi.fn(),
    }
    const orig = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((q: string) =>
      q === '(min-width: 900px)' ? mql : { matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    ) as unknown as typeof window.matchMedia
    try {
      go(START)
      fetchSpots.mockResolvedValue(response())
      const { container } = render(<App />)
      await screen.findByText('Great night for stars.')
      fireEvent.click(screen.getByRole('button', { name: 'Full map' }))
      expect(container.querySelector('.app--map-full')).not.toBeNull()
      act(() => listeners.forEach((l) => l({ matches: true })))
      expect(container.querySelector('.app--map-full')).toBeNull()
    } finally {
      window.matchMedia = orig
    }
  })

  it('welcome locate outside coverage shows coverage message and stays on welcome', async () => {
    const geo = {
      getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) =>
        ok({ coords: { latitude: 40.7, longitude: -74 } }),
    }
    Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true })
    try {
      render(<App />)
      await screen.findByRole('button', { name: 'SE Michigan' })
      fireEvent.click(screen.getByRole('button', { name: 'Use my location' }))
      expect(screen.getByText('We cover SE Michigan and the SF Bay Area so far.')).toBeInTheDocument()
      expect(window.location.search).not.toContain('lat=')
      expect(screen.getByRole('heading', { name: "Where's the closest dark sky tonight?" })).toBeInTheDocument()
      expect(within(screen.getByRole('group', { name: 'Regions' })).getByRole('button', { name: 'SF Bay Area' })).toBeInTheDocument()
      expect(fetchSpots).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true })
    }
  })

  it('changing a filter keeps the previous results visible while refetching', async () => {
    go(START)
    let resolve!: (r: SpotsResponse) => void
    fetchSpots.mockImplementation((p) =>
      p.limit === 25 && p.sort === 'closest' ? new Promise((r) => (resolve = r)) : Promise.resolve(response()),
    )
    render(<App />)
    await screen.findByText('Great night for stars.')
    fireEvent.click(screen.getByRole('radio', { name: 'Closest' }))
    expect(screen.getByText('Lake Park Beach')).toBeInTheDocument()
    expect(screen.getByText('Great night for stars.')).toBeInTheDocument()
    await act(async () => resolve(response([spot({ id: 's9', display_name: 'Far Field' })])))
    expect(await screen.findByText('Far Field')).toBeInTheDocument()
  })
})

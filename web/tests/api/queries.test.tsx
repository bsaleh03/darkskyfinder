import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/api/client'
import * as client from '../../src/api/client'
import {
  makeQueryClient,
  resetSpotsBudgetForTests,
  useNightDots,
  useRegions,
  useSearch,
  useSpots,
  useStartupWaking,
  useWarmup,
} from '../../src/api/queries'
import { METROS } from '../../src/config'
import type { AppState } from '../../src/state/useAppState'

vi.mock('../../src/api/client', async (orig) => {
  const actual = await orig<typeof import('../../src/api/client')>()
  return { ...actual, fetchSpots: vi.fn(), fetchSearch: vi.fn(), fetchHealth: vi.fn(), fetchRegions: vi.fn() }
})

const fetchSpots = vi.mocked(client.fetchSpots)
const fetchSearch = vi.mocked(client.fetchSearch)
const fetchHealth = vi.mocked(client.fetchHealth)
const fetchRegions = vi.mocked(client.fetchRegions)

const state: AppState = {
  start: { lat: 42.3, lon: -83.1 },
  night: null,
  drive: 90,
  sort: 'relevant',
  access: 'all',
  border: 'include',
  stateBorder: 'include',
  glow: true,
  spot: null,
}

function resp(rating = 'good', night?: string) {
  return { night, verdict: { rating }, spots: [] } as unknown as Awaited<ReturnType<typeof client.fetchSpots>>
}

function wrapper() {
  const qc = makeQueryClient()
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

// Advance in small steps so React can render (and start follow-up requests) between timers.
async function settle(total: number, step = 50) {
  for (let t = 0; t < total; t += step) await tick(step)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  fetchSpots.mockReset()
  fetchSearch.mockReset()
  fetchHealth.mockReset()
  fetchRegions.mockReset()
  resetSpotsBudgetForTests()
})
afterEach(() => vi.useRealTimers())

describe('useSpots', () => {
  it('retries through cold start and exposes waking state', async () => {
    fetchSpots
      .mockRejectedValueOnce(new ApiError('network'))
      .mockRejectedValueOnce(new ApiError('network'))
      .mockResolvedValueOnce(resp())
    const { result } = renderHook(() => useSpots(state), { wrapper: wrapper() })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.waking).toBe(false)
    await tick(100)
    expect(fetchSpots).toHaveBeenCalledTimes(1)
    expect(result.current.waking).toBe(true)
    await tick(1000)
    expect(fetchSpots).toHaveBeenCalledTimes(2)
    expect(result.current.waking).toBe(true)
    await tick(2000)
    expect(fetchSpots).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.waking).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it('is waking after a request is pending more than 3 s', async () => {
    fetchSpots.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useSpots(state), { wrapper: wrapper() })
    await tick(2900)
    expect(result.current.waking).toBe(false)
    await tick(200)
    expect(result.current.waking).toBe(true)
  })

  it('gives up after the backoff schedule with the error', async () => {
    fetchSpots.mockRejectedValue(new ApiError('server', 503))
    const { result } = renderHook(() => useSpots(state), { wrapper: wrapper() })
    await tick(62_000)
    expect(fetchSpots).toHaveBeenCalledTimes(7)
    expect(result.current.error?.kind).toBe('server')
    expect(result.current.waking).toBe(false)
  })

  it('does not retry 4xx', async () => {
    fetchSpots.mockRejectedValue(new ApiError('out_of_coverage', 422))
    const { result } = renderHook(() => useSpots(state), { wrapper: wrapper() })
    await tick(5000)
    expect(fetchSpots).toHaveBeenCalledTimes(1)
    expect(result.current.error?.kind).toBe('out_of_coverage')
    expect(result.current.waking).toBe(false)
  })

  it('is disabled without a start and requests limit 25', async () => {
    const { result } = renderHook(() => useSpots({ ...state, start: null }), { wrapper: wrapper() })
    await tick(100)
    expect(fetchSpots).not.toHaveBeenCalled()
    expect(result.current.isLoading).toBe(false)
    fetchSpots.mockResolvedValue(resp())
    renderHook(() => useSpots(state), { wrapper: wrapper() })
    await waitFor(() => expect(fetchSpots).toHaveBeenCalled())
    expect(fetchSpots.mock.calls[0][0]).toMatchObject({ lat: 42.3, lon: -83.1, limit: 25, drive: 90 })
  })
})

describe('useNightDots', () => {
  it('maps ratings and caps concurrency at 2', async () => {
    const nights = ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']
    const ratings: Record<string, string> = {
      '2026-10-17': 'good',
      '2026-10-18': 'marginal',
      '2026-10-19': 'poor',
      '2026-10-20': 'unknown',
      '2026-10-21': 'good',
    }
    let inflight = 0
    let peak = 0
    fetchSpots.mockImplementation(async (p) => {
      if (p.limit === 25) return resp()
      expect(p.limit).toBe(3)
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 200))
      inflight--
      return resp(ratings[p.night!])
    })
    const { result } = renderHook(() => useNightDots(state, nights), { wrapper: wrapper() })
    expect(result.current['2026-10-17']).toBeUndefined()
    await settle(2000)
    expect(peak).toBe(2)
    expect(result.current).toEqual({
      '2026-10-17': 'go',
      '2026-10-18': 'maybe',
      '2026-10-19': 'no',
      '2026-10-20': 'no',
      '2026-10-21': 'go',
    })
  })

  it('does not start until the main spots request succeeds', async () => {
    let release!: () => void
    fetchSpots.mockImplementation((p) =>
      p.limit === 25
        ? new Promise((res) => {
            release = () => res(resp())
          })
        : Promise.resolve(resp()),
    )
    renderHook(() => useNightDots(state, ['2026-10-17']), { wrapper: wrapper() })
    await tick(500)
    expect(fetchSpots).toHaveBeenCalledTimes(1)
    release()
    await tick(100)
    expect(fetchSpots).toHaveBeenCalledTimes(2)
  })
})

describe('useNightDots requests', () => {
  const nights = ['2026-10-17', '2026-10-18', '2026-10-19']
  const dotCalls = () => fetchSpots.mock.calls.filter((c) => c[0].limit === 3).map((c) => c[0])

  it('takes the selected night from the main response and ignores sort', async () => {
    fetchSpots.mockImplementation(async (p) => resp('good', p.night ?? '2026-10-17'))
    const { result, rerender } = renderHook(({ s }) => useNightDots(s, nights), {
      wrapper: wrapper(),
      initialProps: { s: state },
    })
    await settle(500)
    // Tonight's dot comes from the main (night-less) request; only the other nights are fetched.
    expect(dotCalls().map((p) => p.night)).toEqual(['2026-10-18', '2026-10-19'])
    expect(dotCalls()[0]).not.toHaveProperty('sort')
    expect(result.current['2026-10-17']).toBe('go')
    rerender({ s: { ...state, sort: 'closest' } })
    await settle(500)
    expect(fetchSpots.mock.calls.filter((c) => c[0].limit === 25)).toHaveLength(2)
    expect(dotCalls()).toHaveLength(2) // sort does not change the verdict
    rerender({ s: { ...state, sort: 'closest', drive: 120 } })
    await settle(500)
    expect(dotCalls()).toHaveLength(4)
  })

  it('state_border flows into spots and dot queries', async () => {
    fetchSpots.mockImplementation(async (p) => resp('good', p.night ?? '2026-10-17'))
    const { rerender } = renderHook(({ s }) => useNightDots(s, nights), {
      wrapper: wrapper(),
      initialProps: { s: state },
    })
    await settle(500)
    expect(fetchSpots.mock.calls.every((c) => c[0].stateBorder === 'include')).toBe(true)
    fetchSpots.mockClear()
    rerender({ s: { ...state, stateBorder: 'exclude' } })
    await settle(500)
    const calls = fetchSpots.mock.calls.map((c) => c[0])
    expect(calls.filter((p) => p.limit === 25)).toHaveLength(1) // new key: refetched
    expect(calls.filter((p) => p.limit === 3).length).toBeGreaterThan(0) // dots refetched too
    expect(calls.every((p) => p.stateBorder === 'exclude')).toBe(true)
  })

  it('leaves headroom under the API rate limit, finishing the rest a minute later', async () => {
    const many = Array.from({ length: 16 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)
    fetchSpots.mockImplementation(async () => resp())
    renderHook(() => useNightDots(state, many), { wrapper: wrapper() })
    await settle(1000)
    expect(fetchSpots).toHaveBeenCalledTimes(12) // 1 main + 11 dots
    await settle(60_000, 1000)
    expect(fetchSpots).toHaveBeenCalledTimes(17)
  })
})

describe('regions and start-up', () => {
  it('uses the static metros until the API answers, and retries a failure later', async () => {
    fetchRegions.mockRejectedValue(new ApiError('invalid', 400))
    const { result } = renderHook(() => useRegions(), { wrapper: wrapper() })
    expect(result.current.map((r) => r.key).sort()).toEqual(['bay_area', 'se_mi'])
    expect(result.current).toBe(METROS)
    await tick(100)
    expect(fetchRegions).toHaveBeenCalledTimes(1)
    const api = [{ ...METROS[0], name: 'Renamed' }]
    fetchRegions.mockResolvedValue(api)
    await settle(31_000, 500)
    expect(fetchRegions).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual(api)
  })

  it('is waking while health or regions are pending for more than 3 s', async () => {
    let answer!: () => void
    fetchHealth.mockImplementation(() => new Promise((r) => (answer = () => r({ ok: true, metros: [], release: 'x' }))))
    fetchRegions.mockResolvedValue(METROS)
    const { result } = renderHook(
      () => {
        useWarmup()
        useRegions()
        return useStartupWaking()
      },
      { wrapper: wrapper() },
    )
    await tick(2900)
    expect(result.current).toBe(false)
    await tick(200)
    expect(result.current).toBe(true)
    await act(async () => answer())
    await tick(10)
    expect(result.current).toBe(false)
  })
})

describe('useSearch', () => {
  it('waits for 2 chars and debounces', async () => {
    fetchSearch.mockResolvedValue([])
    const { result, rerender } = renderHook(({ q }) => useSearch(q), {
      wrapper: wrapper(),
      initialProps: { q: 'r' },
    })
    await tick(500)
    expect(fetchSearch).not.toHaveBeenCalled()
    expect(result.current.hits).toEqual([])
    for (const q of ['ro', 'roy', 'roya']) {
      rerender({ q })
      await tick(100)
    }
    expect(fetchSearch).not.toHaveBeenCalled()
    await tick(300)
    expect(fetchSearch).toHaveBeenCalledTimes(1)
    expect(fetchSearch.mock.calls[0][0]).toBe('roya')
  })

  it('ignores out-of-order search responses', async () => {
    type Hits = Awaited<ReturnType<typeof client.fetchSearch>>
    const hit = (name: string): Hits => [{ name, kind: 'city', lat: 1, lon: 2, metro: 'se_mi', source: 'overture' }]
    const resolvers: Record<string, (v: Hits) => void> = {}
    fetchSearch.mockImplementation(
      (q) =>
        new Promise<Hits>((res) => {
          resolvers[q] = res
        }),
    )
    const { result, rerender } = renderHook(({ q }) => useSearch(q), {
      wrapper: wrapper(),
      initialProps: { q: 'roy' },
    })
    await tick(300)
    rerender({ q: 'roya' })
    await tick(300)
    expect(fetchSearch).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(true)
    resolvers['roya'](hit('Royal Oak'))
    await tick(10)
    resolvers['roy'](hit('Roy (stale)'))
    await tick(10)
    expect(result.current.hits.map((h) => h.name)).toEqual(['Royal Oak'])
    expect(result.current.loading).toBe(false)
  })

  it('aborts the previous request', async () => {
    const signals: (AbortSignal | undefined)[] = []
    fetchSearch.mockImplementation((_q, signal) => {
      signals.push(signal)
      return new Promise(() => {})
    })
    const { rerender } = renderHook(({ q }) => useSearch(q), { wrapper: wrapper(), initialProps: { q: 'roy' } })
    await tick(300)
    rerender({ q: 'roya' })
    await tick(300)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
  })
})

describe('useWarmup', () => {
  it('fires health once and ignores errors', async () => {
    fetchHealth.mockRejectedValue(new ApiError('network'))
    const w = wrapper()
    const a = renderHook(() => useWarmup(), { wrapper: w })
    a.rerender()
    renderHook(() => useWarmup(), { wrapper: w })
    await tick(100)
    expect(fetchHealth).toHaveBeenCalledTimes(1)
  })
})

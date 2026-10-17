import { QueryClient, useIsFetching, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { METROS } from '../config'
import type { AppState } from '../state/useAppState'
import { ApiError, fetchHealth, fetchRegions, fetchSearch, fetchSpots } from './client'
import type { Rating, Region, SearchHit, SpotsParams, SpotsResponse } from './types'

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]
const WAKING_AFTER_MS = 3000
const DOT_CONCURRENCY = 2
const SEARCH_DEBOUNCE_MS = 250
// The API allows 20 /spots requests per minute per client. Background night-dot requests only go out
// while fewer than DOT_BUDGET /spots requests were made in the last minute, keeping the rest for the
// user's own changes; dots over budget wait for the window to free up.
const SPOTS_WINDOW_MS = 60_000
const DOT_BUDGET = 12
const REGIONS_RETRY_MS = 30_000

function isRetryable(e: unknown): boolean {
  return e instanceof ApiError && (e.kind === 'server' || e.kind === 'network')
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  })
}

// ---- /spots request budget ----

let spotsLog: number[] = []

function noteSpotsCall() {
  spotsLog.push(Date.now())
}

function recentSpotsCalls(now: number): number {
  spotsLog = spotsLog.filter((t) => now - t < SPOTS_WINDOW_MS)
  return spotsLog.length
}

export function resetSpotsBudgetForTests() {
  spotsLog = []
}

/** Resolves once a background request fits in the budget, counting it right away (no check-then-act race). */
function dotBudget(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const check = () => {
      if (signal?.aborted) return abort()
      const now = Date.now()
      if (recentSpotsCalls(now) < DOT_BUDGET) {
        signal?.removeEventListener('abort', abort)
        noteSpotsCall()
        return resolve()
      }
      timer = setTimeout(check, spotsLog[0] + SPOTS_WINDOW_MS - now + 1)
    }
    signal?.addEventListener('abort', abort, { once: true })
    check()
  })
}

// ---- spots ----

function spotsParams(s: AppState): SpotsParams {
  return {
    lat: s.start!.lat,
    lon: s.start!.lon,
    night: s.night ?? undefined,
    drive: s.drive,
    sort: s.sort,
    access: s.access,
    border: s.border,
    limit: 25,
  }
}

/** The night verdict depends on these only (not on sort or limit). */
const dotKey = (s: AppState, night: string) => ['dot', s.start, night, s.drive, s.access, s.border]

function useSpotsQuery(s: AppState) {
  const qc = useQueryClient()
  return useQuery<SpotsResponse, ApiError>({
    queryKey: ['spots', s.start, s.night, s.drive, s.sort, s.access, s.border],
    queryFn: async ({ signal }) => {
      noteSpotsCall()
      const r = await fetchSpots(spotsParams(s), signal)
      // The night shown already carries its verdict: that night's dot needs no request of its own.
      if (r.night && r.verdict) qc.setQueryData(dotKey(s, r.night), r.verdict.rating)
      return r
    },
    enabled: s.start !== null,
    // Keep the previous result on screen while filters change, but never carry
    // one start's spots over to a different start.
    placeholderData: (prev, prevQuery) =>
      prevQuery && JSON.stringify(prevQuery.queryKey[1]) === JSON.stringify(s.start) ? prev : undefined,
    retry: (failureCount, err) => isRetryable(err) && failureCount < RETRY_DELAYS_MS.length,
    // failureCount is 0-based: delay before the first retry is index 0
    retryDelay: (failureCount) => RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)],
  })
}

/** Becomes true once `active` has stayed true for 3 s. */
function useSlow(active: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), WAKING_AFTER_MS)
    return () => clearTimeout(t)
  }, [active])
  return active && slow
}

export function useSpots(s: AppState): {
  data?: SpotsResponse
  error?: ApiError
  isLoading: boolean
  waking: boolean
  /** `data` belongs to other params: the previous ones while the new ones load, or after a 429. */
  stale: boolean
  refetch: () => void
} {
  const q = useSpotsQuery(s)
  const loading = q.isLoading
  const slow = useSlow(loading)
  // Last good result for this start, kept on screen when a request is rate limited.
  const lastGood = useRef<{ start: string; data: SpotsResponse } | null>(null)
  const startKey = JSON.stringify(s.start)
  if (q.data && !q.isPlaceholderData) lastGood.current = { start: startKey, data: q.data }
  const kept =
    q.error?.kind === 'rate_limited' && lastGood.current?.start === startKey ? lastGood.current.data : undefined
  const retrying = q.isFetching && q.failureCount > 0 && isRetryable(q.failureReason)
  return {
    data: q.data ?? kept,
    error: q.error ?? undefined,
    isLoading: loading,
    waking: slow || retrying,
    stale: q.isPlaceholderData || kept !== undefined,
    refetch: () => void q.refetch(),
  }
}

// ---- night dots ----

export type Dot = 'go' | 'maybe' | 'no'

const DOT: Record<Rating, Dot> = { good: 'go', marginal: 'maybe', poor: 'no', unknown: 'no' }

// Shared limiter: at most DOT_CONCURRENCY dot requests in flight at once.
let active = 0
const waiters: (() => void)[] = []

function acquire(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const i = waiters.indexOf(grant)
      if (i >= 0) waiters.splice(i, 1)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const grant = () => {
      signal?.removeEventListener('abort', abort)
      active++
      resolve()
    }
    if (signal?.aborted) return abort()
    if (active < DOT_CONCURRENCY) return grant()
    waiters.push(grant)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function release() {
  active--
  waiters.shift()?.()
}

export function useNightDots(s: AppState, nights: string[]): Record<string, Dot | undefined> {
  const main = useSpotsQuery(s)
  const ready = main.isSuccess && !main.isPlaceholderData
  const results = useQueries({
    queries: nights.map((night) => ({
      queryKey: dotKey(s, night),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        await acquire(signal)
        try {
          await dotBudget(signal)
          const { sort: _sort, ...params } = spotsParams(s)
          const r = await fetchSpots({ ...params, night, limit: 3 }, signal)
          return r.verdict.rating
        } finally {
          release()
        }
      },
      enabled: ready && s.start !== null,
      retry: false,
    })),
  })
  const ratings = results.map((r) => r.data ?? '').join('|')
  return useMemo(() => {
    const out: Record<string, Dot | undefined> = {}
    ratings.split('|').forEach((rating, i) => {
      out[nights[i]] = rating ? DOT[rating as Rating] : undefined
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratings, nights.join('|')])
}

// ---- search ----

export function useSearch(q: string): { hits: SearchHit[]; loading: boolean } {
  const term = q.trim()
  const enough = term.length >= 2
  const [debounced, setDebounced] = useState(term)
  useEffect(() => {
    if (!enough) {
      setDebounced(term)
      return
    }
    const t = setTimeout(() => setDebounced(term), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [term, enough])
  const settled = enough && debounced === term
  const query = useQuery<SearchHit[], ApiError>({
    // Key scoped to the term: a late response for an older term lands in its own
    // cache entry and is never shown. Key changes also abort the old request.
    queryKey: ['search', debounced],
    queryFn: ({ signal }) => fetchSearch(debounced, signal),
    enabled: enough && debounced.length >= 2,
    retry: false,
  })
  if (!enough) return { hits: [], loading: false }
  return {
    hits: settled ? (query.data ?? []) : [],
    loading: !settled || query.isFetching,
  }
}

// ---- regions ----

/** Coverage regions: the static metros right away, replaced by /api/regions once it answers. */
export function useRegions(): Region[] {
  const q = useQuery<Region[], ApiError>({
    queryKey: ['regions'],
    queryFn: () => fetchRegions(),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: (failureCount, err) => isRetryable(err) && failureCount < 3,
    // A failed load is tried again later instead of staying failed for the session.
    refetchInterval: (query) => (query.state.status === 'error' ? REGIONS_RETRY_MS : false),
  })
  return q.data ?? METROS
}

// ---- warm-up ----

/** Pings /api/health once per session so a sleeping API starts waking before the first search. */
export function useWarmup(): void {
  useQuery({
    queryKey: ['health'],
    queryFn: () => fetchHealth(),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
}

/** True once the health ping or the regions request has been pending for more than 3 s. */
export function useStartupWaking(): boolean {
  const n = useIsFetching({ predicate: (q) => q.queryKey[0] === 'health' || q.queryKey[0] === 'regions' })
  return useSlow(n > 0)
}

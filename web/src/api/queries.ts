import { QueryClient, useQueries, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { AppState } from '../state/useAppState'
import { ApiError, fetchHealth, fetchRegions, fetchSearch, fetchSpots } from './client'
import type { Rating, Region, SearchHit, SpotsParams, SpotsResponse } from './types'

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]
const WAKING_AFTER_MS = 3000
const DOT_CONCURRENCY = 2
const SEARCH_DEBOUNCE_MS = 250

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

// ---- spots ----

function spotsParams(s: AppState, over?: Partial<SpotsParams>): SpotsParams {
  return {
    lat: s.start!.lat,
    lon: s.start!.lon,
    night: s.night ?? undefined,
    drive: s.drive,
    sort: s.sort,
    access: s.access,
    border: s.border,
    limit: 25,
    ...over,
  }
}

function useSpotsQuery(s: AppState) {
  return useQuery<SpotsResponse, ApiError>({
    queryKey: ['spots', s.start, s.night, s.drive, s.sort, s.access, s.border],
    queryFn: ({ signal }) => fetchSpots(spotsParams(s), signal),
    enabled: s.start !== null,
    retry: (failureCount, err) => isRetryable(err) && failureCount < RETRY_DELAYS_MS.length,
    // failureCount is 0-based: delay before the first retry is index 0
    retryDelay: (failureCount) => RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)],
  })
}

export function useSpots(s: AppState): {
  data?: SpotsResponse
  error?: ApiError
  isLoading: boolean
  waking: boolean
} {
  const q = useSpotsQuery(s)
  const loading = q.isLoading
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), WAKING_AFTER_MS)
    return () => clearTimeout(t)
  }, [loading])
  const retrying = q.isFetching && q.failureCount > 0 && isRetryable(q.failureReason)
  return {
    data: q.data,
    error: q.error ?? undefined,
    isLoading: loading,
    waking: (loading && slow) || retrying,
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
  const ready = useSpotsQuery(s).isSuccess
  const results = useQueries({
    queries: nights.map((night) => ({
      queryKey: ['dot', s.start, night, s.drive, s.sort, s.access, s.border],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        await acquire(signal)
        try {
          const r = await fetchSpots(spotsParams(s, { night, limit: 3 }), signal)
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

const NO_REGIONS: Region[] = []

/** Coverage regions, fetched once and cached for the session. */
export function useRegions(): Region[] {
  const q = useQuery<Region[], ApiError>({
    queryKey: ['regions'],
    queryFn: () => fetchRegions(),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: (failureCount, err) => isRetryable(err) && failureCount < 3,
  })
  return q.data ?? NO_REGIONS
}

// ---- warm-up ----

let warmed = false

export function resetWarmupForTests() {
  warmed = false
}

export function useWarmup(): void {
  useEffect(() => {
    if (warmed) return
    warmed = true
    fetchHealth().catch(() => {})
  }, [])
}

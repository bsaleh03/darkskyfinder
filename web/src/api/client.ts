import { config } from '../config'
import type { Health, Region, SearchHit, SpotsParams, SpotsResponse } from './types'

export type ApiErrorKind =
  | 'out_of_coverage'
  | 'night_out_of_range'
  | 'rate_limited'
  | 'invalid'
  | 'server'
  | 'network'

export class ApiError extends Error {
  kind: ApiErrorKind
  status?: number
  detail?: unknown
  constructor(kind: ApiErrorKind, status?: number, detail?: unknown) {
    super(kind)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.detail = detail
  }
}

const GENERIC = 'Something went wrong. Check your connection and try again.'

export function errorMessage(e: ApiError): string {
  switch (e.kind) {
    case 'out_of_coverage':
      return 'We cover SE Michigan and the SF Bay Area so far.'
    case 'rate_limited':
      return 'Too many searches — try again in a minute.'
    case 'night_out_of_range':
      return 'Forecasts cover tonight and the next 6 nights — pick one of those.'
    case 'invalid':
      return 'That search didn’t look right. Check the location and try again.'
    default:
      return GENERIC
  }
}

async function readJson(res: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return await res.json()
  } catch (e) {
    if (signal?.aborted || (e as { name?: string } | null)?.name === 'AbortError') throw e
    return undefined
  }
}

async function request<T>(path: string, query?: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const qs = query && [...query].length ? `?${query.toString()}` : ''
  let res: Response
  try {
    res = await fetch(`${config.apiUrl.replace(/\/+$/, '')}${path}${qs}`, { signal })
  } catch (e) {
    if (e instanceof TypeError) throw new ApiError('network', undefined, e)
    throw e
  }
  const body = await readJson(res, signal)
  if (res.ok) {
    if (body === undefined) throw new ApiError('server', res.status)
    return body as T
  }
  const code = (body as { error?: string } | undefined)?.error
  if (res.status === 429) throw new ApiError('rate_limited', 429, body)
  if (res.status === 422) {
    if (code === 'out_of_coverage') throw new ApiError('out_of_coverage', 422, body)
    if (code === 'night_out_of_range') throw new ApiError('night_out_of_range', 422, body)
    throw new ApiError('invalid', 422, body)
  }
  throw new ApiError('server', res.status, body)
}

export function fetchSpots(p: SpotsParams, signal?: AbortSignal): Promise<SpotsResponse> {
  const q = new URLSearchParams({
    lat: String(p.lat),
    lon: String(p.lon),
    max_drive: String(p.drive),
    sort: p.sort,
    access: p.access,
    border: p.border,
    limit: String(p.limit),
  })
  if (p.night) q.set('night', p.night)
  return request<SpotsResponse>('/api/spots', q, signal)
}

export function fetchSearch(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  return request<SearchHit[]>('/api/search', new URLSearchParams({ q }), signal)
}

export function fetchRegions(): Promise<Region[]> {
  return request<Region[]>('/api/regions')
}

export function fetchHealth(): Promise<Health> {
  return request<Health>('/api/health')
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, errorMessage, fetchHealth, fetchRegions, fetchSearch, fetchSpots } from '../../src/api/client'
import { config } from '../../src/config'
import type { SpotsParams } from '../../src/api/types'

const params: SpotsParams = { lat: 42.3, lon: -83.1, drive: 90, sort: 'relevant', access: 'all', border: 'include', limit: 25 }

function mockFetch(status: number, body: unknown) {
  const f = vi.fn().mockImplementation(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', f)
  return f
}
async function catchErr(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    return e as ApiError
  }
  throw new Error('expected rejection')
}

afterEach(() => vi.unstubAllGlobals())

describe('api client', () => {
  it('builds spots query', async () => {
    const f = mockFetch(200, { spots: [] })
    await fetchSpots(params)
    const url = new URL(f.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/spots')
    expect(url.searchParams.get('max_drive')).toBe('90')
    expect(url.searchParams.get('sort')).toBe('relevant')
    expect(url.searchParams.get('access')).toBe('all')
    expect(url.searchParams.get('border')).toBe('include')
    expect(url.searchParams.get('limit')).toBe('25')
    expect(url.searchParams.get('lat')).toBe('42.3')
    expect(url.searchParams.has('night')).toBe(false)
    await fetchSpots({ ...params, night: '2026-10-18' })
    expect(new URL(f.mock.calls[1][0] as string).searchParams.get('night')).toBe('2026-10-18')
    await fetchSpots({ ...params, sort: undefined, limit: 3 }) // night dots: the verdict ignores sort
    expect(new URL(f.mock.calls[2][0] as string).searchParams.has('sort')).toBe(false)
  })

  it('passes the abort signal', async () => {
    const f = mockFetch(200, [])
    const ac = new AbortController()
    await fetchSearch('ann', ac.signal)
    expect(f.mock.calls[0][1].signal).toBe(ac.signal)
    expect(new URL(f.mock.calls[0][0] as string).searchParams.get('q')).toBe('ann')
  })

  it('fetches regions and health', async () => {
    mockFetch(200, [{ key: 'a' }])
    expect(await fetchRegions()).toEqual([{ key: 'a' }])
    mockFetch(200, { ok: true, metros: [], release: 'x' })
    expect((await fetchHealth()).ok).toBe(true)
  })

  it('maps 422 out_of_coverage', async () => {
    mockFetch(422, { error: 'out_of_coverage', metros: ['a', 'b'] })
    const e = await catchErr(fetchSpots(params))
    expect(e).toBeInstanceOf(ApiError)
    expect(e.kind).toBe('out_of_coverage')
    expect(e.status).toBe(422)
    expect((e.detail as { metros: string[] }).metros).toEqual(['a', 'b'])
  })

  it('maps 422 night_out_of_range', async () => {
    mockFetch(422, { error: 'night_out_of_range' })
    expect((await catchErr(fetchSpots(params))).kind).toBe('night_out_of_range')
  })

  it('maps 422 invalid_request to invalid', async () => {
    mockFetch(422, { error: 'invalid_request', detail: [] })
    expect((await catchErr(fetchSpots(params))).kind).toBe('invalid')
  })

  it('maps 429 to rate_limited', async () => {
    mockFetch(429, { error: 'rate_limited' })
    expect((await catchErr(fetchSpots(params))).kind).toBe('rate_limited')
  })

  it('maps 500 and non-JSON bodies to server', async () => {
    mockFetch(500, { error: 'internal' })
    expect((await catchErr(fetchSpots(params))).kind).toBe('server')
    mockFetch(502, '<html>bad gateway</html>')
    expect((await catchErr(fetchSpots(params))).kind).toBe('server')
  })

  it('maps TypeError to network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect((await catchErr(fetchSpots(params))).kind).toBe('network')
  })

  it('rethrows aborts untouched', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
    await expect(fetchSpots(params)).rejects.toBe(abort)
  })

  it('rethrows an abort raised while reading the body', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const ac = new AbortController()
    ac.abort()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(abort) }))
    await expect(fetchSpots(params, ac.signal)).rejects.toBe(abort)
  })

  it('strips trailing slashes from the base url', async () => {
    const orig = config.apiUrl
    config.apiUrl = 'http://x.test///'
    try {
      const f = mockFetch(200, [])
      await fetchRegions()
      expect(f.mock.calls[0][0]).toBe('http://x.test/api/regions')
    } finally {
      config.apiUrl = orig
    }
  })

  it('errorMessage copy', () => {
    const m = (kind: ApiError['kind']) => errorMessage(new ApiError(kind))
    expect(m('out_of_coverage')).toBe('We cover southeast Michigan and the SF Bay Area so far.')
    expect(m('rate_limited')).toBe('Too many searches — try again in a minute.')
    expect(m('night_out_of_range')).toBe('Forecasts cover tonight and the next 6 nights — pick one of those.')
    expect(m('invalid')).toBe('That search didn’t look right. Check the location and try again.')
    expect(m('server')).toBe('Something went wrong. Check your connection and try again.')
    expect(m('network')).toBe('Something went wrong. Check your connection and try again.')
  })
})

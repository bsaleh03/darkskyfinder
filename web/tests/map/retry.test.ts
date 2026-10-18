import { expect, test, vi } from 'vitest'
import { withRetry } from '../../src/map/retry'

test('retries failed tile reads, then succeeds', async () => {
  const handler = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ data: 1 })
  const wrapped = withRetry(handler, { retries: 2, delayMs: 0 })
  await expect(wrapped({ url: 'pmtiles://x' }, new AbortController())).resolves.toEqual({ data: 1 })
  expect(handler).toHaveBeenCalledTimes(2)
})

test('gives up after the retry budget', async () => {
  const handler = vi.fn().mockRejectedValue(new Error('502'))
  const wrapped = withRetry(handler, { retries: 2, delayMs: 0 })
  await expect(wrapped({ url: 'pmtiles://x' }, new AbortController())).rejects.toThrow('502')
  expect(handler).toHaveBeenCalledTimes(3)
})

test('does not retry aborted requests (the map no longer needs that tile)', async () => {
  const ac = new AbortController()
  const handler = vi.fn().mockImplementation(() => { ac.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')) })
  const wrapped = withRetry(handler, { retries: 2, delayMs: 0 })
  await expect(wrapped({ url: 'pmtiles://x' }, ac)).rejects.toThrow('aborted')
  expect(handler).toHaveBeenCalledTimes(1)
})

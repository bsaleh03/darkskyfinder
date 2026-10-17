// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { devtilesMiddleware } from '../devtiles'

const DATA = Buffer.from('0123456789abcdefghij')
let server: http.Server
let base: string

beforeAll(async () => {
  const parent = mkdtempSync(join(tmpdir(), 'devtiles-'))
  const root = join(parent, 'root')
  mkdirSync(root)
  writeFileSync(join(parent, 'secret.txt'), 'top secret')
  writeFileSync(join(root, 'a.pmtiles'), DATA)
  const mw = devtilesMiddleware(root)
  server = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end('next') }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })

test('serves full file with 200 and Accept-Ranges', async () => {
  const r = await get('/a.pmtiles')
  expect(r.status).toBe(200)
  expect(r.headers['accept-ranges']).toBe('bytes')
  expect(r.headers['content-type']).toBe('application/octet-stream')
  expect(r.body.equals(DATA)).toBe(true)
})

test('serves range with 206 and Content-Range', async () => {
  const r = await get('/a.pmtiles', { Range: 'bytes=2-5' })
  expect(r.status).toBe(206)
  expect(r.headers['content-range']).toBe('bytes 2-5/20')
  expect(r.body.toString()).toBe('2345')
})

test('supports open-ended and suffix ranges', async () => {
  const a = await get('/a.pmtiles', { Range: 'bytes=15-' })
  expect(a.status).toBe(206)
  expect(a.body.toString()).toBe('fghij')
  const b = await get('/a.pmtiles', { Range: 'bytes=-3' })
  expect(b.status).toBe(206)
  expect(b.headers['content-range']).toBe('bytes 17-19/20')
  expect(b.body.toString()).toBe('hij')
})

test('416 for unsatisfiable range', async () => {
  const r = await get('/a.pmtiles', { Range: 'bytes=50-60' })
  expect(r.status).toBe(416)
  expect(r.headers['content-range']).toBe('bytes */20')
})

test('HEAD returns headers without body', async () => {
  const r = await get('/a.pmtiles', {}, 'HEAD')
  expect(r.status).toBe(200)
  expect(r.headers['content-length']).toBe('20')
  expect(r.body.length).toBe(0)
})

test('404 outside root (path traversal ../ rejected)', async () => {
  // secret.txt really exists in the parent of the served root
  for (const p of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/..%5csecret.txt', '/../secret.txt']) {
    const r = await get(p)
    expect(r.status, p).toBe(404)
    expect(r.body.toString()).not.toContain('top secret')
  }
})

test('404 for missing file', async () => {
  expect((await get('/nope.pmtiles')).status).toBe(404)
})

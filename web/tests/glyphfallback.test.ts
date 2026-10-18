// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { glyphFallbackMiddleware, missingGlyphRanges } from '../glyphfallback'

let dir: string
let server: http.Server
let base: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'glyphs-'))
  mkdirSync(join(dir, 'Noto Sans Bold'))
  writeFileSync(join(dir, 'Noto Sans Bold', '0-255.pbf'), 'real')
  const mw = glyphFallbackMiddleware(dir)
  server = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 299; res.end('next') }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

const get = async (path: string) => {
  const r = await fetch(base + path)
  return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) }
}

test('missing ranges cover the whole BMP except the shipped ones', () => {
  const missing = missingGlyphRanges(dir)
  expect(missing).toHaveLength(255)
  expect(missing).toContain('Noto Sans Bold/5120-5375.pbf') // Canadian syllabics (e.g. Nunavut's name)
  expect(missing).not.toContain('Noto Sans Bold/0-255.pbf')
})

test('missing range: 200 with an empty (valid) glyph PBF, never the app HTML', async () => {
  const r = await get('/Noto%20Sans%20Bold/5120-5375.pbf')
  expect(r.status).toBe(200)
  expect(r.type).toBe('application/x-protobuf')
  expect(r.body.length).toBe(0)
})

test('existing ranges, unknown fonts, other paths and traversal fall through', async () => {
  expect((await get('/Noto%20Sans%20Bold/0-255.pbf')).status).toBe(299)
  expect((await get('/Comic%20Sans/0-255.pbf')).status).toBe(299)
  expect((await get('/Noto%20Sans%20Bold/readme.txt')).status).toBe(299)
  expect((await get('/..%2F..%2Fsecret/0-255.pbf')).status).toBe(299)
})

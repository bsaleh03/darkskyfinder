import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve, sep } from 'node:path'

type Next = (err?: unknown) => void

/** Parse a single-range header: [start,end], 'bad' (unsatisfiable), or null (ignore header). */
function parseRange(header: string, size: number): [number, number] | 'bad' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return 'bad'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'bad'
  return [start, end]
}

/** Connect middleware serving files under `root` with HTTP Range support. Mount at any prefix. */
export function devtilesMiddleware(root: string) {
  const base = resolve(root)
  return (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const notFound = () => {
      res.statusCode = 404
      res.end()
    }
    let rel: string
    try {
      rel = decodeURIComponent((req.url ?? '/').split('?')[0])
    } catch {
      return notFound()
    }
    const file = resolve(base, '.' + (rel.startsWith('/') ? rel : `/${rel}`))
    if (!file.startsWith(base + sep)) return notFound()
    let size: number
    try {
      const st = statSync(file)
      if (!st.isFile()) return notFound()
      size = st.size
    } catch {
      return notFound()
    }
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-cache')
    const header = req.headers.range
    const range = header ? parseRange(header, size) : null
    if (range === 'bad') {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      return res.end()
    }
    let opts: { start: number; end: number } | undefined
    if (range) {
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${range[0]}-${range[1]}/${size}`)
      res.setHeader('Content-Length', range[1] - range[0] + 1)
      opts = { start: range[0], end: range[1] }
    } else {
      res.statusCode = 200
      res.setHeader('Content-Length', size)
    }
    if (req.method === 'HEAD') return res.end()
    createReadStream(file, opts).on('error', () => res.destroy()).pipe(res)
  }
}

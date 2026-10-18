import { existsSync, readdirSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

// MapLibre asks for glyphs in 256-codepoint ranges. We ship only the ranges our labels normally need; any other
// range (e.g. Canadian syllabics in Nunavut's name) would otherwise fall through to the SPA's index.html, which
// MapLibre fails to decode ("Unimplemented type: 4") and can drop the whole tile. An empty PBF is a valid
// glyph file with no glyphs: those characters just don't draw.

const RANGES = Array.from({ length: 256 }, (_, i) => `${i * 256}-${i * 256 + 255}.pbf`)
type Next = (err?: unknown) => void

const fontsIn = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()) : []

/** "<font>/<range>.pbf" for every range a shipped font doesn't have. */
export function missingGlyphRanges(dir: string): string[] {
  return fontsIn(dir).flatMap((font) => RANGES.filter((r) => !existsSync(join(dir, font, r))).map((r) => `${font}/${r}`))
}

/** Serves an empty glyph PBF for missing ranges of shipped fonts; everything else falls through. */
export function glyphFallbackMiddleware(dir: string) {
  const base = resolve(dir)
  return (req: IncomingMessage, res: ServerResponse, next: Next) => {
    let rel: string
    try {
      rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '')
    } catch {
      return next()
    }
    const m = /^([^/]+)\/(\d+-\d+\.pbf)$/.exec(rel)
    if (!m || !RANGES.includes(m[2])) return next()
    const fontDir = resolve(base, m[1])
    if (!fontDir.startsWith(base + sep) || !existsSync(fontDir) || existsSync(join(fontDir, m[2]))) return next()
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-protobuf')
    res.setHeader('Content-Length', 0)
    res.end()
  }
}

/** Dev/preview: serve empty PBFs for missing ranges. Build: emit them so static hosting never returns index.html. */
export const glyphFallback = (publicGlyphs: string): Plugin => ({
  name: 'glyph-fallback',
  configureServer: (server) => { server.middlewares.use('/glyphs', glyphFallbackMiddleware(publicGlyphs)) },
  configurePreviewServer: (server) => { server.middlewares.use('/glyphs', glyphFallbackMiddleware(publicGlyphs)) },
  generateBundle() {
    for (const file of missingGlyphRanges(publicGlyphs)) {
      this.emitFile({ type: 'asset', fileName: `glyphs/${file}`, source: new Uint8Array(0) })
    }
  },
})

// Dev-only: render the per-region map pictures the app shows instead of a live map.
//
//   npm run render-maps                      # both regions
//   npm run render-maps -- --metro se_mi     # one region (repeatable; any key with pipeline/out/maps/<key>/)
//
// Needs the pipeline outputs first: pipeline/out/<metro>/basemap_<metro>_*.pmtiles and
// pipeline/out/maps/<metro>/{extent.json,glow/L*.png,labels.json,borders.geojson}.
// Starts the Vite dev server (it serves the PMTiles from ../pipeline/out at /tiles and the map inputs from
// ../pipeline/out/maps at /render-data, since /tiles/maps is shadowed by the rendered output) and renders the base
// with MapLibre in headless Chromium at every level in extent.json `levels` (normal and red): level 0 = the whole
// extent in one W x H canvas; level l >= 1 = 2^l x 2^l tiles, each W x H, the map centred on the tile's Web Mercator
// bounds at the level-0 zoom + l. Every picture's corners must land within 2 px of its bounds. Then it writes to
// pipeline/out/maps/<metro>/web/: level 0 at full, 1/2 and 1/4 width and every level >= 1 tile, for base, base_red,
// glow and glow_red (glow from the pipeline's glow/ PNGs), plus labels.json and manifest.json (v2, see
// render/manifest.ts). Base is lossy WebP q82, base_red lossless, glow and glow_red near-lossless (with alpha).
// Red variants are checked pixel by pixel on the decoded files; any violation exits non-zero. Any MapLibre
// source/tile error (missing PMTiles, failed borders.geojson) fails the run before anything is written for that region.
import { chromium } from '@playwright/test'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createServer } from 'vite'

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAPS = resolve(WEB, '../pipeline/out/maps')
const METROS = ['se_mi', 'bay_area']
const MAX_PIXELS = 16_000_000
const RENDER_TIMEOUT_MS = 5 * 60_000
const MAX_CORNER_PX = 2
const ENCODE = {
  base: { quality: 82, effort: 6 },
  base_red: { lossless: true, effort: 6 },
  // Near-lossless keeps the smooth glow free of blocks; quality 80 is the lightest preprocessing level and gave
  // the smallest files on the real glow (lower levels came out larger).
  glow: { nearLossless: true, quality: 80, effort: 6 },
  glow_red: { nearLossless: true, quality: 80, effort: 6 },
}

function parseArgs(argv) {
  const metros = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--metro' && argv[i + 1]) metros.push(argv[++i])
    else throw new Error(`unknown argument ${argv[i]} (usage: render-maps [--metro <key>]...)`)
  }
  for (const m of metros) if (!/^[a-z_]+$/.test(m)) throw new Error(`bad metro key ${m}`)
  return metros.length ? [...new Set(metros)] : METROS
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

/**
 * Render one base picture (PNG buffer) through the dev-only render page. `view` = { bounds, zoom } for a tile
 * (centred on the bounds at that zoom), or null for the region's extent (fitted). Returns { png, zoom, offset }.
 */
async function renderBase(browser, origin, metro, red, w, h, view, label, mods) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`  [page ${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`))
  try {
    const t0 = Date.now()
    let url = `${origin}/render/index.html?metro=${metro}&red=${red ? 1 : 0}&w=${w}&h=${h}`
    if (view) url += `&bounds=${view.bounds.join(',')}&zoom=${view.zoom}`
    await page.goto(url)
    await page.waitForFunction(() => window.__renderDone || window.__renderError || window.__renderErrors?.length, null, {
      timeout: RENDER_TIMEOUT_MS,
      polling: 1000,
    })
    const err = await page.evaluate(() => window.__renderError)
    if (err) throw new Error(`render page: ${err}`)
    const failure = mods.errors.renderFailure(await page.evaluate(() => window.__renderErrors ?? []))
    if (failure) throw new Error(`${metro} ${label}: ${failure}`)
    const info = await page.evaluate(() => window.__renderInfo)
    const off = Math.max(Math.abs(info.nw[0]), Math.abs(info.nw[1]), Math.abs(info.se[0] - w), Math.abs(info.se[1] - h))
    console.log(
      `  ${label}: ${((Date.now() - t0) / 1000).toFixed(0)} s, zoom ${info.zoom.toFixed(3)}, ` +
        `canvas ${info.canvas.join('x')}, corners NW (${info.nw.map((v) => v.toFixed(2))}) ` +
        `SE (${info.se.map((v) => v.toFixed(2))}), max corner offset ${off.toFixed(2)} px`,
    )
    if (info.canvas[0] !== w || info.canvas[1] !== h) throw new Error(`${label}: canvas is ${info.canvas.join('x')}, expected ${w}x${h}`)
    if (off > MAX_CORNER_PX) throw new Error(`${label}: picture bounds are off by ${off.toFixed(2)} px (limit ${MAX_CORNER_PX})`)
    const png = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'))
    return { png: Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'), zoom: info.zoom, offset: off }
  } finally {
    await page.close()
  }
}

/**
 * Write one source picture as each of `outputs` ([{ file, w, h }]); returns [{ file, w, bytes }] and the red
 * violations found on the decoded files (plus on the source itself).
 */
async function writePictures(src, key, outputs, outDir, rc) {
  const red = key.endsWith('_red')
  const opaque = key.startsWith('base')
  const out = []
  let violations = 0
  if (red) {
    // The full-size source must already be clean: the clamp below only absorbs resampling rounding,
    // it must never hide a real color mistake in the style or the glow ramp.
    const v = rc.redViolations(await sharp(src).ensureAlpha().raw().toBuffer())
    violations += v
    if (v) console.log(`  red check ${key} source: ${v} violating pixels`)
  }
  for (const { file, w, h } of outputs) {
    let img = sharp(src)
    const meta = await img.metadata()
    if (meta.width !== w || meta.height !== h) img = img.resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    if (opaque) img = img.removeAlpha()
    if (red) {
      // Resampling can nudge a few low-alpha pixels over the red rule through rounding: cap them.
      const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      rc.clampRed(data)
      img = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      if (opaque) img = img.removeAlpha()
    }
    // Encode to memory and check the decoded picture before anything is written.
    const encode = async (opts) => {
      const buf = await img.clone().webp(opts).toBuffer()
      const c = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      if (c.info.width !== w || c.info.height !== h) throw new Error(`${file} is ${c.info.width}x${c.info.height}`)
      return { buf, data: c.data }
    }
    let enc = await encode(ENCODE[key])
    if (red) {
      let v = rc.redViolations(enc.data)
      if (v > 0 && ENCODE[key].nearLossless) {
        // Near-lossless preprocessing can move a clamped pixel (green or blue exactly half of red) one step
        // over the line; this picture then goes up lossless instead.
        console.log(`  red check ${file}: ${v} violating pixels after near-lossless, writing it lossless`)
        enc = await encode({ lossless: true, effort: 6 })
        v = rc.redViolations(enc.data)
      }
      violations += v
      console.log(`  red check ${file}: ${v} violating pixels`)
    }
    await writeFile(join(outDir, file), enc.buf)
    out.push({ file, w, bytes: enc.buf.length })
  }
  return { out, violations }
}

async function renderMetro(browser, origin, metro, mods) {
  const dir = join(MAPS, metro)
  const extent = JSON.parse(await readFile(join(dir, 'extent.json'), 'utf8'))
  const { bounds, width: W, height: H } = extent
  const manifest = mods.manifest.buildManifest(metro, extent)
  const tileLevels = manifest.levels.filter((l) => l.level > 0)
  console.log(`\n${metro}: ${W}x${H}, bounds ${bounds.join(', ')}, levels ${manifest.levels.map((l) => `${l.level} (${l.cols}x${l.rows})`).join(', ')}`)
  if (W % 4 !== 0) throw new Error(`full width ${W} is not a multiple of 4`)
  if (W * H > MAX_PIXELS) throw new Error(`${W}x${H} is over ${MAX_PIXELS} pixels`)

  // Every tile of every level >= 1: [{ level, col, row, bounds }].
  const tiles = []
  for (const { level, cols, rows } of tileLevels) {
    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) tiles.push({ level, col, row, bounds: mods.sizes.tileBounds(bounds, level, col, row) })
    }
  }
  const glowPng = (t, red) => join(dir, 'glow', `${t ? `L${t.level}_${t.col}_${t.row}` : 'L0'}${red ? '_red' : ''}.png`)
  for (const t of [null, ...tiles]) {
    for (const red of [false, true]) {
      const m = await sharp(glowPng(t, red)).metadata()
      if (m.width !== W || m.height !== H) throw new Error(`${glowPng(t, red)} is ${m.width}x${m.height}, expected ${W}x${H}`)
    }
  }

  // Every render must succeed before anything is written for this region.
  const t0 = Date.now()
  const renders = {} // key -> { level0, tiles: [png per tile] }
  for (const red of [false, true]) {
    const key = red ? 'base_red' : 'base'
    const l0 = await renderBase(browser, origin, metro, red, W, H, null, `${key} L0`, mods)
    const list = []
    for (const t of tiles) {
      const view = { bounds: t.bounds, zoom: l0.zoom + t.level }
      const r = await renderBase(browser, origin, metro, red, W, H, view, `${key} L${t.level}_${t.col}_${t.row}`, mods)
      list.push(r.png)
    }
    renders[key] = { level0: l0.png, tiles: list }
  }
  console.log(`  renders: ${((Date.now() - t0) / 1000).toFixed(0)} s`)

  const outDir = join(dir, 'web')
  await mkdir(outDir, { recursive: true })
  // Full-size level-0 render sources, kept next to the glow inputs for inspection (not uploaded).
  await writeFile(join(dir, 'base.png'), renders.base.level0)
  await writeFile(join(dir, 'base_red.png'), renders.base_red.level0)

  const sizes = mods.sizes.sizesFor(W, H / W)
  const rc = mods.redcheck
  const results = {}
  let violations = 0
  for (const key of mods.manifest.KEYS) {
    const red = key.endsWith('_red')
    const level0 = key.startsWith('base') ? renders[key].level0 : glowPng(null, red)
    const l0 = sizes.map(({ w, h }) => ({ file: manifest.files[key].replace('{w}', String(w)), w, h }))
    const r0 = await writePictures(level0, key, l0, outDir, rc)
    results[key] = r0.out
    violations += r0.violations
    for (const [i, t] of tiles.entries()) {
      const src = key.startsWith('base') ? renders[key].tiles[i] : glowPng(t, red)
      const file = mods.manifest.tileFile(manifest.tiles[key], t.level, t.col, t.row)
      const r = await writePictures(src, key, [{ file, w: W, h: H }], outDir, rc)
      results[key].push(...r.out)
      violations += r.violations
    }
  }
  await copyFile(join(dir, 'labels.json'), join(outDir, 'labels.json'))
  const labelsBytes = (await stat(join(outDir, 'labels.json'))).size
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  console.log(`  files (${outDir}):`)
  let total = labelsBytes
  const bytes = {}
  for (const list of Object.values(results)) {
    for (const f of list) {
      total += f.bytes
      bytes[f.file] = f.bytes
      console.log(`    ${f.file.padEnd(26)} ${kb(f.bytes).padStart(9)}`)
    }
  }
  console.log(`    ${'labels.json'.padEnd(26)} ${kb(labelsBytes).padStart(9)}`)
  const sum = (key, level) =>
    tiles.filter((t) => t.level === level).reduce((s, t) => s + bytes[mods.manifest.tileFile(manifest.tiles[key], t.level, t.col, t.row)], 0)
  const fullW = W
  const l0 = (key) => bytes[manifest.files[key].replace('{w}', String(fullW))]
  const normal = l0('base') + l0('glow') + labelsBytes
  const redMode = l0('base_red') + l0('glow_red') + labelsBytes
  console.log(`  normal mode, level 0 full size (base + glow + labels): ${mb(normal)}`)
  console.log(`  red mode, level 0 full size (base_red + glow_red + labels): ${mb(redMode)}`)
  for (const { level } of tileLevels) {
    console.log(
      `  level ${level} all tiles: base ${mb(sum('base', level))}, glow ${mb(sum('glow', level))}, ` +
        `base_red ${mb(sum('base_red', level))}, glow_red ${mb(sum('glow_red', level))}`,
    )
  }
  const count = Object.values(results).reduce((n, l) => n + l.length, 0) + 2
  console.log(`  region total: ${count} files, ${mb(total)}`)
  return { total, violations }
}

async function main() {
  const metros = parseArgs(process.argv.slice(2))
  const port = await freePort()
  const server = await createServer({
    root: WEB,
    configFile: join(WEB, 'vite.config.ts'),
    logLevel: 'warn',
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false },
  })
  let browser
  let grand = 0
  let violations = 0
  const t0 = Date.now()
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${port}`
    console.log(`dev server on ${origin}`)
    const mods = {
      sizes: await server.ssrLoadModule('/render/sizes.ts'),
      manifest: await server.ssrLoadModule('/render/manifest.ts'),
      redcheck: await server.ssrLoadModule('/render/redcheck.ts'),
      errors: await server.ssrLoadModule('/render/errors.ts'),
    }
    browser = await chromium.launch()
    for (const metro of metros) {
      const r = await renderMetro(browser, origin, metro, mods)
      grand += r.total
      violations += r.violations
    }
  } finally {
    await browser?.close()
    await server.close()
  }
  console.log(`\nall regions rendered here: ${mb(grand)} in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  if (violations > 0) {
    console.error(`red check FAILED: ${violations} pixels with green or blue above half of red`)
    process.exitCode = 1
  } else {
    console.log('red check passed: no pixel with green or blue above half of red')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})

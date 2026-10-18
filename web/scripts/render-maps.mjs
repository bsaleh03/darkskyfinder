// Dev-only: render the per-region map pictures the app shows instead of a live map.
//
//   npm run render-maps                      # both regions
//   npm run render-maps -- --metro se_mi     # one region (repeatable)
//
// Needs the pipeline outputs first: pipeline/out/<metro>/basemap_<metro>_*.pmtiles and
// pipeline/out/maps/<metro>/{extent.json,glow.png,glow_red.png,labels.json,borders.geojson}.
// Starts the Vite dev server (it serves ../pipeline/out at /tiles), renders the base picture with MapLibre in
// headless Chromium at the region's full size in one canvas (normal and red), then writes every variant at
// full, 1/2 and 1/4 width as WebP plus labels.json and manifest.json to pipeline/out/maps/<metro>/web/.
// Red variants are checked pixel by pixel on the decoded files; any violation exits non-zero.
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
const RENDER_TIMEOUT_MS = 20 * 60_000
const FILES = { base: 'base_{w}.webp', base_red: 'base_red_{w}.webp', glow: 'glow_{w}.webp', glow_red: 'glow_red_{w}.webp' }

function parseArgs(argv) {
  const metros = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--metro' && argv[i + 1]) metros.push(argv[++i])
    else throw new Error(`unknown argument ${argv[i]} (usage: render-maps [--metro <key>]...)`)
  }
  for (const m of metros) if (!METROS.includes(m)) throw new Error(`unknown metro ${m} (known: ${METROS.join(', ')})`)
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

/** Render one base picture (PNG buffer) through the dev-only render page. */
async function renderBase(browser, origin, metro, red, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`  [page ${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`))
  try {
    const t0 = Date.now()
    await page.goto(`${origin}/render/index.html?metro=${metro}&red=${red ? 1 : 0}&w=${w}&h=${h}`)
    await page.waitForFunction(() => window.__renderDone || window.__renderError, null, {
      timeout: RENDER_TIMEOUT_MS,
      polling: 1000,
    })
    const err = await page.evaluate(() => window.__renderError)
    if (err) throw new Error(`render page: ${err}`)
    const info = await page.evaluate(() => window.__renderInfo)
    const off = Math.max(Math.abs(info.nw[0]), Math.abs(info.nw[1]), Math.abs(info.se[0] - w), Math.abs(info.se[1] - h))
    console.log(
      `  base${red ? '_red' : ''}: ${((Date.now() - t0) / 1000).toFixed(0)} s, zoom ${info.zoom.toFixed(3)}, ` +
        `canvas ${info.canvas.join('x')}, corners NW (${info.nw.map((v) => v.toFixed(2))}) ` +
        `SE (${info.se.map((v) => v.toFixed(2))}), max corner offset ${off.toFixed(2)} px`,
    )
    if (info.canvas[0] !== w || info.canvas[1] !== h) throw new Error(`canvas is ${info.canvas.join('x')}, expected ${w}x${h}`)
    if (off > 2) throw new Error(`picture bounds are off by ${off.toFixed(2)} px (limit 2)`)
    const url = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'))
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
  } finally {
    await page.close()
  }
}

/** Write one variant at every size; returns [{ file, bytes }] and the red violations found on decoded files. */
async function writeVariant(src, key, sizes, outDir, { lossless, red, opaque }, rc) {
  const out = []
  let violations = 0
  if (red) {
    // The full-size source must already be clean: the clamp below only absorbs resampling rounding,
    // it must never hide a real color mistake in the style or the glow ramp.
    const src0 = await sharp(src).ensureAlpha().raw().toBuffer()
    const v = rc.redViolations(src0)
    violations += v
    console.log(`  red check ${key} source: ${v} violating pixels`)
  }
  for (const { w, h } of sizes) {
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
    const file = FILES[key].replace('{w}', String(w))
    const path = join(outDir, file)
    await img.webp(lossless ? { lossless: true, effort: 6 } : { quality: 82, effort: 6 }).toFile(path)
    const check = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    if (check.info.width !== w || check.info.height !== h) throw new Error(`${file} is ${check.info.width}x${check.info.height}`)
    if (red) {
      const v = rc.redViolations(check.data)
      violations += v
      console.log(`  red check ${file}: ${v} violating pixels`)
    }
    out.push({ file, w, bytes: (await stat(path)).size })
  }
  return { out, violations }
}

async function renderMetro(browser, origin, metro, mods) {
  const dir = join(MAPS, metro)
  const extent = JSON.parse(await readFile(join(dir, 'extent.json'), 'utf8'))
  const { bounds, width: W, height: H } = extent
  console.log(`\n${metro}: ${W}x${H}, bounds ${bounds.join(', ')}`)
  if (W % 4 !== 0) throw new Error(`full width ${W} is not a multiple of 4`)
  if (W * H > MAX_PIXELS) throw new Error(`${W}x${H} is over ${MAX_PIXELS} pixels`)
  for (const g of ['glow.png', 'glow_red.png']) {
    const m = await sharp(join(dir, g)).metadata()
    if (m.width !== W || m.height !== H) throw new Error(`${g} is ${m.width}x${m.height}, expected ${W}x${H}`)
  }

  const outDir = join(dir, 'web')
  await mkdir(outDir, { recursive: true })
  const sizes = mods.sizes.sizesFor(W, H / W)

  const base = await renderBase(browser, origin, metro, false, W, H)
  const baseRed = await renderBase(browser, origin, metro, true, W, H)
  // Full-size render sources, kept next to the glow inputs for inspection (not uploaded).
  await writeFile(join(dir, 'base.png'), base)
  await writeFile(join(dir, 'base_red.png'), baseRed)

  const rc = mods.redcheck
  const results = {}
  let violations = 0
  const variants = [
    ['base', base, { lossless: false, red: false, opaque: true }],
    ['base_red', baseRed, { lossless: true, red: true, opaque: true }],
    ['glow', join(dir, 'glow.png'), { lossless: true, red: false, opaque: false }],
    ['glow_red', join(dir, 'glow_red.png'), { lossless: true, red: true, opaque: false }],
  ]
  for (const [key, src, opts] of variants) {
    const r = await writeVariant(src, key, sizes, outDir, opts, rc)
    results[key] = r.out
    violations += r.violations
  }
  await copyFile(join(dir, 'labels.json'), join(outDir, 'labels.json'))
  const labelsBytes = (await stat(join(outDir, 'labels.json'))).size

  // MapManifest: bounds = W,S,E,N of the images (Web Mercator rectangle), aspect = height / width,
  // widths ascending, files = name templates ({w} = one of widths).
  const manifest = {
    metro,
    bounds,
    aspect: H / W,
    widths: sizes.map((s) => s.w),
    files: FILES,
    labels: 'labels.json',
  }
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  console.log(`  files (${outDir}):`)
  let total = labelsBytes
  for (const [key, list] of Object.entries(results)) {
    for (const f of list) {
      total += f.bytes
      console.log(`    ${f.file.padEnd(22)} ${kb(f.bytes).padStart(9)}`)
    }
  }
  console.log(`    ${'labels.json'.padEnd(22)} ${kb(labelsBytes).padStart(9)}`)
  const full = (k) => results[k][results[k].length - 1].bytes
  const normal = full('base') + full('glow') + labelsBytes
  const redMode = full('base_red') + full('glow_red') + labelsBytes
  console.log(`  normal mode at full size (base + glow + labels): ${mb(normal)} (budget ~6 MB)${normal > 6 * 1024 * 1024 ? '  OVER BUDGET' : ''}`)
  console.log(`  red mode at full size (base_red + glow_red + labels): ${mb(redMode)}`)
  console.log(`  all sizes and variants: ${mb(total)}`)
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
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${port}`
    console.log(`dev server on ${origin}`)
    const mods = {
      sizes: await server.ssrLoadModule('/render/sizes.ts'),
      redcheck: await server.ssrLoadModule('/render/redcheck.ts'),
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
  console.log(`\nall regions rendered here: ${mb(grand)} (guide ~100 MB for both regions)`)
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

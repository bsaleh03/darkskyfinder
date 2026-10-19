import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page, type Request } from '@playwright/test'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')

// Fixtures were captured from the local API at this instant (America/Detroit "tonight" = 2026-10-17).
// The browser clock is frozen here so night labels, timelines and screenshots stay stable.
const CAPTURED_AT = new Date('2026-10-17T16:34:39Z')
const NIGHT2 = '2026-10-18'

const json = (body: string) => ({ status: 200, contentType: 'application/json', body })

async function mockApi(page: Page) {
  await page.route('**/api-mock/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api-mock/, '')
    const q = url.searchParams
    switch (path) {
      case '/api/health':
        return route.fulfill(json(JSON.stringify({ ok: true, metros: ['bay_area', 'se_mi'], release: 'e2e' })))
      case '/api/regions':
        return route.fulfill(json(fixture('regions')))
      case '/api/search':
        return route.fulfill(json(fixture('search_royal')))
      case '/api/spots':
        if (q.get('night') === NIGHT2) return route.fulfill(json(fixture('spots_royal_night2')))
        if (q.get('limit') === '3') return route.fulfill(json(fixture('dots')))
        return route.fulfill(json(fixture('spots_royal')))
      default:
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' })
    }
  })
}

const spotsRequest = (match: (q: URLSearchParams) => boolean) => (req: Request) => {
  const url = new URL(req.url())
  return url.pathname.endsWith('/api/spots') && url.searchParams.get('limit') === '25' && match(url.searchParams)
}

/** Every element's computed box-shadow (and its ::before/::after) must be `none`. */
async function shadowedElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`
    for (const el of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after'] as const) {
        const v = getComputedStyle(el, pseudo).boxShadow
        if (v && v !== 'none') out.push(`${describe(el)}${pseudo ?? ''}: ${v}`)
      }
    }
    return out
  })
}

/**
 * Red (night-vision) mode must emit no white, blue or green light. Every visible, non-transparent
 * colour in the page chrome (text, background incl. gradients, borders, outlines, SVG fill/stroke)
 * must be red-dominant (green and blue at most half of red) or near-black. The map pictures are
 * excluded (image pixels; the render step checks every pixel of the red variants), but the pins,
 * start marker, labels and map buttons drawn over them are checked here.
 */
async function nonRedColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`
    const bad = (value: string): string[] => {
      const found: string[] = []
      if (/(color|oklch|oklab|lab|lch|hwb|hsl)a?\(/.test(value)) found.push(value)
      for (const m of value.matchAll(/rgba?\(([^)]+)\)/g)) {
        const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
        if (a === 0) continue
        if (Math.max(r, g, b) <= 24) continue
        if (g <= r * 0.5 && b <= r * 0.5) continue
        found.push(m[0])
      }
      return found
    }
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.matches('.static-map-picture') || !visible(el)) continue
      for (const pseudo of [null, '::before', '::after'] as const) {
        const cs = getComputedStyle(el, pseudo)
        if (pseudo && (cs.content === 'none' || cs.content === 'normal')) continue
        const props = ['color', 'background-color', 'background-image']
        for (const side of ['top', 'right', 'bottom', 'left']) {
          if (parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0) props.push(`border-${side}-color`)
        }
        if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) props.push('outline-color')
        if (el instanceof SVGElement) props.push('fill', 'stroke')
        for (const prop of props) {
          for (const v of bad(cs.getPropertyValue(prop))) out.push(`${describe(el)}${pseudo ?? ''} ${prop}: ${v}`)
        }
      }
    }
    return [...new Set(out)]
  })
}

/** srcs of the whole level-0 map pictures (base, or base_glow with the glow drawn in). */
const mapSrcs = (page: Page) =>
  page.locator('.static-map-picture').evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).src))
/** srcs of the level >= 1 tiles laid over the level-0 base. */
const tileSrcs = (page: Page) =>
  page.locator('.static-map-tile').evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).src))
/** Width (CSS px) of the whole picture as laid out, and the device pixel ratio. */
const pictureWidth = (page: Page) =>
  page.locator('.static-map-image').evaluate((el) => (el as HTMLElement).getBoundingClientRect().width * window.devicePixelRatio)
/** Picture files (not the manifest or labels) requested since index `from` of `requested`. */
const picturesSince = (requested: string[], from: number) => requested.slice(from).filter((u) => u.endsWith('.webp'))

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('main[aria-busy="true"]')).toHaveCount(0)
  // Every map picture has finished decoding, so screenshots show the map, not the water color behind it, and
  // every level-1 tile has loaded and faded in.
  await expect
    .poll(() =>
      page
        .locator('.static-map-picture, .static-map-tile')
        .evaluateAll(
          (imgs) =>
            imgs.length > 0 &&
            imgs.every(
              (i) =>
                (i as HTMLImageElement).complete &&
                (i as HTMLImageElement).naturalWidth > 0 &&
                (!i.classList.contains('static-map-tile') || i.classList.contains('static-map-tile--loaded')),
            ),
        ),
    )
    .toBe(true)
}

test('search, pick a start, explore nights, filters and red mode', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))
  const tiles: { url: string; status: number }[] = []
  page.on('response', (res) => {
    if (res.url().includes('/e2e-tiles/')) tiles.push({ url: res.url(), status: res.status() })
  })
  const requested: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/e2e-tiles/')) requested.push(req.url())
  })

  await page.clock.setFixedTime(CAPTURED_AT)
  await mockApi(page)
  await page.goto('/')

  // Search from the Welcome screen and pick the Royal Oak locality.
  await expect(page.getByRole('heading', { name: "Where's the closest dark sky tonight?" })).toBeVisible()
  const search = page.getByRole('combobox', { name: 'Search for a place' })
  await search.fill('Royal Oak')
  const option = page.getByRole('option', { name: /^Royal Oak locality · Michigan$/ })
  await expect(option).toBeVisible()
  await option.click()

  // Results: verdict and the ranked list.
  await expect(page.getByRole('region', { name: 'Night verdict' })).toBeVisible()
  const cards = page.getByRole('article')
  await expect(cards.first()).toBeVisible()
  expect(await cards.count()).toBeGreaterThanOrEqual(3)
  await expect(page).toHaveURL(/lat=42\.5072679&lon=-83\.15047897440644/)
  await expect(page.getByRole('button', { name: 'Royal Oak', exact: true })).toBeVisible() // start chip in the TopBar
  // The filter switches sit behind the collapsed More filters disclosure.
  await expect(page.getByRole('switch', { name: 'Crosses country border' })).toHaveCount(0)

  // The map is the pre-rendered se_mi picture. The fixture manifest (v3) lists one level-0 width, 874 px, and
  // level 1 as 2x2 tiles of 874 px each, for base, base_red and the glow composites base_glow / base_glow_red. With
  // the glow on (the default) the pictures are the composites: no separate glow overlay. On the desktop map the
  // framing around Royal Oak is wider than 874 device px, so the visible level-1 tiles load over the full level-0
  // picture (still underneath); the phone's mini map is not, and stays at level 0.
  const map = page.locator('.static-map')
  const base = map.locator('.static-map-picture').first()
  await expect(base).toHaveAttribute('src', /\/e2e-tiles\/maps\/se_mi\/base_glow_874\.webp$/)
  await expect.poll(() => base.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(map.getByRole('img', { name: 'Your start' })).toBeVisible()
  await expect(map.getByText('Map unavailable right now')).toHaveCount(0)
  await settle(page)
  const levelOne = await tileSrcs(page)
  const sharpNeeded = (await pictureWidth(page)) > 874
  if (testInfo.project.name === 'desktop') expect(sharpNeeded).toBe(true)
  expect(levelOne.length > 0).toBe(sharpNeeded)
  if (sharpNeeded) {
    // Royal Oak is in the south-east quarter of the region.
    expect(levelOne).toContainEqual(expect.stringMatching(/\/base_glow_L1_1_1\.webp$/))
  }
  for (const src of levelOne) expect(src).toMatch(/\/e2e-tiles\/maps\/se_mi\/base_glow_L1_[01]_[01]\.webp$/)
  expect(await mapSrcs(page)).toEqual([expect.stringMatching(/\/base_glow_874\.webp$/)])
  // No glow overlay picture is ever requested: the glow comes drawn into the pictures.
  const overlay = (u: string) => /\/glow(_red)?_/.test(u)
  expect(requested.filter(overlay)).toEqual([])
  // No horizontal page scroll at either width (night chips scroll inside their own row).
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: testInfo.outputPath('main-normal-full.png'), fullPage: true })
  await expect(page).toHaveScreenshot('main-normal.png')

  // A pin selects its spot: the card expands and the URL records it. White Oak Twp Park sits alone west of
  // the cluster, so its pin is never under another pin.
  const pinned = 'White Oak Twp Park'
  await map.getByRole('button', { name: pinned, exact: true }).click()
  await expect(page).toHaveURL(/spot=/)
  const pinnedCard = cards.filter({ hasText: pinned }).first()
  await expect(pinnedCard.getByRole('button', { expanded: true })).toBeVisible()
  await pinnedCard.getByRole('button', { expanded: true }).click()
  await expect(pinnedCard.getByRole('button', { expanded: false })).toBeVisible()

  // Expand the first card: Directions points at Google Maps (non-iOS user agent).
  const head = cards.first().getByRole('button', { expanded: false })
  await head.click()
  await expect(cards.first().getByRole('button', { expanded: true })).toBeVisible()
  const directions = cards.first().getByRole('link', { name: 'Directions' })
  await expect(directions).toBeVisible()
  if (testInfo.project.name === 'desktop') {
    expect(await directions.getAttribute('href')).toContain('google.com/maps/dir')
  }
  expect(await shadowedElements(page)).toEqual([])
  // The hour-by-hour bar: equal columns, none cut in half at the right edge at rest.
  const scrubber = cards.first().locator('.scrubber')
  await expect(scrubber).toBeVisible()
  const cols = await scrubber.evaluate((ol) => {
    const box = ol.getBoundingClientRect()
    const hours = [...ol.querySelectorAll('.scrubber-hour')].map((li) => li.getBoundingClientRect())
    return {
      widths: hours.map((r) => r.width),
      cut: hours.filter((r) => r.left < box.right - 0.5 && r.right > box.right + 0.5).length,
    }
  })
  expect(Math.max(...cols.widths) - Math.min(...cols.widths)).toBeLessThan(0.5)
  expect(cols.cut).toBe(0)
  await scrubber.screenshot({ path: testInfo.outputPath('scrubber.png') })

  // Second night chip refetches with ?night=.
  const nights = page.getByRole('group', { name: 'Choose a night' }).getByRole('button')
  await expect(nights).toHaveCount(7)
  await expect(nights.first()).toHaveText(/Tonight/)
  const nightReq = page.waitForRequest(spotsRequest((q) => q.get('night') === NIGHT2))
  await nights.nth(1).click()
  await nightReq
  await expect(nights.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(new RegExp(`night=${NIGHT2}`))

  // Drive slider to 60 min refetches with max_drive=60.
  const driveReq = page.waitForRequest(spotsRequest((q) => q.get('max_drive') === '60'))
  await page.getByRole('slider').fill('60')
  await driveReq
  await expect(page.getByText('Within 60 min')).toBeVisible()
  await expect(page).toHaveURL(/drive=60/)

  // Red mode tints the page; the glow stays on, drawn from the red pictures (URL setting untouched).
  const glowBtn = page.getByRole('button', { name: 'Light pollution glow' })
  await settle(page)
  const beforeRed = requested.length
  await page.getByRole('switch', { name: 'Red mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-red', 'true')
  await expect(glowBtn).toBeEnabled()
  await expect(glowBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(page).not.toHaveURL(/glow=0/)
  await settle(page)
  // Every map picture is a red variant (base_glow_red); the normal ones are gone.
  await expect.poll(() => mapSrcs(page)).toEqual([expect.stringMatching(/\/base_glow_red_874\.webp$/)])
  // The level-1 tiles are red too, and red mode requested only red files.
  const redTiles = await tileSrcs(page)
  expect(redTiles.length > 0).toBe((await pictureWidth(page)) > 874)
  if (testInfo.project.name === 'desktop') expect(redTiles.length).toBeGreaterThan(0)
  for (const src of redTiles) expect(src).toMatch(/\/base_glow_red_L1_[01]_[01]\.webp$/)
  const redRequests = picturesSince(requested, beforeRed)
  if (redTiles.length > 0) expect(redRequests).toContainEqual(expect.stringMatching(/\/base_glow_red_L1_\d_\d\.webp$/))
  for (const url of redRequests) expect(url).toContain('_red_')
  expect(await nonRedColors(page)).toEqual([])
  // Colour emoji (the Canada flag) cannot take a token colour; red mode tints them with a CSS filter.
  const flag = page.locator('.emoji').first()
  await expect(flag).toBeVisible()
  expect(await flag.evaluate((el) => getComputedStyle(el).filter)).toMatch(/sepia/)
  await page.screenshot({ path: testInfo.outputPath('main-red-full.png'), fullPage: true })
  await expect(page).toHaveScreenshot('main-red.png')

  // Crosses country border off refetches with border=exclude.
  const borderReq = page.waitForRequest(spotsRequest((q) => q.get('border') === 'exclude'))
  await page.getByRole('button', { name: 'More filters' }).click()
  await expect(page.getByRole('switch', { name: 'Crosses country border' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('switch', { name: 'Crosses country border' }).click()
  await borderReq
  await expect(page.getByRole('button', { name: 'More filters (1 on)' })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('switch', { name: 'Crosses country border' })).toHaveAttribute('aria-checked', 'false')
  await expect(page).toHaveURL(/border=exclude/)
  await settle(page)

  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  expect(await shadowedElements(page)).toEqual([])

  // Leaving red mode keeps the glow on, now from the normal-colour pictures.
  await page.getByRole('switch', { name: 'Red mode' }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-red', 'true')
  await expect(glowBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.emoji').first()).toHaveCSS('filter', 'none')
  await expect.poll(() => mapSrcs(page)).toEqual([expect.stringMatching(/\/base_glow_874\.webp$/)])

  // Glow off: the plain base pictures (and tiles); on again: the composites. Never an overlay picture.
  await glowBtn.click()
  await expect(glowBtn).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => mapSrcs(page)).toEqual([expect.stringMatching(/\/base_874\.webp$/)])
  await settle(page)
  for (const src of await tileSrcs(page)) expect(src).toMatch(/\/base_L1_[01]_[01]\.webp$/)
  await glowBtn.click()
  await expect(glowBtn).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => mapSrcs(page)).toEqual([expect.stringMatching(/\/base_glow_874\.webp$/)])
  await settle(page)
  for (const src of await tileSrcs(page)) expect(src).toMatch(/\/base_glow_L1_[01]_[01]\.webp$/)

  // Back in red mode with a card expanded, the card and the map chrome (pins, start, labels, buttons) stay red-only.
  await cards.first().getByRole('button', { expanded: false }).click()
  await expect(page).toHaveURL(/spot=/)
  await settle(page)
  const beforeRedAgain = requested.length
  await page.getByRole('switch', { name: 'Red mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-red', 'true')
  await expect(glowBtn).toHaveAttribute('aria-pressed', 'true')
  await settle(page)
  for (const src of [...(await mapSrcs(page)), ...(await tileSrcs(page))]) expect(src).toContain('_red_')
  for (const url of picturesSince(requested, beforeRedAgain)) expect(url).toContain('_red_')
  expect(await nonRedColors(page)).toEqual([])

  // Only the manifest, labels and pictures were fetched, all successfully; never a glow overlay.
  await page.waitForLoadState('networkidle')
  expect(requested.filter(overlay)).toEqual([])
  expect(tiles.filter((t) => t.status !== 200 && t.status !== 304)).toEqual([])
  expect(errors).toEqual([])
})

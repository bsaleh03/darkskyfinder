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

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('main[aria-busy="true"]')).toHaveCount(0)
}

const mapMask = (page: Page) => [page.locator('.maplibregl-canvas'), page.locator('.maplibregl-marker')]

test('search, pick a start, explore nights, filters and red mode', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))

  await page.clock.setFixedTime(CAPTURED_AT)
  await mockApi(page)
  await page.goto('/')

  // Search from the Welcome screen and pick the Royal Oak locality.
  await expect(page.getByRole('heading', { name: "Where's the closest dark sky tonight?" })).toBeVisible()
  const search = page.getByRole('combobox', { name: 'Search for a place' })
  await search.fill('Royal Oak')
  const option = page.getByRole('option', { name: /^Royal Oak locality · SE Michigan$/ })
  await expect(option).toBeVisible()
  await option.click()

  // Results: verdict and the ranked list.
  await expect(page.getByRole('region', { name: 'Night verdict' })).toBeVisible()
  const cards = page.getByRole('article')
  await expect(cards.first()).toBeVisible()
  expect(await cards.count()).toBeGreaterThanOrEqual(3)
  await expect(page).toHaveURL(/lat=42\.5072679&lon=-83\.15047897440644/)
  await expect(page.getByRole('button', { name: 'Royal Oak', exact: true })).toBeVisible() // start chip in the TopBar
  await expect(page.getByRole('switch', { name: 'Include Canada' })).toHaveAttribute('aria-checked', 'true')
  await settle(page)
  // No horizontal page scroll at either width (night chips scroll inside their own row).
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: testInfo.outputPath('main-normal-full.png'), fullPage: true })
  await expect(page).toHaveScreenshot('main-normal.png', { mask: mapMask(page) })

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

  // Red mode tints the page and turns the glow layer off.
  await page.getByRole('switch', { name: 'Red mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-red', 'true')
  await expect(page).toHaveURL(/glow=0/)
  await settle(page)
  await page.screenshot({ path: testInfo.outputPath('main-red-full.png'), fullPage: true })
  await expect(page).toHaveScreenshot('main-red.png', { mask: mapMask(page) })

  // Include Canada off refetches with border=exclude.
  const borderReq = page.waitForRequest(spotsRequest((q) => q.get('border') === 'exclude'))
  await page.getByRole('switch', { name: 'Include Canada' }).click()
  await borderReq
  await expect(page.getByRole('switch', { name: 'Include Canada' })).toHaveAttribute('aria-checked', 'false')
  await expect(page).toHaveURL(/border=exclude/)
  await settle(page)

  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  expect(await shadowedElements(page)).toEqual([])
  expect(errors).toEqual([])
})

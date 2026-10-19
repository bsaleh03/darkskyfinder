import { expect, test } from 'vitest'
import { chooseLevel, chooseWidth, coverView, fitBox, fitClear, frameView, visibleTiles } from '../../src/map/framing'
import { toFraction } from '../../src/map/projection'

const B: [number, number, number, number] = [-86.9, 41.65, -82.4, 45.9]
const start = { lon: -84.5, lat: 43.5 }

test('frameView keeps points inside even past the extent', () => {
  const far = { lon: B[2] + 0.2, lat: 43.6 }
  expect(toFraction(far, B).x).toBeGreaterThan(1)
  const box = frameView([far], start, 60, B)
  const f = toFraction(far, B)
  expect(box.x1).toBeGreaterThanOrEqual(f.x)
  expect(box.x0).toBeLessThanOrEqual(toFraction(start, B).x)
})

test('frameView enforces a minimum 25 km span on each axis', () => {
  const a = { lon: -84.5, lat: 43.5 }
  const b = { lon: -84.5 + 1 / 82, lat: 43.5 } // ~1 km east
  const box = frameView([b], a, 60, B)
  const R = 6371
  const kmX = R * ((B[2] - B[0]) * Math.PI) / 180 * Math.cos((43.5 * Math.PI) / 180)
  expect((box.x1 - box.x0) * kmX).toBeGreaterThanOrEqual(25 - 1e-6)
  const m = (l: number) => Math.log(Math.tan(Math.PI / 4 + (l * Math.PI) / 360))
  const kmY = R * Math.cos((43.5 * Math.PI) / 180) * (m(B[3]) - m(B[1]))
  expect((box.y1 - box.y0) * kmY).toBeGreaterThanOrEqual(25 - 1e-6)
})

test('frameView with no points spans driveMinutes x 1.2 km half-width', () => {
  const box = frameView([], start, 90, B)
  const R = 6371
  const kmX = R * ((B[2] - B[0]) * Math.PI) / 180 * Math.cos((43.5 * Math.PI) / 180)
  expect((box.x1 - box.x0) * kmX).toBeCloseTo(216, 3)
  const c = toFraction(start, B)
  expect((box.x0 + box.x1) / 2).toBeCloseTo(c.x, 9)
  expect((box.y0 + box.y1) / 2).toBeCloseTo(c.y, 9)
})

test('fitBox fills a square view from a quarter box', () => {
  const r = fitBox({ x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }, 400, 400, 1)
  expect(r.imgW).toBeCloseTo(800)
  expect(r.imgH).toBeCloseTo(800)
  expect(r.left).toBeCloseTo(-200)
  expect(r.top).toBeCloseTo(-200)
})

test('fitBox expands the short axis for a non-square view', () => {
  const r = fitBox({ x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }, 800, 400, 1)
  expect(r.imgW).toBeCloseTo(800)
  expect(r.left).toBeCloseTo(0)
  expect(r.top).toBeCloseTo(-200)
})

test('chooseWidth picks smallest sufficient width, else largest', () => {
  expect(chooseWidth([875, 1750, 3500], 400, 2)).toBe(875)
  expect(chooseWidth([875, 1750, 3500], 600, 2)).toBe(1750)
  expect(chooseWidth([875, 1750, 3500], 3000, 3)).toBe(3500)
})

const LEVELS = [
  { level: 0, cols: 1, rows: 1 },
  { level: 1, cols: 2, rows: 2 },
]

test('chooseLevel: smallest level whose full width covers the picture at the device pixel ratio, else the highest', () => {
  expect(chooseLevel(LEVELS, 3496, 1000, 2)).toBe(0) // 2000 device px <= 3496
  expect(chooseLevel(LEVELS, 3496, 3496, 1)).toBe(0) // exactly the level-0 full width
  expect(chooseLevel(LEVELS, 3496, 3497, 1)).toBe(1)
  expect(chooseLevel(LEVELS, 3496, 1749, 2)).toBe(1) // 3498 device px
  expect(chooseLevel(LEVELS, 3496, 4000, 2)).toBe(1) // past level 1 (6992): the highest there is
  expect(chooseLevel([...LEVELS].reverse(), 3496, 2000, 2)).toBe(1) // order of the list does not matter
  expect(chooseLevel([LEVELS[0]], 3496, 9000, 3)).toBe(0) // a level-0-only (v1) picture
})

test('visibleTiles: the tiles a centered view touches are all four', () => {
  expect(visibleTiles(1, 2, 2, { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 })).toEqual([
    { col: 0, row: 0 },
    { col: 1, row: 0 },
    { col: 0, row: 1 },
    { col: 1, row: 1 },
  ])
})

test('visibleTiles: a corner view touches only its corner tile; a shared edge does not count', () => {
  expect(visibleTiles(1, 2, 2, { x0: 0, y0: 0, x1: 0.3, y1: 0.3 })).toEqual([{ col: 0, row: 0 }])
  expect(visibleTiles(1, 2, 2, { x0: 0.6, y0: 0.7, x1: 0.9, y1: 0.95 })).toEqual([{ col: 1, row: 1 }])
  expect(visibleTiles(1, 2, 2, { x0: 0, y0: 0, x1: 0.5, y1: 0.5 })).toEqual([{ col: 0, row: 0 }])
})

test('visibleTiles: a view past the picture edges is clipped to the picture', () => {
  expect(visibleTiles(1, 2, 2, { x0: -0.5, y0: -0.5, x1: 0.2, y1: 1.5 })).toEqual([
    { col: 0, row: 0 },
    { col: 0, row: 1 },
  ])
  expect(visibleTiles(1, 2, 2, { x0: 1.2, y0: 0.2, x1: 1.5, y1: 0.4 })).toEqual([])
  expect(visibleTiles(0, 1, 1, { x0: -1, y0: -1, x1: 2, y1: 2 })).toEqual([{ col: 0, row: 0 }])
})

test('coverView: picture taller than the view never leaves a gap below or above it', () => {
  // The 522x1067 desktop pane from the bug report: picture 1115x1459 placed with its bottom at y=701.
  const f = coverView({ imgW: 1115, imgH: 1459, left: -205, top: -758 }, 522, 1067)
  expect(f.top).toBe(1067 - 1459)
  expect(f.left).toBe(-205)
  expect(coverView({ imgW: 1115, imgH: 1459, left: -205, top: 40 }, 522, 1067).top).toBe(0)
})

test('coverView: picture narrower than the view is centred on that axis, size unchanged', () => {
  const f = coverView({ imgW: 400, imgH: 600, left: 300, top: -100 }, 800, 500)
  expect(f.left).toBe(200)
  expect(f.top).toBe(-100)
  expect(f.imgW).toBe(400)
})

test('fitClear: spots near the picture south edge in a tall view leave no empty band below the picture', () => {
  // Tall, narrow view; the box hugs the bottom of the picture, so a centred contain-fit would end the picture mid-view.
  const f = fitClear({ x0: 0.3, y0: 0.6, x1: 0.7, y1: 0.98 }, 500, 1000, 0, 1.3, [{ x: 0.5, y: 0.9, r: 10 }], [])
  expect(f.top + f.imgH).toBeGreaterThanOrEqual(1000)
})

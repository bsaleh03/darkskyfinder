import { expect, test } from 'vitest'
import { chooseWidth, fitBox, frameView } from '../../src/map/framing'
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

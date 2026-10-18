import { expect, test } from 'vitest'
import { toFraction } from '../../src/map/projection'

const B: [number, number, number, number] = [-86.9, 41.65, -82.4, 45.9]
const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

test('toFraction maps corners: north-west to (0,0), south-east to (1,1)', () => {
  const nw = toFraction({ lon: B[0], lat: B[3] }, B)
  const se = toFraction({ lon: B[2], lat: B[1] }, B)
  expect(nw.x).toBeCloseTo(0, 9)
  expect(nw.y).toBeCloseTo(0, 9)
  expect(se.x).toBeCloseTo(1, 9)
  expect(se.y).toBeCloseTo(1, 9)
})

test('toFraction at a mid-latitude point matches Mercator', () => {
  const p = toFraction({ lon: -84.65, lat: 43.5 }, B)
  expect(p.x).toBeCloseTo(0.5, 6)
  expect(p.y).toBeCloseTo((merc(B[3]) - merc(43.5)) / (merc(B[3]) - merc(B[1])), 6)
  expect(p.y).not.toBeCloseTo((B[3] - 43.5) / (B[3] - B[1]), 3)
})

import { expect, test } from 'vitest'
import type { Region } from '../../src/api/types'
import { regionBounds, styleChange, unionBounds } from '../../src/map/helpers'

const r = (key: string, bbox: number[]): Region => ({ key, name: key, bbox, center: [0, 0], zoom: 8, timezone: 'UTC' })

test('regionBounds returns [[w,s],[e,n]]', () => {
  expect(regionBounds(r('a', [-84, 41, -82, 43]))).toEqual([[-84, 41], [-82, 43]])
})

test('unionBounds covers all regions, null when empty', () => {
  expect(unionBounds([])).toBeNull()
  expect(unionBounds([r('a', [-84, 41, -82, 43]), r('b', [-123, 37, -121, 38])])).toEqual([[-123, 37], [-82, 43]])
})

test('styleChange: none / glow / restyle', () => {
  const a = { glow: true, red: false }
  expect(styleChange(a, { glow: true, red: false })).toBe('none')
  expect(styleChange(a, { glow: false, red: false })).toBe('glow')
  expect(styleChange(a, { glow: true, red: true })).toBe('restyle')
  expect(styleChange(a, { glow: false, red: true })).toBe('restyle')
})

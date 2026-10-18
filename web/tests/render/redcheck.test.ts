import { describe, expect, it } from 'vitest'
import { clampRed, redViolations } from '../../render/redcheck'

describe('redViolations', () => {
  it('counts opaque pixels whose green or blue exceeds half of red', () => {
    expect(redViolations(new Uint8Array([255, 0, 0, 255, 100, 90, 0, 255]))).toBe(1)
  })

  it('ignores fully transparent pixels', () => {
    expect(redViolations(new Uint8Array([0, 255, 255, 0, 10, 0, 200, 0]))).toBe(0)
  })

  it('checks blue too and accepts exactly half', () => {
    expect(redViolations(new Uint8Array([100, 50, 50, 1, 100, 0, 51, 1]))).toBe(1)
  })

  it('works on a Node Buffer', () => {
    expect(redViolations(Buffer.from([20, 20, 20, 255]))).toBe(1)
  })
})

describe('clampRed', () => {
  it('caps green and blue at half of red in place, leaving compliant and transparent pixels alone', () => {
    const px = new Uint8Array([100, 90, 70, 255, 200, 40, 10, 255, 3, 2, 2, 1, 0, 9, 9, 0])
    clampRed(px)
    expect([...px]).toEqual([100, 50, 50, 255, 200, 40, 10, 255, 3, 1, 1, 1, 0, 9, 9, 0])
    expect(redViolations(px)).toBe(0)
  })
})

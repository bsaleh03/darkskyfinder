import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseState, serializeState, useAppState } from '../../src/state/useAppState'

describe('parseState / serializeState', () => {
  it('round-trips full state', () => {
    const s = {
      start: { lat: 42.28, lon: -83.74 },
      night: '2026-10-20',
      drive: 120,
      sort: 'best_view' as const,
      access: 'likely' as const,
      border: 'exclude' as const,
      glow: false,
      spot: 'abc123',
    }
    expect(parseState(serializeState(s))).toEqual(s)
  })

  it('defaults when empty', () => {
    expect(parseState('')).toEqual({
      start: null,
      night: null,
      drive: 90,
      sort: 'relevant',
      access: 'all',
      border: 'include',
      glow: true,
      spot: null,
    })
    expect(serializeState(parseState(''))).toBe('')
  })

  it('invalid values fall back to defaults', () => {
    expect(parseState('?drive=abc').drive).toBe(90)
    expect(parseState('?drive=500').drive).toBe(180)
    expect(parseState('?drive=37').drive).toBe(30)
    expect(parseState('?drive=50').drive).toBe(45)
    expect(parseState('?sort=weird').sort).toBe('relevant')
    expect(parseState('?access=weird').access).toBe('all')
    expect(parseState('?access=verified').access).toBe('verified')
    expect(parseState('?border=weird').border).toBe('include')
    expect(parseState('?lat=200&lon=10').start).toBeNull()
    expect(parseState('?lat=10&lon=-181').start).toBeNull()
    expect(parseState('?lat=10').start).toBeNull()
    expect(parseState('?lat=x&lon=y').start).toBeNull()
    expect(parseState('?night=2026-13-45').night).toBeNull()
    expect(parseState('?night=2026-02-30').night).toBeNull()
    expect(parseState('?night=tonight').night).toBeNull()
    expect(parseState('?glow=0').glow).toBe(false)
    expect(parseState('?glow=maybe').glow).toBe(true)
  })
})

describe('useAppState', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'))
  afterEach(() => vi.restoreAllMocks())

  it('push vs replace', () => {
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useAppState())
    act(() => result.current[1]({ sort: 'closest' }))
    expect(push).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?sort=closest')
    expect(result.current[0].sort).toBe('closest')
    act(() => result.current[1]({ drive: 60 }, { replace: true }))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe('?drive=60&sort=closest')
  })

  it('popstate updates state', () => {
    const { result } = renderHook(() => useAppState())
    act(() => {
      window.history.replaceState(null, '', '/?sort=best_view')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(result.current[0].sort).toBe('best_view')
  })
})

import { act, cleanup, renderHook } from '@testing-library/react'
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
      stateBorder: 'exclude' as const,
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
      stateBorder: 'include',
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
    expect(parseState('?state_border=weird').stateBorder).toBe('include')
    expect(parseState('?state_border=exclude').stateBorder).toBe('exclude')
    expect(serializeState(parseState('?state_border=exclude'))).toBe('state_border=exclude')
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
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

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

  it('skips the push when nothing changes', () => {
    window.history.replaceState(null, '', '/?drive=60&sort=closest')
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useAppState())
    act(() => result.current[1]({ drive: 60 }))
    act(() => result.current[1]({ sort: 'closest', drive: 65 })) // normalizes back to the same URL
    act(() => result.current[1]({ drive: 60 }, { replace: true }))
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    act(() => result.current[1]({ drive: 75 }))
    expect(push).toHaveBeenCalledTimes(1)
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

describe('useAppState shared store', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shares state across components', () => {
    const a = renderHook(() => useAppState())
    const b = renderHook(() => useAppState())
    act(() => a.result.current[1]({ sort: 'closest' }))
    expect(b.result.current[0].sort).toBe('closest')
    act(() => b.result.current[1]({ glow: false }))
    expect(a.result.current[0]).toMatchObject({ sort: 'closest', glow: false })
    expect(window.location.search).toBe('?sort=closest&glow=0')
  })

  it('normalizes patches', () => {
    const { result } = renderHook(() => useAppState())
    act(() => result.current[1]({ drive: 37 }))
    expect(result.current[0].drive).toBe(30)
    expect(window.location.search).toBe('?drive=30')
  })

  it('removes popstate listener after last unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const a = renderHook(() => useAppState())
    const b = renderHook(() => useAppState())
    expect(add.mock.calls.filter((c) => c[0] === 'popstate')).toHaveLength(1)
    a.unmount()
    expect(remove.mock.calls.filter((c) => c[0] === 'popstate')).toHaveLength(0)
    b.unmount()
    expect(remove.mock.calls.filter((c) => c[0] === 'popstate')).toHaveLength(1)
  })
})

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedMode } from '../../src/state/redMode'

describe('useRedMode', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.red
  })
  afterEach(() => vi.restoreAllMocks())

  it('persists and sets data-red', () => {
    const { result } = renderHook(() => useRedMode())
    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(localStorage.getItem('dsf.red')).toBe('1')
    expect(document.documentElement.dataset.red).toBe('true')
    act(() => result.current[1](false))
    expect(document.documentElement.dataset.red).toBeUndefined()
    const again = renderHook(() => useRedMode())
    expect(again.result.current[0]).toBe(false)
    localStorage.setItem('dsf.red', '1')
    expect(renderHook(() => useRedMode()).result.current[0]).toBe(true)
  })

  it('survives missing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { result } = renderHook(() => useRedMode())
    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(document.documentElement.dataset.red).toBe('true')
  })
})

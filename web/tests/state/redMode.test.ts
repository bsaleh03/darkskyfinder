import { act, cleanup, renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedMode } from '../../src/state/redMode'

describe('useRedMode', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.red
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

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

  it('stays in sync across components', () => {
    const a = renderHook(() => useRedMode())
    const b = renderHook(() => useRedMode())
    act(() => a.result.current[1](true))
    expect(b.result.current[0]).toBe(true)
    expect(document.documentElement.dataset.red).toBe('true')
    act(() => b.result.current[1](false))
    expect(a.result.current[0]).toBe(false)
    expect(document.documentElement.dataset.red).toBeUndefined()
  })
})

describe('red mode before first paint', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
  const head = html.slice(0, html.indexOf('</head>'))
  const inline = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const run = () => new Function(inline.join(';'))()

  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.red
  })
  afterEach(() => vi.restoreAllMocks())

  it('index.html applies the stored choice in <head>, before styles and the app load', () => {
    expect(inline).toHaveLength(1)
    const at = head.indexOf('<script>')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(head.indexOf('stylesheet'))
    localStorage.setItem('dsf.red', '1')
    run()
    expect(document.documentElement.dataset.red).toBe('true')
    // and the store agrees with what was painted
    expect(renderHook(() => useRedMode()).result.current[0]).toBe(true)
  })

  it('leaves normal mode alone and survives blocked storage', () => {
    localStorage.setItem('dsf.red', '0')
    run()
    expect(document.documentElement.dataset.red).toBeUndefined()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(run).not.toThrow()
    expect(document.documentElement.dataset.red).toBeUndefined()
  })
})

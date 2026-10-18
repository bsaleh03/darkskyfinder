import { act } from '@testing-library/react'
import { vi } from 'vitest'

type Entry = { target: Element; contentRect: { width: number; height: number } }
type Cb = (entries: Entry[]) => void

/**
 * jsdom has no layout: stub ResizeObserver (reporting a fixed view size, like a real observer's first callback)
 * and devicePixelRatio. Undo with restoreView().
 */
export function stubView(width: number, height: number, dpr = 1) {
  let size = { width, height }
  const live = new Set<{ cb: Cb; el: Element }>()
  class StubResizeObserver {
    private entry: { cb: Cb; el: Element } | null = null
    constructor(private cb: Cb) {}
    observe(el: Element) {
      this.entry = { cb: this.cb, el }
      live.add(this.entry)
      this.cb([{ target: el, contentRect: size }])
    }
    unobserve() {}
    disconnect() {
      if (this.entry) live.delete(this.entry)
    }
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true })
  return {
    resize(w: number, h: number) {
      size = { width: w, height: h }
      act(() => live.forEach((o) => o.cb([{ target: o.el, contentRect: size }])))
    },
  }
}

export function restoreView() {
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
}

import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineHour } from '../../src/api/types'
import { NightScrubber, scrubberColumn, SCRUBBER_GAP, SCRUBBER_MIN_COL } from '../../src/components/NightScrubber'
import { restoreView, stubView } from '../viewStub'

const hour = (h: number, over: Partial<TimelineHour> = {}): TimelineHour =>
  ({
    time: `2026-10-17T${String(h).padStart(2, '0')}:00:00-04:00`,
    quality: 0.7,
    cloud: 10,
    fog: false,
    moon_up: false,
    past: false,
    ...over,
  }) as TimelineHour

const NIGHT = [18, 19, 20, 21, 22, 23].map((h) => hour(h))

function show(timeline: TimelineHour[] = NIGHT) {
  return render(<NightScrubber timeline={timeline} bestWindow={null} timezone="America/Detroit" />)
}
const list = (c: HTMLElement) => c.querySelector<HTMLElement>('.scrubber')!
const wrap = (c: HTMLElement) => c.querySelector<HTMLElement>('.scrubber-wrap')!

afterEach(() => restoreView())

describe('scrubberColumn', () => {
  it('fits a whole number of equal columns into the view, so the last one is never cut at rest', () => {
    const w = scrubberColumn(300, 12)!
    const n = Math.round((300 + SCRUBBER_GAP) / (w + SCRUBBER_GAP))
    expect(n * w + (n - 1) * SCRUBBER_GAP).toBeCloseTo(300, 6)
    expect(w).toBeGreaterThanOrEqual(SCRUBBER_MIN_COL)
    expect(w).toBeLessThan(SCRUBBER_MIN_COL + SCRUBBER_MIN_COL / n + SCRUBBER_GAP)
  })

  it('a short night shares the whole width', () => {
    expect(scrubberColumn(300, 3)).toBeCloseTo((300 - 2 * SCRUBBER_GAP) / 3, 6)
  })

  it('no width yet: no column size (CSS default)', () => {
    expect(scrubberColumn(0, 6)).toBeNull()
  })
})

describe('NightScrubber', () => {
  it('sets the measured equal column width on the list', () => {
    stubView(300, 100)
    const { container } = show()
    expect(list(container).style.getPropertyValue('--scrubber-col')).toBe(`${scrubberColumn(300, NIGHT.length)}px`)
  })

  it('every hour has the same three icon rows (cloud, fog, moon), empty when absent, so they line up', () => {
    const { container } = show([hour(21, { fog: true, moon_up: true }), hour(22), hour(23, { cloud: null })])
    const rows = [...container.querySelectorAll('.scrubber-hour')].map((li) =>
      [...li.querySelectorAll('.scrubber-icon')].map((s) => s.textContent),
    )
    expect(rows).toEqual([
      ['☁︎10', 'fog', '☾︎'],
      ['☁︎10', '', ''],
      ['', '', ''],
    ])
  })

  it('fades the right edge while more hours are off-screen', () => {
    const { container } = show()
    const ol = list(container)
    Object.defineProperty(ol, 'clientWidth', { value: 300, configurable: true })
    Object.defineProperty(ol, 'scrollWidth', { value: 600, configurable: true })
    ol.scrollLeft = 0
    fireEvent.scroll(ol)
    expect(wrap(container).className).toContain('scrubber-wrap--more')
    ol.scrollLeft = 300
    fireEvent.scroll(ol)
    expect(wrap(container).className).not.toContain('scrubber-wrap--more')
  })

  it('labels on-the-hour times compactly so they fit the column (the full time stays in the accessible name)', () => {
    const { container, getByLabelText } = show([hour(21), hour(22), { ...hour(23), time: '2026-10-17T23:30:00-04:00' }])
    expect([...container.querySelectorAll('.scrubber-time')].map((t) => t.textContent)).toEqual(['9 PM', '10 PM', '11:30 PM'])
    expect(getByLabelText('10:00 PM, good, cloud 10%')).toBeTruthy()
  })

  it('no fade when every hour fits', () => {
    const { container } = show()
    expect(wrap(container).className).not.toContain('scrubber-wrap--more')
  })
})

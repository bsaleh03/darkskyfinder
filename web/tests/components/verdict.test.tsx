import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Verdict } from '../../src/api/types'
import { NightPicker, nextNights, nightLabel } from '../../src/components/NightPicker'
import { VerdictCard } from '../../src/components/VerdictCard'

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  rating: 'good',
  sentence: 'Great night for stars.',
  best_window: { start: '2026-10-17T21:00-04:00', end: '2026-10-17T23:30-04:00' },
  moon: { illumination: 0.18, rise: '2026-10-17T07:00-04:00', set: '2026-10-17T22:26-04:00' },
  dark: { start: '2026-10-17T20:30-04:00', end: '2026-10-18T06:00-04:00', kind: 'astronomical' },
  ...over,
})

const card = (v: Verdict, extra: Partial<Parameters<typeof VerdictCard>[0]> = {}) =>
  render(<VerdictCard verdict={v} forecastStatus="ok" driveStatus="ok" timezone="America/Detroit" {...extra} />)

describe('NightPicker helpers', () => {
  it('labels tonight and weekdays', () => {
    const nights = nextNights('2026-10-17')
    expect(nights).toHaveLength(7)
    expect(nights[0]).toBe('2026-10-17')
    expect(nights[6]).toBe('2026-10-23')
    expect(nightLabel('2026-10-17', '2026-10-17')).toBe('Tonight')
    expect(nightLabel('2026-10-18', '2026-10-17')).toBe('Sun 18')
    expect(nextNights('2026-12-30', 3)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01'])
  })
})

describe('NightPicker', () => {
  it('dots have text labels', () => {
    const nights = nextNights('2026-10-17', 4)
    const onChange = vi.fn()
    render(
      <NightPicker
        nights={nights}
        value={nights[0]}
        dots={{ [nights[0]]: 'go', [nights[1]]: 'maybe', [nights[2]]: 'no' }}
        onChange={onChange}
      />,
    )
    expect(screen.getByText('good night')).toBeTruthy()
    expect(screen.getByText('maybe')).toBeTruthy()
    expect(screen.getByText('poor night')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: /Sun 18/ }))
    expect(onChange).toHaveBeenCalledWith('2026-10-18')
    expect(screen.getByRole('button', { name: /Tonight/ }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('VerdictCard', () => {
  it('renders each rating with matching style class', () => {
    for (const rating of ['good', 'marginal', 'poor', 'unknown'] as const) {
      const { container, unmount } = card(verdict({ rating }))
      expect(container.querySelector(`.verdict--${rating}`)).not.toBeNull()
      unmount()
    }
    card(verdict())
    expect(screen.getByText('Great night for stars.')).toBeTruthy()
  })

  it('formats times in metro timezone', () => {
    const { unmount } = card(verdict())
    expect(screen.getByText(/9:00 PM/)).toBeTruthy()
    expect(screen.getByText(/11:30 PM/)).toBeTruthy()
    expect(screen.getByText('18% moon, sets 10:26 PM')).toBeTruthy()
    unmount()
    card(verdict(), { timezone: 'America/Los_Angeles' })
    expect(screen.getByText(/6:00 PM/)).toBeTruthy()
    expect(screen.getByText('18% moon, sets 7:26 PM')).toBeTruthy()
  })

  it('shows notes for unavailable forecast and approx drive', () => {
    card(verdict(), { forecastStatus: 'unavailable', driveStatus: 'approx' })
    expect(screen.getByText('Cloud forecast unavailable')).toBeTruthy()
    expect(screen.getByText('Some drive times are estimates (≈)')).toBeTruthy()
  })

  it('renders without best_window', () => {
    card(verdict({ best_window: null, moon: { illumination: 0.5, rise: null, set: null } }))
    expect(screen.queryByText(/Best window/)).toBeNull()
    expect(screen.getByText('50% moon')).toBeTruthy()
    expect(screen.queryByText('Cloud forecast unavailable')).toBeNull()
  })
})

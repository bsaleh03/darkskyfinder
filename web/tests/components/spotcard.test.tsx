import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Spot } from '../../src/api/types'
import { SpotCard } from '../../src/components/SpotCard'
import { starCount } from '../../src/components/SkyPreview'
import { directionsUrl } from '../../src/components/DirectionsButton'

const hour = (h: number, past: boolean) => ({
  time: `2026-10-17T${String(h).padStart(2, '0')}:00:00-04:00`,
  quality: 0.7,
  cloud: 10,
  fog: false,
  moon_up: false,
  past,
})

const spot = (over: Partial<Spot> = {}): Spot => ({
  id: 's1',
  name: 'Lake Park',
  display_name: 'Lake Park Beach',
  area: 'Oakland County',
  country: 'US',
  crosses_border: false,
  recommended: false,
  sources: [],
  category: 'park',
  lon: -83.5,
  lat: 42.5,
  sqm: 21.4,
  bortle: 3,
  sky_label: 'vivid',
  radiance: 0.2,
  glare: { buildings_1km: 3, highway_m: 800, penalty: 0.1 },
  horizon: { class: 'open', open_frac: 0.8, closed_frac: 0.1, water_frac: 0.1 },
  access: { badge: 'likely', road_class: 'service', paved: true, parking: true, note: 'Gate open at night' },
  dark_sky_place: false,
  unavailable: false,
  unavailable_reason: null,
  amenities: { restroom: { name: 'Toilets', km: 0.3 }, fuel: null, food: null },
  why: ['Open horizon'],
  drive_minutes: 45,
  drive_is_estimate: false,
  darker_than_home: '2x darker than home',
  scores: { site: 0.8, conditions: 0.7, best_view: 0.75, relevant: 0.9 },
  timeline: [hour(20, true), hour(21, false), hour(22, false)],
  best_window: { start: '2026-10-17T21:00:00-04:00', end: '2026-10-17T22:00:00-04:00' },
  ...over,
})

const show = (s: Spot, extra: Partial<Parameters<typeof SpotCard>[0]> = {}) =>
  render(
    <SpotCard
      spot={s}
      homeSqm={19.5}
      homeLabel="Home"
      expanded={false}
      onToggle={() => {}}
      timezone="America/Detroit"
      {...extra}
    />,
  )

describe('SpotCard', () => {
  it('collapsed shows name, area, drive, sky label', () => {
    show(spot())
    expect(screen.getByText('Lake Park Beach')).toBeTruthy()
    expect(screen.getByText('Oakland County')).toBeTruthy()
    expect(screen.getByText('45 min')).toBeTruthy()
    expect(screen.getByText('vivid')).toBeTruthy()
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
  })

  it('estimated drive prefixed with ≈', () => {
    show(spot({ drive_is_estimate: true }))
    expect(screen.getByText('≈45 min')).toBeTruthy()
  })

  it('badges: dark sky, recommended, crosses border', () => {
    show(spot({ dark_sky_place: true, recommended: true, crosses_border: true }))
    expect(screen.getByText('Dark Sky place')).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    expect(screen.getByText(/Crosses border/)).toBeTruthy()
  })

  it('unavailable greyed with reason', () => {
    const { container } = show(spot({ unavailable: true, unavailable_reason: 'Road closed' }))
    expect(container.querySelector('.spot-card--unavailable')).not.toBeNull()
    expect(screen.getByText(/Not available right now/)).toBeTruthy()
    expect(screen.getByText(/Road closed/)).toBeTruthy()
  })

  it('expanded shows scrubber with past hours dimmed', () => {
    const { container } = show(spot(), { expanded: true })
    const hours = container.querySelectorAll('.scrubber-hour')
    expect(hours).toHaveLength(3)
    expect(hours[0].classList.contains('past')).toBe(true)
    expect(hours[1].classList.contains('past')).toBe(false)
    expect(container.querySelector('.scrubber-hour--best')).not.toBeNull()
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getByText('Milky Way casts shadows')).toBeTruthy()
  })

  it('sources open in new tab with rel noopener noreferrer', () => {
    show(spot({ sources: [{ name: 'Astro Club', url: 'https://example.com/a' }] }), { expanded: true })
    const a = screen.getByRole('link', { name: 'Astro Club' })
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders sparse spot without placeholders', () => {
    const sparse = spot({
      area: null,
      sources: [],
      timeline: [],
      why: [],
      darker_than_home: '',
      access: { badge: 'unknown', road_class: null, paved: null, parking: null, note: null },
      amenities: { restroom: null, fuel: null, food: null },
      best_window: null,
      scores: null,
      glare: { buildings_1km: 0, highway_m: null, penalty: 0 },
    })
    const { container } = show(sparse, { expanded: true, homeSqm: null })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/null|undefined|NaN/)
    expect(screen.getByRole('link', { name: /Directions/ })).toBeTruthy()
  })
})

describe('helpers', () => {
  it('starCount monotone and bounded', () => {
    expect(starCount(18)).toBe(6)
    expect(starCount(22)).toBe(120)
    expect(starCount(10)).toBe(6)
    expect(starCount(30)).toBe(120)
    let prev = 0
    for (let q = 17; q <= 23; q += 0.25) {
      const n = starCount(q)
      expect(n).toBeGreaterThanOrEqual(prev)
      prev = n
    }
  })

  it('directions per platform', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120'
    const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120'
    expect(directionsUrl(42.5, -83.5, iphone)).toBe('https://maps.apple.com/?daddr=42.5,-83.5')
    const g = 'https://www.google.com/maps/dir/?api=1&destination=42.5,-83.5'
    expect(directionsUrl(42.5, -83.5, android)).toBe(g)
    expect(directionsUrl(42.5, -83.5, desktop)).toBe(g)
    void fireEvent
  })
})

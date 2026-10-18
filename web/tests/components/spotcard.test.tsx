import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Spot } from '../../src/api/types'
import { SpotCard } from '../../src/components/SpotCard'
import { SkyPreview, starCount } from '../../src/components/SkyPreview'
import { directionsUrl } from '../../src/components/DirectionsButton'
import { darknessLabel, DarknessScale } from '../../src/components/DarknessScale'
import { NightScrubber } from '../../src/components/NightScrubber'

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
  crosses_state: false,
  recommended: false,
  sources: [],
  category: 'park',
  lon: -83.5,
  lat: 42.5,
  entry: null,
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

  it('badge: crosses state border only when crosses_state', () => {
    const { unmount } = show(spot({ crosses_state: false }))
    expect(screen.queryByText('Crosses state border')).toBeNull()
    unmount()
    show(spot({ crosses_state: true }))
    expect(screen.getByText('Crosses state border')).toBeTruthy()
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
    // The flag sits in its own span so red mode can tint it (html[data-red] .emoji filter).
    const flag = screen.getByText('\u{1F1E8}\u{1F1E6}')
    expect(flag.tagName).toBe('SPAN')
    expect(flag).toHaveClass('emoji')
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
    expect(hours[0].classList.contains('scrubber-hour--best')).toBe(false)
    expect(hours[1].classList.contains('scrubber-hour--best')).toBe(true)
    expect(hours[2].classList.contains('scrubber-hour--best')).toBe(false)
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getByText('Milky Way casts shadows')).toBeTruthy()
  })

  it('sources open in new tab with rel noopener noreferrer', () => {
    show(spot({ sources: [{ name: 'Astro Club', url: 'https://example.com/a' }] }), { expanded: true })
    const a = screen.getByRole('link', { name: 'Astro Club' })
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('sources with non-http URLs render as plain text', () => {
    show(
      spot({
        sources: [
          { name: 'Good', url: 'http://example.com/b' },
          { name: 'Script', url: 'javascript:alert(1)' },
          { name: 'Relative', url: '/local' },
          { name: 'Data', url: 'data:text/html,hi' },
        ],
      }),
      { expanded: true },
    )
    expect(screen.getByRole('link', { name: 'Good' })).toHaveAttribute('href', 'http://example.com/b')
    for (const name of ['Script', 'Relative', 'Data']) {
      expect(screen.getByText(name).closest('a')).toBeNull()
      expect(screen.queryByRole('link', { name })).toBeNull()
    }
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

describe('directions target', () => {
  it('uses the entrance when present', () => {
    show(spot({ entry: { lon: -83.6, lat: 42.6 } }), { expanded: true })
    const href = screen.getByRole('link', { name: /Directions/ }).getAttribute('href') ?? ''
    expect(href).toContain('42.6,-83.6')
    expect(href).not.toContain('42.5,-83.5')
  })
  it('falls back to the spot point when entry is null or missing', () => {
    show(spot({ entry: null }), { expanded: true })
    expect(screen.getByRole('link', { name: /Directions/ }).getAttribute('href')).toContain('42.5,-83.5')
  })
  it('treats a missing entry field as null', () => {
    const s = spot()
    delete (s as Partial<Spot>).entry
    show(s, { expanded: true })
    expect(screen.getByRole('link', { name: /Directions/ }).getAttribute('href')).toContain('42.5,-83.5')
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

  it('sky preview: darker sky reveals more stars over the same field', () => {
    const stars = (sqm: number) => {
      const { container, unmount } = render(<SkyPreview sqm={sqm} label="sky" size="large" seed={42} />)
      const pts = [...container.querySelectorAll('.sky-preview-star')].map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`)
      const band = container.querySelector('.sky-preview-milkyway') !== null
      const text = container.innerHTML
      unmount()
      return { pts, band, text }
    }
    const city = stars(18.3)
    const dark = stars(21.8)
    expect(dark.pts.length).toBeGreaterThan(city.pts.length * 4)
    // Same seed: every star visible from the city is also visible from the dark site.
    for (const p of city.pts) expect(dark.pts).toContain(p)
    expect(city.band).toBe(false)
    expect(dark.band).toBe(true)
    expect(stars(Number.NaN).text).not.toMatch(/NaN/)
  })

  it('directions per platform', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120'
    const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120'
    expect(directionsUrl(42.5, -83.5, iphone)).toBe('https://maps.apple.com/?daddr=42.5,-83.5')
    const g = 'https://www.google.com/maps/dir/?api=1&destination=42.5,-83.5'
    expect(directionsUrl(42.5, -83.5, android)).toBe(g)
    expect(directionsUrl(42.5, -83.5, desktop)).toBe(g)
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    expect(directionsUrl(42.5, -83.5, ipad, 5)).toBe('https://maps.apple.com/?daddr=42.5,-83.5')
    expect(directionsUrl(42.5, -83.5, ipad)).toBe(g)
    expect(directionsUrl(42.5, -83.5, ipad, 0)).toBe(g)
  })
})

describe('fix round 1', () => {
  it('darknessLabel cutoffs', () => {
    expect(darknessLabel(21.7)).toBe('Milky Way casts shadows')
    expect(darknessLabel(21.69)).toBe('Milky Way')
    expect(darknessLabel(20.4)).toBe('Milky Way')
    expect(darknessLabel(20.39)).toBe('A few stars')
    expect(darknessLabel(18.4)).toBe('A few stars')
    expect(darknessLabel(18.39)).toBe('City')
  })

  it('darkness scale accessible name carries both values', () => {
    const { rerender } = render(<DarknessScale homeSqm={19} spotSqm={21} />)
    expect(screen.getByRole('img', { name: 'Home: A few stars; this spot: Milky Way' })).toBeTruthy()
    rerender(<DarknessScale homeSqm={null} spotSqm={21} />)
    expect(screen.getByRole('img', { name: 'This spot: Milky Way' })).toBeTruthy()
  })

  it('darkness scale labels alternate rows so neighbours never overlap on narrow cards', () => {
    const { container } = render(<DarknessScale homeSqm={19} spotSqm={21} />)
    const labels = [...container.querySelectorAll('.darkness-label')]
    expect(labels.map((l) => l.textContent)).toEqual(['City', 'A few stars', 'Milky Way', 'Milky Way casts shadows'])
    // "Milky Way" (≈62% across) and the right-aligned "Milky Way casts shadows" sit on different rows.
    expect(labels.map((l) => l.classList.contains('darkness-label--lower'))).toEqual([false, true, false, true])
  })

  it('clicking header calls onToggle', () => {
    let n = 0
    show(spot(), { onToggle: () => void n++ })
    fireEvent.click(screen.getByRole('button'))
    expect(n).toBe(1)
  })

  it('scrubber aria-label includes fog and moon', () => {
    render(
      <NightScrubber
        timeline={[{ ...hour(21, false), fog: true, moon_up: true }]}
        bestWindow={null}
        timezone="America/Detroit"
      />,
    )
    expect(screen.getByLabelText('9:00 PM, good, cloud 10%, fog, moon up')).toBeTruthy()
    // Text presentation (U+FE0E) so the glyphs draw in the token colour, never as colour emoji.
    expect(screen.getByText('☁︎10')).toBeTruthy()
    expect(screen.getByText('☾︎')).toBeTruthy()
  })

  it('unavailable without reason and non-finite numbers stay clean', () => {
    const bad = spot({
      unavailable: true,
      unavailable_reason: null,
      sqm: NaN,
      bortle: NaN,
      radiance: NaN,
      drive_minutes: 30,
      amenities: { restroom: { name: 'WC', km: NaN }, fuel: null, food: null },
      timeline: [{ ...hour(21, false), cloud: null }],
    })
    const { container } = show(bad, { expanded: true })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/null|undefined|NaN/)
    expect(screen.getByText('Not available right now')).toBeTruthy()
  })
})

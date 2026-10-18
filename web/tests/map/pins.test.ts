import { describe, expect, it } from 'vitest'
import { pinColor } from '../../src/map/pins'
import type { Spot } from '../../src/api/types'

const mk = (id: string, sky_label: string, extra: Partial<Spot> = {}): Spot =>
  ({ id, sky_label, lat: 42, lon: -83, unavailable: false, dark_sky_place: false, ...extra }) as Spot

describe('pinColor', () => {
  it('colors by sky label, with or without the API "Milky Way" prefix', () => {
    expect(pinColor(mk('a', 'Milky Way vivid'))).toBe('#7FD6A0')
    expect(pinColor(mk('a', 'Milky Way visible'))).toBe('#F0C070')
    expect(pinColor(mk('a', 'faint'))).toBe('#F0A070')
    expect(pinColor(mk('a', 'Milky Way not visible'))).toBe('#F0808A')
    expect(pinColor(mk('a', 'unknown'))).toBe('#F0808A')
  })

  it('unavailable spots are grey', () => {
    expect(pinColor(mk('a', 'Milky Way vivid', { unavailable: true }))).toBe('#5A6280')
  })
})

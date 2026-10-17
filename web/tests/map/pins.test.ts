import { describe, expect, it } from 'vitest'
import { spotsToGeoJSON } from '../../src/map/pins'
import type { Spot } from '../../src/api/types'

const mk = (id: string, sky_label: string, extra: Partial<Spot> = {}): Spot =>
  ({ id, sky_label, lat: 42, lon: -83, unavailable: false, dark_sky_place: false, ...extra }) as Spot

describe('spotsToGeoJSON', () => {
  it('colors by sky label', () => {
    const fc = spotsToGeoJSON(
      [mk('a', 'vivid'), mk('b', 'visible'), mk('c', 'faint'), mk('d', 'not visible')],
      null,
    )
    expect(fc.features.map((f) => f.properties!.color)).toEqual(['#7FD6A0', '#F0C070', '#F0A070', '#F0808A'])
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [-83, 42] })
  })

  it('marks selected and unavailable', () => {
    const fc = spotsToGeoJSON([mk('a', 'vivid', { unavailable: true, dark_sky_place: true }), mk('b', 'vivid')], 'b')
    const [a, b] = fc.features.map((f) => f.properties!)
    expect(a).toMatchObject({ id: 'a', color: '#5A6280', selected: false, darkSky: true, unavailable: true })
    expect(b).toMatchObject({ id: 'b', color: '#7FD6A0', selected: true, darkSky: false, unavailable: false })
  })
})

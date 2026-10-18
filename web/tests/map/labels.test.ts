import { describe, expect, it } from 'vitest'
import { placeLabels, type MapLabel } from '../../src/map/labels'

// Identity projection: lon → x, lat → y (CSS px).
const toScreen = (p: { lon: number; lat: number }) => ({ x: p.lon, y: p.lat })
const label = (name: string, lon: number, lat: number, rank: number): MapLabel => ({ name, lon, lat, rank })

describe('placeLabels', () => {
  it('higher rank wins a collision', () => {
    // Listed least-important first: placement must follow rank, not input order.
    const placed = placeLabels(
      [label('Warren', 105, 52, 6), label('Detroit', 100, 50, 1), label('Ann Arbor', 300, 50, 7)],
      toScreen,
      400,
      200,
    )
    expect(placed.map((p) => p.label.name)).toEqual(['Detroit', 'Ann Arbor'])
    expect(placed[0]).toMatchObject({ x: 100, y: 50 })
  })

  it('keeps labels whose boxes do not overlap', () => {
    // "Detroit" is 7 chars → 49 px wide, 14 px tall, centered on its point.
    const placed = placeLabels([label('Detroit', 100, 50, 1), label('Toledo', 100, 65, 2)], toScreen, 400, 200)
    expect(placed.map((p) => p.label.name)).toEqual(['Detroit', 'Toledo'])
  })

  it('off-screen labels are dropped', () => {
    const placed = placeLabels(
      [label('West', -50, 50, 1), label('South', 200, 260, 2), label('Edge', 2, 50, 3), label('Inside', 200, 100, 4)],
      toScreen,
      400,
      200,
    )
    expect(placed.map((p) => p.label.name)).toEqual(['Inside'])
  })
})

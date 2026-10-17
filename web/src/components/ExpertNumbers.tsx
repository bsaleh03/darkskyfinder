import type { Spot } from '../api/types'

const num = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : null)

export function ExpertNumbers({ spot }: { spot: Spot }) {
  const { bortle, sqm, radiance, glare, horizon } = spot
  const glareParts = glare
    ? [
        Number.isFinite(glare.buildings_1km) ? `${glare.buildings_1km} buildings within 1 km` : null,
        glare.highway_m !== null && Number.isFinite(glare.highway_m) ? `highway ${Math.round(glare.highway_m)} m` : null,
      ].filter(Boolean)
    : []
  const rows: [string, string | null][] = [
    ['Bortle', Number.isFinite(bortle) ? String(bortle) : null],
    ['SQM', num(sqm, 2)],
    ['Radiance', num(radiance, 2)],
    ['Glare', glareParts.length > 0 ? glareParts.join(', ') : null],
    [
      'Horizon',
      horizon && horizon.class
        ? Number.isFinite(horizon.open_frac)
          ? `${horizon.class}, ${Math.round(horizon.open_frac * 100)}% open`
          : horizon.class
        : null,
    ],
  ]
  const shown = rows.filter((r): r is [string, string] => r[1] !== null)
  if (shown.length === 0) return null
  return (
    <div className="spot-section">
      <h4 className="spot-heading">The numbers</h4>
      <dl className="expert">
        {shown.map(([k, v]) => (
          <div key={k} className="expert-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

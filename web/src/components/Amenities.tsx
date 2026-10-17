import type { Amenity } from '../api/types'

type Kind = 'restroom' | 'fuel' | 'food'

const LABELS: [Kind, string][] = [
  ['restroom', 'Restroom'],
  ['fuel', 'Fuel'],
  ['food', 'Food'],
]

export function Amenities({ amenities }: { amenities: Record<Kind, Amenity | null> }) {
  const rows = LABELS.filter(([k]) => amenities[k])
  if (rows.length === 0) return null
  return (
    <div className="spot-section">
      <h4 className="spot-heading">Nearby</h4>
      <ul className="amenities">
        {rows.map(([k, label]) => {
          const a = amenities[k] as Amenity
          const km = Number.isFinite(a.km) ? ` · ${a.km.toFixed(1)} km` : ''
          return <li key={k}>{`${label}: ${a.name}${km}`}</li>
        })}
      </ul>
    </div>
  )
}

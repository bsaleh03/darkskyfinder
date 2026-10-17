const MIN = 17
const MAX = 22.5

const LABELS = ['City', 'A few stars', 'Milky Way', 'Milky Way casts shadows']

function pct(sqm: number): number {
  return Math.min(100, Math.max(0, ((sqm - MIN) / (MAX - MIN)) * 100))
}

interface Props {
  homeSqm: number | null
  spotSqm: number
  homeLabel?: string
}

export function DarknessScale({ homeSqm, spotSqm, homeLabel = 'Home' }: Props) {
  return (
    <div className="darkness-scale">
      <div className="darkness-track" role="img" aria-label="Darkness scale from city to Milky Way casts shadows">
        {homeSqm !== null && Number.isFinite(homeSqm) && (
          <span className="darkness-marker darkness-marker--home" style={{ left: `${pct(homeSqm)}%` }}>
            <span className="darkness-marker-label">{homeLabel}</span>
          </span>
        )}
        <span className="darkness-marker darkness-marker--spot" style={{ left: `${pct(spotSqm)}%` }}>
          <span className="darkness-marker-label">Spot</span>
        </span>
      </div>
      <ol className="darkness-labels">
        {LABELS.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ol>
    </div>
  )
}

const MIN = 17
const MAX = 22.5

const BANDS: { label: string; min: number }[] = [
  { label: 'City', min: -Infinity },
  { label: 'A few stars', min: 18.4 },
  { label: 'Milky Way', min: 20.4 },
  { label: 'Milky Way casts shadows', min: 21.7 },
]

export function darknessLabel(sqm: number): string {
  let out = BANDS[0].label
  for (const b of BANDS) if (sqm >= b.min) out = b.label
  return out
}

function pct(sqm: number): number {
  return Math.min(100, Math.max(0, ((sqm - MIN) / (MAX - MIN)) * 100))
}

interface Props {
  homeSqm: number | null
  spotSqm: number
  homeLabel?: string
}

export function DarknessScale({ homeSqm, spotSqm, homeLabel = 'Home' }: Props) {
  const hasHome = homeSqm !== null && Number.isFinite(homeSqm)
  const spotText = `${hasHome ? 't' : 'T'}his spot: ${darknessLabel(spotSqm)}`
  const name = hasHome ? `${homeLabel}: ${darknessLabel(homeSqm)}; ${spotText}` : spotText
  return (
    <div className="darkness-scale">
      <div className="darkness-track" role="img" aria-label={name}>
        {hasHome && (
          <span className="darkness-marker darkness-marker--home" style={{ left: `${pct(homeSqm)}%` }}>
            <span className="darkness-marker-label">{homeLabel}</span>
          </span>
        )}
        <span className="darkness-marker darkness-marker--spot" style={{ left: `${pct(spotSqm)}%` }}>
          <span className="darkness-marker-label">Spot</span>
        </span>
      </div>
      <ol className="darkness-labels" aria-hidden="true">
        {/* Alternate rows: on narrow cards "Milky Way" (≈62% across) would otherwise run into the
            right-aligned "Milky Way casts shadows" and read as "Milky Milky Way…". */}
        {BANDS.map((b, i) => {
          const end = i === BANDS.length - 1
          const cls = ['darkness-label', end && 'darkness-label--end', i % 2 === 1 && 'darkness-label--lower']
          return (
            <li
              key={b.label}
              className={cls.filter(Boolean).join(' ')}
              style={end ? undefined : { left: `${i === 0 ? 0 : pct(b.min)}%` }}
            >
              {b.label}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

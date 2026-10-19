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

/** Labels near an end anchor inward so they never clip at the card edge. */
function anchor(p: number): string {
  if (p < 25) return ' darkness-marker-label--start'
  if (p > 75) return ' darkness-marker-label--end'
  return ''
}

interface Props {
  homeSqm: number | null
  spotSqm: number
  homeLabel?: string
}

// Just two labels, each saying where its point falls: the spot above the bar, home below it, so they never
// collide. (A four-band legend crowded the bar on phones.)
export function DarknessScale({ homeSqm, spotSqm, homeLabel = 'Home' }: Props) {
  const hasHome = homeSqm !== null && Number.isFinite(homeSqm)
  const spotText = `${hasHome ? 't' : 'T'}his spot: ${darknessLabel(spotSqm)}`
  const name = hasHome ? `${homeLabel}: ${darknessLabel(homeSqm)}; ${spotText}` : spotText
  const spotPct = pct(spotSqm)
  return (
    <div className="darkness-scale">
      <div className="darkness-track" role="img" aria-label={name}>
        {hasHome && (
          <span className="darkness-marker darkness-marker--home" style={{ left: `${pct(homeSqm)}%` }}>
            <span className={`darkness-marker-label darkness-marker-label--below${anchor(pct(homeSqm))}`} aria-hidden="true">
              {`${homeLabel} · ${darknessLabel(homeSqm)}`}
            </span>
          </span>
        )}
        <span className="darkness-marker darkness-marker--spot" style={{ left: `${spotPct}%` }}>
          <span className={`darkness-marker-label${anchor(spotPct)}`} aria-hidden="true">
            {`This spot · ${darknessLabel(spotSqm)}`}
          </span>
        </span>
      </div>
    </div>
  )
}

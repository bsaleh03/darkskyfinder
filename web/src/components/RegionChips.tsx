import type { Region } from '../api/types'
import './controls.css'
import './Screens.css'

interface Props {
  regions: Region[]
  active?: string | null
  onPick: (key: string) => void
}

/** SE Michigan / SF Bay Area chips: pick one to fly the map there. */
export function RegionChips({ regions, active, onPick }: Props) {
  if (regions.length === 0) return null
  return (
    <div className="region-chips" role="group" aria-label="Regions">
      {regions.map((r) => (
        <button
          key={r.key}
          type="button"
          className={`ctl-btn region-chip${r.key === active ? ' region-chip--active' : ''}`}
          aria-pressed={r.key === active}
          onClick={() => onPick(r.key)}
        >
          {r.name}
        </button>
      ))}
    </div>
  )
}

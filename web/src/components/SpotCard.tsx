import { useId, useState } from 'react'
import type { Spot } from '../api/types'
import { Amenities } from './Amenities'
import { Badges } from './Badges'
import { DarknessScale } from './DarknessScale'
import { DirectionsButton } from './DirectionsButton'
import { ExpertNumbers } from './ExpertNumbers'
import { NightScrubber } from './NightScrubber'
import { SkyPreview, seedFrom } from './SkyPreview'
import { SourcesList } from './SourcesList'
import './SpotCard.css'

interface Props {
  spot: Spot
  homeSqm: number | null
  homeLabel: string
  expanded: boolean
  onToggle: () => void
  timezone: string
}

export function SpotCard({ spot, homeSqm, homeLabel, expanded, onToggle, timezone }: Props) {
  const panelId = useId()
  const moreId = useId()
  const [more, setMore] = useState(false)
  const seed = seedFrom(spot.id)
  const drive = `${spot.drive_is_estimate ? '≈' : ''}${Math.round(spot.drive_minutes)} min`
  return (
    <article className={`spot-card${spot.unavailable ? ' spot-card--unavailable' : ''}`} data-spot-id={spot.id}>
      <button type="button" className="spot-head" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>
        <span className="spot-main">
          <span className="spot-name">{spot.display_name}</span>
          {spot.area && <span className="spot-area">{spot.area}</span>}
          <Badges
            darkSky={spot.dark_sky_place} recommended={spot.recommended} crossesBorder={spot.crosses_border}
            crossesState={spot.crosses_state}
          />
          {spot.unavailable ? (
            <span className="spot-unavailable">
              {spot.unavailable_reason ? `Not available right now · ${spot.unavailable_reason}` : 'Not available right now'}
            </span>
          ) : (
            <span className="spot-meta">
              <span className="spot-drive">{drive}</span>
              <span className="spot-sky">{spot.sky_label}</span>
            </span>
          )}
        </span>
        <SkyPreview sqm={spot.sqm} label={`Sky preview, ${spot.sky_label}`} seed={seed} />
      </button>
      <div id={panelId} className="spot-body" hidden={!expanded}>
        {expanded && (
          <>
            {/* Essentials first: where to go, then tonight's hours; the rest is one tap away. */}
            <DirectionsButton lat={spot.lat} lon={spot.lon} entry={spot.entry} />
            <NightScrubber timeline={spot.timeline} bestWindow={spot.best_window} timezone={timezone} />
            <div className="spot-section">
              <div className="spot-compare">
                {homeSqm !== null && Number.isFinite(homeSqm) && (
                  <figure>
                    <SkyPreview sqm={homeSqm} label={`${homeLabel} sky`} size="large" seed={seed} />
                    <figcaption>{homeLabel}</figcaption>
                  </figure>
                )}
                <figure>
                  <SkyPreview sqm={spot.sqm} label="Spot sky" size="large" seed={seed} />
                  <figcaption>This spot</figcaption>
                </figure>
              </div>
              {spot.darker_than_home && <p className="spot-darker">{spot.darker_than_home}</p>}
              <DarknessScale homeSqm={homeSqm} spotSqm={spot.sqm} homeLabel={homeLabel} />
            </div>
            <button
              type="button"
              className="spot-more"
              aria-expanded={more}
              aria-controls={moreId}
              onClick={() => setMore((v) => !v)}
            >
              More about this spot
            </button>
            {more && (
              <div id={moreId} className="spot-more-body">
                {spot.why.length > 0 && (
                  <ul className="why-chips">
                    {spot.why.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                {spot.access.note && <p className="spot-note">{spot.access.note}</p>}
                <SourcesList sources={spot.sources} />
                <Amenities amenities={spot.amenities} />
                <ExpertNumbers spot={spot} />
              </div>
            )}
          </>
        )}
      </div>
    </article>
  )
}

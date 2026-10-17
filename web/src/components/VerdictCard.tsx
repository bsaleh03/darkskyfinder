import type { Verdict } from '../api/types'
import { fmtTime as fmt } from './time'
import './VerdictCard.css'

interface Props {
  verdict: Verdict
  forecastStatus: string
  driveStatus: string
  timezone: string
}

export function VerdictCard({ verdict, forecastStatus, driveStatus, timezone }: Props) {
  const { rating, sentence, best_window: win, moon, dark } = verdict
  const pct = `${Math.round(moon.illumination * 100)}% moon`
  const moonText = moon.set ? `${pct}, sets ${fmt(moon.set, timezone)}` : pct
  return (
    <section className={`verdict verdict--${rating}`} aria-label="Night verdict">
      <p className="verdict-sentence">{sentence}</p>
      <dl className="verdict-rows">
        {win && (
          <div className="verdict-row">
            <dt>Best window</dt>
            <dd>{`${fmt(win.start, timezone)} – ${fmt(win.end, timezone)}`}</dd>
          </div>
        )}
        <div className="verdict-row">
          <dt>Moon</dt>
          <dd>{moonText}</dd>
        </div>
        <div className="verdict-row">
          <dt>Dark</dt>
          <dd>{`${fmt(dark.start, timezone)} – ${fmt(dark.end, timezone)}`}</dd>
        </div>
      </dl>
      {forecastStatus === 'unavailable' && <p className="verdict-note">Cloud forecast unavailable</p>}
      {driveStatus === 'approx' && <p className="verdict-note">{'Some drive times are estimates (≈)'}</p>}
    </section>
  )
}

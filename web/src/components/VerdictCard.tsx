import type { Verdict } from '../api/types'
import { fmtTime as fmt } from './time'
import './VerdictCard.css'

interface Props {
  verdict: Verdict
  forecastStatus: string
  driveStatus: string
  timezone: string
}

/** "62% moon, sets 10:26 PM, rises 4:05 AM": the moon events within the dark window, in time order. */
export function moonLine(verdict: Verdict, timezone: string): string {
  const { moon, dark } = verdict
  const from = new Date(dark.start).getTime()
  const to = new Date(dark.end).getTime()
  const events = (
    [
      ['rises', moon.rise],
      ['sets', moon.set],
    ] as const
  )
    .filter((e): e is readonly ['rises' | 'sets', string] => e[1] !== null)
    .map(([verb, iso]) => ({ verb, iso, t: new Date(iso).getTime() }))
    .filter((e) => e.t >= from && e.t <= to)
    .sort((a, b) => a.t - b.t)
  return [`${Math.round(moon.illumination * 100)}% moon`, ...events.map((e) => `${e.verb} ${fmt(e.iso, timezone)}`)].join(', ')
}

export function VerdictCard({ verdict, forecastStatus, driveStatus, timezone }: Props) {
  const { rating, sentence, best_window: win, dark } = verdict
  const moonText = moonLine(verdict, timezone)
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

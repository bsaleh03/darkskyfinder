import type { TimelineHour, Window } from '../api/types'
import { fmtTime } from './time'

interface Props {
  timeline: TimelineHour[]
  bestWindow: Window | null
  timezone: string
}

function inWindow(iso: string, w: Window | null): boolean {
  if (!w) return false
  const t = new Date(iso).getTime()
  return t >= new Date(w.start).getTime() && t < new Date(w.end).getTime()
}

export function NightScrubber({ timeline, bestWindow, timezone }: Props) {
  if (timeline.length === 0) return null
  return (
    <ol className="scrubber" aria-label="Hour by hour viewing quality">
      {timeline.map((h) => {
        const cls = ['scrubber-hour', h.past ? 'past' : '', inWindow(h.time, bestWindow) ? 'scrubber-hour--best' : '']
          .filter(Boolean)
          .join(' ')
        const q = Math.round(Math.min(1, Math.max(0, h.quality)) * 100)
        const time = fmtTime(h.time, timezone)
        const word = q >= 66 ? 'good' : q >= 33 ? 'fair' : 'poor'
        const extras = [
          h.cloud === null ? 'cloud unknown' : `cloud ${Math.round(h.cloud)}%`,
          h.fog ? 'fog' : null,
          h.moon_up ? 'moon up' : null,
        ].filter(Boolean)
        return (
          <li key={h.time} className={cls} aria-label={`${time}, ${word}, ${extras.join(', ')}`}>
            <span className="scrubber-bar">
              <span className="scrubber-fill" style={{ height: `${q}%` }} />
            </span>
            <span className="scrubber-icons" aria-hidden="true">
              {h.cloud !== null && <span>{`☁${Math.round(h.cloud)}`}</span>}
              {h.fog && <span>fog</span>}
              {h.moon_up && <span>☾</span>}
            </span>
            <span className="scrubber-time" aria-hidden="true">
              {time}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

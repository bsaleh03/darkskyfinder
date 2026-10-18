import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { TimelineHour, Window } from '../api/types'
import { fmtTime } from './time'

// U+FE0E asks for text presentation, so the glyphs take the token colour instead of drawing as colour emoji.
const CLOUD = '☁︎'
const MOON = '☾︎'

/** Narrowest hour column (CSS px; fits "10:00 PM") and the gap between columns (matches `.scrubber` in the CSS). */
export const SCRUBBER_MIN_COL = 52
export const SCRUBBER_GAP = 4

/**
 * Equal column width (CSS px) for `count` hours in a view `viewW` wide: as many whole columns of at least
 * SCRUBBER_MIN_COL as fit (all of them if they fit), stretched to fill the view exactly, so the last visible column is
 * never cut at rest and, scrolled by whole columns (snap), never after. Null without a width (CSS default).
 */
export function scrubberColumn(viewW: number, count: number): number | null {
  if (!(viewW > 0) || count <= 0) return null
  const fit = Math.max(1, Math.floor((viewW + SCRUBBER_GAP) / (SCRUBBER_MIN_COL + SCRUBBER_GAP)))
  const n = Math.min(count, fit)
  return (viewW - (n - 1) * SCRUBBER_GAP) / n
}

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
  const ref = useRef<HTMLOListElement>(null)
  const [viewW, setViewW] = useState(0)
  // More hours off-screen to the right: the edge fades.
  const [more, setMore] = useState(false)
  const check = useCallback(() => {
    const el = ref.current
    if (el) setMore(el.scrollWidth - el.scrollLeft - el.clientWidth > 1)
  }, [])

  const count = timeline.length
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setViewW(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect
      if (r) setViewW(r.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [count])
  const col = scrubberColumn(viewW, count)
  useLayoutEffect(check, [check, col, count])

  if (count === 0) return null
  const style = col === null ? undefined : ({ '--scrubber-col': `${col}px` } as CSSProperties)
  return (
    <div className={`scrubber-wrap${more ? ' scrubber-wrap--more' : ''}`}>
      <ol className="scrubber" aria-label="Hour by hour viewing quality" ref={ref} style={style} onScroll={check}>
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
              {/* Always three rows (cloud, fog, moon), empty when absent, so they line up across the hours. */}
              <span className="scrubber-icons" aria-hidden="true">
                <span className="scrubber-icon">{h.cloud !== null ? `${CLOUD}${Math.round(h.cloud)}` : ''}</span>
                <span className="scrubber-icon">{h.fog ? 'fog' : ''}</span>
                <span className="scrubber-icon">{h.moon_up ? MOON : ''}</span>
              </span>
              <span className="scrubber-time" aria-hidden="true">
                {time}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

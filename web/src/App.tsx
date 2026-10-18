import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, errorMessage } from './api/client'
import { makeQueryClient, useNightDots, useRegions, useSpots, useStartupWaking, useWarmup } from './api/queries'
import type { Region, SearchHit } from './api/types'
import { Controls } from './components/Controls'
import { EmptyState } from './components/EmptyState'
import { ErrorState } from './components/ErrorState'
import { NightPicker, nextNights } from './components/NightPicker'
import { SpotList } from './components/SpotList'
import { TopBar } from './components/TopBar'
import { VerdictCard } from './components/VerdictCard'
import { LoadingCards, WakingUp } from './components/WakingUp'
import { Welcome } from './components/Welcome'
import { StaticMap } from './map/StaticMap'
import { useRedMode } from './state/redMode'
import { useAppState } from './state/useAppState'
import './AppLayout.css'

type LatLon = { lat: number; lon: number }

const MAX_DRIVE = 180
const DESKTOP = '(min-width: 900px)'
const COVERAGE = errorMessage(new ApiError('out_of_coverage'))
const RATE_LIMITED = errorMessage(new ApiError('rate_limited'))

export function regionFor(regions: Region[], p: LatLon): Region | undefined {
  return regions.find((r) => {
    const [w, s, e, n] = r.bbox
    return p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n
  })
}

/** Calendar date (YYYY-MM-DD) right now in the given IANA timezone. */
export function calendarDate(timeZone: string, now = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
    const get = (t: string) => parts.find((p) => p.type === t)?.value
    return `${get('year')}-${get('month')}-${get('day')}`
  } catch {
    return null
  }
}

const pointKey = (p: LatLon) => `${p.lat},${p.lon}`

export default function App({ client }: { client?: QueryClient }) {
  const [qc] = useState(() => client ?? makeQueryClient())
  return (
    <QueryClientProvider client={qc}>
      <Main />
    </QueryClientProvider>
  )
}

function Main() {
  useWarmup()
  const [state, update] = useAppState()
  const [red] = useRedMode()
  const regions = useRegions()
  const startupWaking = useStartupWaking()
  const spots = useSpots(state)
  const data = spots.data

  // Names of searched places by coordinate; any other start is a "Dropped pin".
  const [names, setNames] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [mapFull, setMapFull] = useState(false)
  // The API's own "tonight" per metro (it stays on yesterday's date until dawn).
  const [tonight, setTonight] = useState<Record<string, string>>({})

  const start = state.start
  const region = start ? regionFor(regions, start) : undefined
  const metro = region?.key ?? data?.metro ?? null
  // The picture is the region containing the start (none for a start outside every region).
  const mapMetro = region?.key ?? null
  const timezone = data?.timezone ?? region?.timezone ?? null
  const startName = start ? names[pointKey(start)] : undefined
  const startLabel = start ? (startName ?? 'Dropped pin') : null

  useEffect(() => {
    if (!data || spots.stale || state.night !== null) return
    setTonight((t) => (t[data.metro] === data.night ? t : { ...t, [data.metro]: data.night }))
  }, [data, spots.stale, state.night])

  const today = (metro && tonight[metro]) || (timezone ? calendarDate(timezone) : null)
  const nights = useMemo(() => (today ? nextNights(today) : []), [today])
  const dots = useNightDots(state, nights)

  // A stale or hand-edited night the API rejects falls back to tonight.
  const errKind = spots.error?.kind
  useEffect(() => {
    if (errKind === 'night_out_of_range' && state.night !== null) update({ night: null }, { replace: true })
  }, [errKind, state.night, update])

  // The full-screen map is a mobile mode: leave it when the viewport becomes desktop.
  useEffect(() => {
    const mql = window.matchMedia?.(DESKTOP)
    if (!mql) return
    const onChange = (e: { matches: boolean }) => {
      if (e.matches) setMapFull(false)
    }
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [])

  // Move focus with the screen: results heading on entering results, Welcome headline on leaving.
  const resultsHeading = useRef<HTMLHeadingElement>(null)
  const welcomeHeading = useRef<HTMLHeadingElement>(null)
  const hasStart = start !== null
  const prevHasStart = useRef(hasStart)
  useEffect(() => {
    if (prevHasStart.current === hasStart) return
    prevHasStart.current = hasStart
    ;(hasStart ? resultsHeading : welcomeHeading).current?.focus()
  }, [hasStart])

  function setStart(p: LatLon, label: string | null) {
    const at = { lat: p.lat, lon: p.lon }
    setNames((n) => {
      const next = { ...n }
      if (label) next[pointKey(at)] = label
      else delete next[pointKey(at)]
      return next
    })
    setNotice(null)
    setMapFull(false)
    update({ start: at, spot: null })
  }

  const onPick = (hit: SearchHit) => setStart(hit, hit.name)
  const onLocate = (p: LatLon) => {
    const r = regionFor(regions, p)
    if (regions.length > 0 && !r) {
      setNotice(COVERAGE)
      return
    }
    setStart(p, null)
  }
  const toggleSpot = (id: string) => update({ spot: state.spot === id ? null : id })

  const nightError = errKind === 'night_out_of_range' && state.night !== null
  // A 429 with results already on screen keeps them, with an inline notice instead of the error panel.
  const rateNotice = errKind === 'rate_limited' && data !== undefined
  const error = spots.error && !nightError && !rateNotice ? spots.error : undefined
  const showVerified = data?.spots.some((s) => s.access.badge === 'verified') ?? false

  let body
  if (error) {
    body = (
      <ErrorState error={error} onRetry={spots.refetch} />
    )
  } else if (spots.waking) {
    body = <WakingUp />
  } else if (!data) {
    body = <LoadingCards />
  } else if (data.spots.length === 0) {
    body = <EmptyState drive={state.drive} onWiden={(drive) => update({ drive: Math.min(MAX_DRIVE, drive) })} />
  } else {
    body = (
      <SpotList
        spots={data.spots}
        selectedId={state.spot}
        homeSqm={data.start.sqm}
        homeLabel={startName ?? 'Home'}
        timezone={data.timezone}
        onToggle={toggleSpot}
      />
    )
  }

  const busy = spots.stale && !rateNotice
  const appClass = `app ${start ? 'app--results' : 'app--welcome'}${start && mapFull ? ' app--map-full' : ''}`
  return (
    <div className={appClass}>
      {start ? (
        <div className="app-top">
          <p className="app-name">Dark Sky Finder</p>
          <h1 className="sr-only" tabIndex={-1} ref={resultsHeading}>
            {`Dark skies near ${startLabel}`}
          </h1>
          <TopBar
            startLabel={startLabel}
            onPick={onPick}
            onLocate={onLocate}
            onLocateError={setNotice}
          />
          {notice && (
            <p className="app-notice" role="status">
              {notice}
            </p>
          )}
          {nights.length > 0 && (
            <NightPicker
              nights={nights}
              value={state.night ?? nights[0]}
              dots={dots}
              onChange={(n) => update({ night: n === nights[0] ? null : n, spot: null })}
            />
          )}
          {data && (
            <VerdictCard
              verdict={data.verdict}
              forecastStatus={data.forecast_status}
              driveStatus={data.drive_status}
              timezone={data.timezone}
            />
          )}
        </div>
      ) : (
        <Welcome
          headingRef={welcomeHeading}
          notice={notice}
          waking={startupWaking}
          onPick={onPick}
          onLocate={onLocate}
          onLocateError={setNotice}
        />
      )}
      {start && (
        <div className="app-map">
          <StaticMap
            metro={mapMetro}
            spots={data?.spots ?? []}
            start={start}
            selectedId={state.spot}
            glow={state.glow}
            red={red}
            driveMinutes={state.drive}
            onSelect={(id) => {
              setMapFull(false)
              update({ spot: id })
            }}
            onToggleGlow={() => update({ glow: !state.glow })}
          />
          <button
            type="button"
            className="ctl-btn app-map-expand"
            aria-pressed={mapFull}
            onClick={() => setMapFull((v) => !v)}
          >
            {mapFull ? 'Show list' : 'Full map'}
          </button>
        </div>
      )}
      {start && (
        <main className={`app-list${busy ? ' app-list--stale' : ''}`} aria-busy={busy}>
          {error?.kind !== 'out_of_coverage' && (
            <Controls state={state} metro={metro} showVerified={showVerified} onChange={(patch) => update(patch)} />
          )}
          {rateNotice && (
            <p className="app-notice" role="status">
              {RATE_LIMITED}
            </p>
          )}
          {body}
        </main>
      )}
    </div>
  )
}

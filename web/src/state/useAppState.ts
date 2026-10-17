import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccessKey, BorderKey, SortKey } from '../api/types'

export type AppState = {
  start: { lat: number; lon: number } | null
  night: string | null
  drive: number
  sort: SortKey
  access: AccessKey
  border: BorderKey
  glow: boolean
  spot: string | null
}

const DEFAULT_DRIVE = 90
const SORTS: SortKey[] = ['relevant', 'closest', 'best_view']
const ACCESSES: AccessKey[] = ['all', 'likely', 'verified']
const BORDERS: BorderKey[] = ['include', 'exclude']

function parseNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function parseDrive(raw: string | null): number {
  const n = parseNumber(raw)
  if (n === null) return DEFAULT_DRIVE
  return Math.min(180, Math.max(30, Math.round(n / 15) * 15))
}

function parseNight(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const [y, m, d] = raw.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const ok = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  return ok ? raw : null
}

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback
}

export function parseState(search: string): AppState {
  const p = new URLSearchParams(search)
  const lat = parseNumber(p.get('lat'))
  const lon = parseNumber(p.get('lon'))
  const start =
    lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
      ? { lat, lon }
      : null
  return {
    start,
    night: parseNight(p.get('night')),
    drive: parseDrive(p.get('drive')),
    sort: pick(p.get('sort'), SORTS, 'relevant'),
    access: pick(p.get('access'), ACCESSES, 'all'),
    border: pick(p.get('border'), BORDERS, 'include'),
    glow: p.get('glow') !== '0',
    spot: p.get('spot') || null,
  }
}

export function serializeState(s: AppState): string {
  const p = new URLSearchParams()
  if (s.start) {
    p.set('lat', String(s.start.lat))
    p.set('lon', String(s.start.lon))
  }
  if (s.night) p.set('night', s.night)
  if (s.drive !== DEFAULT_DRIVE) p.set('drive', String(s.drive))
  if (s.sort !== 'relevant') p.set('sort', s.sort)
  if (s.access !== 'all') p.set('access', s.access)
  if (s.border !== 'include') p.set('border', s.border)
  if (!s.glow) p.set('glow', '0')
  if (s.spot) p.set('spot', s.spot)
  return p.toString()
}

export function useAppState(): [
  AppState,
  (patch: Partial<AppState>, opts?: { replace?: boolean }) => void,
] {
  const [state, setState] = useState<AppState>(() => parseState(window.location.search))
  const ref = useRef(state)
  ref.current = state

  useEffect(() => {
    const onPop = () => setState(parseState(window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const update = useCallback((patch: Partial<AppState>, opts?: { replace?: boolean }) => {
    const next = { ...ref.current, ...patch }
    const qs = serializeState(next)
    const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
    if (opts?.replace) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    ref.current = next
    setState(next)
  }, [])

  return [state, update]
}

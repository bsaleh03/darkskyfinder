import { useQuery } from '@tanstack/react-query'
import { config } from '../config'
import type { MapLevel } from './framing'
import type { MapLabel } from './labels'
import type { Bounds } from './projection'

/**
 * Picture kinds. base / base_red: the map alone. v3 manifests add base_glow / base_glow_red, the map with the glow
 * drawn in (shown when the glow is on, so it appears with the map). Older manifests instead have glow / glow_red, a
 * transparent level-0 glow laid over the base.
 */
export type MapFileKey = 'base' | 'base_red' | 'base_glow' | 'base_glow_red' | 'glow' | 'glow_red'
/** Kinds with tiles at levels >= 1: the base kinds, and in v3 the composites (an overlay glow is level 0 only). */
export type MapTileKey = 'base' | 'base_red' | 'base_glow' | 'base_glow_red'
type Templates<K extends string> = Record<'base' | 'base_red', string> & Partial<Record<K, string>>

/** The pipeline's per-region picture manifest (pipeline/out/maps/<metro>/web/manifest.json). */
export type MapManifest = {
  metro: string
  bounds: Bounds
  /** height / width of every picture */
  aspect: number
  widths: number[]
  /** file name templates relative to the manifest, with {w} for the width: base and base_red, plus either the glow
   * composites (v3) or the glow overlay (v1/v2) */
  files: Templates<Exclude<MapFileKey, 'base' | 'base_red'>>
  labels: string
  /** v2: the levels (level 0 is the whole picture at `widths`; level l >= 1 is a grid of full-width tiles) */
  levels?: MapLevel[]
  /** v2: tile file name templates relative to the manifest, with {l}, {c} and {r} for level, column and row: base and
   * base_red, and in v3 base_glow and base_glow_red (overlay glow templates are ignored) */
  tiles?: Templates<'base_glow' | 'base_glow_red'>
}

const LEVEL_0: MapLevel = { level: 0, cols: 1, rows: 1 }

/** The picture's levels; a v1 manifest (no levels) is level 0 only. */
export const mapLevels = (m: MapManifest): MapLevel[] => m.levels ?? [LEVEL_0]

export type MapManifestState = {
  manifest: MapManifest | null
  labels: MapLabel[]
  status: 'loading' | 'ready' | 'error'
}

export const manifestUrl = (metro: string) => `${config.tilesUrl.replace(/\/+$/, '')}/maps/${metro}/manifest.json`

/** v3: the glow comes drawn into base_glow / base_glow_red (no overlay picture). */
export const hasGlowComposite = (m: MapManifest): boolean =>
  typeof m.files.base_glow === 'string' && typeof m.files.base_glow_red === 'string'

/** Absolute URL of a picture file: the template with {w} filled in, resolved against the manifest's URL. */
export function mapFileUrl(manifest: MapManifest, key: MapFileKey, width: number): string {
  const base = new URL(manifestUrl(manifest.metro), window.location.href)
  const template = manifest.files[key]
  if (template === undefined) throw new Error(`no ${key} pictures in the ${manifest.metro} manifest`)
  return new URL(template.replace('{w}', String(width)), base).href
}

/** Absolute URL of one tile of a level >= 1, resolved against the manifest's URL. */
export function mapTileUrl(manifest: MapManifest, key: MapTileKey, level: number, col: number, row: number): string {
  const base = new URL(manifestUrl(manifest.metro), window.location.href)
  const template = manifest.tiles?.[key]
  if (template === undefined) throw new Error(`no ${key} tiles in the ${manifest.metro} manifest`)
  const name = template.replace('{l}', String(level)).replace('{c}', String(col)).replace('{r}', String(row))
  return new URL(name, base).href
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const PLAIN = ['base', 'base_red'] as const
const COMPOSITE = ['base_glow', 'base_glow_red'] as const
const OVERLAY = ['glow', 'glow_red'] as const
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
const hasTemplates = (v: unknown, keys: readonly string[]) =>
  typeof v === 'object' && v !== null && keys.every((k) => typeof (v as Record<string, unknown>)[k] === 'string')
/** base and base_red, and a glow source: the composite pair (v3) or the overlay pair (v1/v2). */
const isTemplates = (v: unknown): v is MapManifest['files'] =>
  hasTemplates(v, PLAIN) && (hasTemplates(v, COMPOSITE) || hasTemplates(v, OVERLAY))

/**
 * v2 additions: absent (v1, level 0 only), or levels with whole positive grids, and tile templates for level >= 1:
 * base and base_red, plus the composites when the level-0 files are composites (v3).
 */
function levelsOk(m: Partial<MapManifest>): boolean {
  const tileKeys = hasTemplates(m.files, COMPOSITE) ? [...PLAIN, ...COMPOSITE] : PLAIN
  const isTileTemplates = (v: unknown) => hasTemplates(v, tileKeys)
  if (m.levels === undefined) return m.tiles === undefined || isTileTemplates(m.tiles)
  if (!Array.isArray(m.levels) || m.levels.length === 0) return false
  const ok = m.levels.every(
    (l) => l !== null && typeof l === 'object' && Number.isInteger(l.level) && l.level >= 0 && isCount(l.cols) && isCount(l.rows),
  )
  if (!ok || !m.levels.some((l) => l.level === 0)) return false
  return m.levels.every((l) => l.level === 0) || isTileTemplates(m.tiles)
}

/** Validate the manifest of `metro` (v1, v2 with levels and tiles, or v3 with the glow composites). */
export function parseManifest(v: unknown, metro: string): MapManifest {
  const m = v as Partial<MapManifest> | null
  const ok =
    m !== null &&
    typeof m === 'object' &&
    m.metro === metro &&
    Array.isArray(m.bounds) && m.bounds.length === 4 && m.bounds.every(isNum) &&
    isNum(m.aspect) && m.aspect > 0 &&
    Array.isArray(m.widths) && m.widths.length > 0 && m.widths.every((w) => isNum(w) && w > 0) &&
    isTemplates(m.files) &&
    typeof m.labels === 'string' &&
    levelsOk(m)
  if (!ok) throw new Error(`bad map manifest for ${metro}`)
  return m as MapManifest
}

function asLabels(v: unknown): MapLabel[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (l): l is MapLabel => l && typeof l.name === 'string' && isNum(l.lon) && isNum(l.lat) && isNum(l.rank),
  )
}

/** The region picture manifest and its place labels. A missing or broken manifest is an error; labels are optional. */
export function useMapManifest(metro: string | null): MapManifestState {
  const m = useQuery({
    queryKey: ['map-manifest', metro],
    queryFn: async ({ signal }) => parseManifest(await getJson(manifestUrl(metro!), signal), metro!),
    enabled: metro !== null,
    staleTime: Infinity,
    retry: 1,
  })
  const manifest = m.data ?? null
  const l = useQuery({
    queryKey: ['map-labels', metro],
    queryFn: async ({ signal }) =>
      asLabels(await getJson(new URL(manifest!.labels, new URL(manifestUrl(metro!), window.location.href)).href, signal)),
    enabled: manifest !== null,
    staleTime: Infinity,
    retry: 1,
  })
  if (metro === null || m.isError) return { manifest: null, labels: [], status: 'error' }
  if (!manifest) return { manifest: null, labels: [], status: 'loading' }
  return { manifest, labels: l.data ?? [], status: 'ready' }
}

// The per-region picture manifest written by scripts/render-maps.mjs next to the pictures (manifest.json).
import type { Bounds } from '../src/map/projection'
import { sizesFor } from './sizes'

export type FileKey = 'base' | 'base_red' | 'glow' | 'glow_red'
export const KEYS: FileKey[] = ['base', 'base_red', 'glow', 'glow_red']
/** Kinds that have tiles at levels >= 1. The glow stays at level 0: its VIIRS source is coarser than that. */
export type TileKey = 'base' | 'base_red'
export const TILE_KEYS: TileKey[] = ['base', 'base_red']

/** Level-0 picture names; {w} = one of `widths`. */
export const FILES: Record<FileKey, string> = {
  base: 'base_{w}.webp',
  base_red: 'base_red_{w}.webp',
  glow: 'glow_{w}.webp',
  glow_red: 'glow_red_{w}.webp',
}
/** Tile names for levels >= 1; {l} = level, {c} = column from the west, {r} = row from the north. */
export const TILES: Record<TileKey, string> = {
  base: 'base_L{l}_{c}_{r}.webp',
  base_red: 'base_red_L{l}_{c}_{r}.webp',
}

export type Level = { level: number; cols: number; rows: number }

/**
 * Manifest v2. v1 fields: bounds = W,S,E,N of the images (Web Mercator rectangle), aspect = height / width,
 * widths ascending (level-0 sizes), files = level-0 name templates. v2 adds `levels` (level l = 2^l x 2^l tiles,
 * each tile the level-0 full size, so level l is widths.at(-1) * 2^l wide in all) and `tiles` (tile name
 * templates for base and base_red only; level 0 is served by `files`, never as a tile, and the glow is level 0 only).
 */
export type MapManifestV2 = {
  metro: string
  bounds: Bounds
  aspect: number
  widths: number[]
  files: Record<FileKey, string>
  labels: string
  levels: Level[]
  tiles: Record<TileKey, string>
}

export type Extent = { bounds: Bounds; width: number; height: number; levels: number[] }

export function tileFile(template: string, level: number, col: number, row: number): string {
  return template.replace('{l}', String(level)).replace('{c}', String(col)).replace('{r}', String(row))
}

export function buildManifest(metro: string, extent: Extent): MapManifestV2 {
  const { bounds, width, height } = extent
  const levels = [...new Set(extent.levels)].sort((a, b) => a - b)
  if (levels[0] !== 0) throw new Error(`levels must start at 0, got ${extent.levels.join(',')}`)
  return {
    metro,
    bounds,
    aspect: height / width,
    widths: sizesFor(width, height / width).map((s) => s.w),
    files: { ...FILES },
    labels: 'labels.json',
    levels: levels.map((level) => ({ level, cols: 2 ** level, rows: 2 ** level })),
    tiles: { ...TILES },
  }
}

/** Every file the region serves (and the upload sends): manifest, labels, level-0 widths and level >= 1 base tiles. */
export function manifestFiles(m: MapManifestV2): string[] {
  const out = ['manifest.json', m.labels]
  for (const w of m.widths) for (const k of KEYS) out.push(m.files[k].replace('{w}', String(w)))
  for (const { level, cols, rows } of m.levels) {
    if (level === 0) continue
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) for (const k of TILE_KEYS) out.push(tileFile(m.tiles[k], level, c, r))
  }
  return out
}

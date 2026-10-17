import type { Region } from '../api/types'

export type Bounds = [[number, number], [number, number]]
export type StyleChange = 'none' | 'glow' | 'restyle'

export function regionBounds(r: Region): Bounds {
  const [w, s, e, n] = r.bbox
  return [[w, s], [e, n]]
}

export function unionBounds(regions: Region[]): Bounds | null {
  if (!regions.length) return null
  let [w, s, e, n] = regions[0].bbox
  for (const r of regions.slice(1)) {
    w = Math.min(w, r.bbox[0]); s = Math.min(s, r.bbox[1])
    e = Math.max(e, r.bbox[2]); n = Math.max(n, r.bbox[3])
  }
  return [[w, s], [e, n]]
}

/** Glow-only changes toggle layer visibility; red changes need a full restyle. */
export function styleChange(prev: { glow: boolean; red: boolean }, next: { glow: boolean; red: boolean }): StyleChange {
  if (prev.red !== next.red) return 'restyle'
  return prev.glow !== next.glow ? 'glow' : 'none'
}

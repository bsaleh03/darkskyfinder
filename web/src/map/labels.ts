import type { LonLat } from './projection'

/** A place name from the region's labels.json; rank 1 = most important. */
export type MapLabel = { name: string; lon: number; lat: number; rank: number }

export type PlacedLabel = { label: MapLabel; x: number; y: number }

// Estimated label box (CSS px) for the label font: about 7 px per character, one 14 px line, centered on the point.
const CHAR_W = 7
const LINE_H = 14

/**
 * Greedy placement by rank: a label is kept when its whole box is inside the view and it overlaps no label
 * already kept. Returns the kept labels with their screen position (the box center).
 */
export function placeLabels(
  labels: MapLabel[],
  toScreen: (p: LonLat) => { x: number; y: number },
  viewW: number,
  viewH: number,
): PlacedLabel[] {
  const kept: { placed: PlacedLabel; x0: number; y0: number; x1: number; y1: number }[] = []
  for (const label of [...labels].sort((a, b) => a.rank - b.rank)) {
    const { x, y } = toScreen(label)
    const halfW = (label.name.length * CHAR_W) / 2
    const box = { x0: x - halfW, x1: x + halfW, y0: y - LINE_H / 2, y1: y + LINE_H / 2 }
    if (box.x0 < 0 || box.y0 < 0 || box.x1 > viewW || box.y1 > viewH) continue
    if (kept.some((k) => box.x0 < k.x1 && k.x0 < box.x1 && box.y0 < k.y1 && k.y0 < box.y1)) continue
    kept.push({ placed: { label, x, y }, ...box })
  }
  return kept.map((k) => k.placed)
}

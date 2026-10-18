import { fractionToLat, toFraction, type Bounds, type LonLat } from './projection'

export type Box = { x0: number; y0: number; x1: number; y1: number }

const R_KM = 6371
const PAD = 0.12
const MIN_SPAN_KM = 25
const KM_PER_MINUTE = 1.2
const rad = (d: number) => (d * Math.PI) / 180
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2))

/** km per unit fraction at latitude: x = R*dLon*cos(lat); y = R*cos(lat)*dMercY (Mercator scale at that latitude). */
function kmPerFraction(lat: number, b: Bounds) {
  const c = Math.cos(rad(lat))
  return { x: R_KM * rad(b[2] - b[0]) * c, y: R_KM * c * (mercY(b[3]) - mercY(b[1])) }
}

function expandTo(lo: number, hi: number, minSpan: number): [number, number] {
  if (hi - lo >= minSpan) return [lo, hi]
  const mid = (lo + hi) / 2
  return [mid - minSpan / 2, mid + minSpan / 2]
}

export function frameView(points: LonLat[], start: LonLat, driveMinutes: number, bounds: Bounds): Box {
  const s = toFraction(start, bounds)
  if (points.length === 0) {
    const k = kmPerFraction(start.lat, bounds)
    const half = driveMinutes * KM_PER_MINUTE
    return { x0: s.x - half / k.x, x1: s.x + half / k.x, y0: s.y - half / k.y, y1: s.y + half / k.y }
  }
  const fs = [s, ...points.map((p) => toFraction(p, bounds))]
  let x0 = Math.min(...fs.map((f) => f.x))
  let x1 = Math.max(...fs.map((f) => f.x))
  let y0 = Math.min(...fs.map((f) => f.y))
  let y1 = Math.max(...fs.map((f) => f.y))
  const px = (x1 - x0) * PAD
  const py = (y1 - y0) * PAD
  x0 -= px; x1 += px; y0 -= py; y1 += py
  const k = kmPerFraction(fractionToLat((y0 + y1) / 2, bounds), bounds)
  ;[x0, x1] = expandTo(x0, x1, MIN_SPAN_KM / k.x)
  ;[y0, y1] = expandTo(y0, y1, MIN_SPAN_KM / k.y)
  return { x0, y0, x1, y1 }
}

/** Contain-fit: size/offset (CSS px) of the full image so `box` is fully visible and centered. imageAspect = height/width. */
export function fitBox(box: Box, viewW: number, viewH: number, imageAspect: number) {
  const bw = box.x1 - box.x0
  const bh = (box.y1 - box.y0) * imageAspect
  const imgW = Math.min(viewW / bw, viewH / bh)
  const imgH = imgW * imageAspect
  return {
    imgW,
    imgH,
    left: viewW / 2 - ((box.x0 + box.x1) / 2) * imgW,
    top: viewH / 2 - ((box.y0 + box.y1) / 2) * imgH,
  }
}

export function chooseWidth(widths: number[], imgW: number, dpr: number): number {
  const sorted = [...widths].sort((a, b) => a - b)
  const need = imgW * dpr
  return sorted.find((w) => w >= need) ?? sorted[sorted.length - 1]
}

/** A point to keep in view (picture fraction) and the radius (CSS px) of its hit area. */
export type Mark = { x: number; y: number; r: number }
export type Fit = ReturnType<typeof fitBox>

type Dir = 'up' | 'down' | 'left' | 'right'

/** The point's screen position under `fit`. */
const screenOf = (m: Mark, f: Fit) => ({ x: f.left + m.x * f.imgW, y: f.top + m.y * f.imgH })

/** `box` widened by d (fraction) on the side that moves points in `dir` on screen. */
function widen(box: Box, dir: Dir, d: number): Box {
  if (dir === 'down') return { ...box, y0: box.y0 - d }
  if (dir === 'up') return { ...box, y1: box.y1 + d }
  if (dir === 'right') return { ...box, x0: box.x0 - d }
  return { ...box, x1: box.x1 + d }
}

/** The mark (with its hit radius) is inside the overlay rect. */
const under = (p: { x: number; y: number }, r: number, o: Box) =>
  p.x > o.x0 - r && p.x < o.x1 + r && p.y > o.y0 - r && p.y < o.y1 + r

/**
 * Contain-fit `box` into the view minus a small uniform inset, then keep every mark (with its hit radius) out of
 * the overlay rects (screen px, e.g. corner buttons and the attribution): when one is under an overlay, the
 * framing widens just enough on the side that moves it out vertically or sideways, whichever keeps the picture
 * larger. A few rounds at most; the result is the last fit.
 */
export function fitClear(
  box: Box,
  viewW: number,
  viewH: number,
  inset: number,
  imageAspect: number,
  marks: Mark[],
  overlays: Box[],
  rounds = 6,
): Fit {
  const w = viewW - 2 * inset
  const h = viewH - 2 * inset
  const fit = (b: Box): Fit => {
    const f = fitBox(b, w, h, imageAspect)
    return { ...f, left: f.left + inset, top: f.top + inset }
  }
  let b = box
  let f = fit(b)
  for (let round = 0; round < rounds; round++) {
    const grow: Record<Dir, number> = { up: 0, down: 0, left: 0, right: 0 }
    let hit = false
    for (const m of marks) {
      for (const o of overlays) {
        if (!under(screenOf(m, f), m.r, o)) continue
        hit = true
        // Out of a top overlay by moving down, a bottom one by moving up; sideways away from its side,
        // unless it spans the whole width.
        const dirs: Dir[] = [(o.y0 + o.y1) / 2 < viewH / 2 ? 'down' : 'up']
        if (o.x0 > 0 || o.x1 < viewW) dirs.push((o.x0 + o.x1) / 2 < viewW / 2 ? 'right' : 'left')
        let best: { dir: Dir; d: number; imgW: number } | null = null
        for (const dir of dirs) {
          const clear = (d: number) => {
            const p = screenOf(m, fit(widen(b, dir, d)))
            if (dir === 'down') return p.y >= o.y1 + m.r
            if (dir === 'up') return p.y <= o.y0 - m.r
            if (dir === 'right') return p.x >= o.x1 + m.r
            return p.x <= o.x0 - m.r
          }
          // The point moves monotonically toward the far side as d grows: bisect the smallest d that clears.
          let hi = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 8
          if (!clear(hi)) continue
          let lo = 0
          for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2
            if (clear(mid)) hi = mid
            else lo = mid
          }
          const imgW = fit(widen(b, dir, hi)).imgW
          if (!best || imgW > best.imgW) best = { dir, d: hi, imgW }
        }
        if (best) grow[best.dir] = Math.max(grow[best.dir], best.d)
      }
    }
    if (!hit) break
    b = { x0: b.x0 - grow.right, x1: b.x1 + grow.left, y0: b.y0 - grow.down, y1: b.y1 + grow.up }
    f = fit(b)
  }
  return f
}

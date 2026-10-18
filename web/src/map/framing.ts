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

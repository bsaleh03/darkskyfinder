import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Spot } from '../api/types'
import { toRed } from './color'
import { chooseWidth, fitClear, frameView, type Box, type Mark } from './framing'
import { placeLabels, type ScreenBox } from './labels'
import { pinColor } from './pins'
import { toFraction, type LonLat } from './projection'
import { mapFileUrl, useMapManifest } from './useMapManifest'
import './StaticMap.css'

export interface StaticMapProps {
  /** Region whose picture to show (the one containing the start); null → no picture. */
  metro: string | null
  spots: Spot[]
  start: LonLat
  selectedId: string | null
  glow: boolean
  red: boolean
  driveMinutes: number
  onSelect(id: string): void
  onToggleGlow(): void
}

export const ATTRIBUTION =
  'Overture Maps Foundation · © OpenStreetMap contributors · TomTom · ESA WorldCover · VIIRS VNL (EOG / Colorado School of Mines)'
const UNAVAILABLE = 'Map unavailable right now'

/** Pins and the start are fitted into the view minus this inset (CSS px) on every side. */
export const FIT_INSET = 12
/** Hit radius (CSS px) of a pin (its 32 px button) and of the start (18 px dot, border and outline). */
export const PIN_R = 16
export const START_R = 14

/**
 * Size (CSS px) of the overlays when they cannot be measured (no layout, e.g. tests): the app's Full map button
 * at the top left (12 px from the corner, 44 px tall), the glow button at the top right, and the collapsed
 * one-line attribution at the bottom right.
 */
const FULL_MAP_BTN = { w: 104, h: 44 }
const GLOW_BTN_W = 180
const ATTRIBUTION_EST = { w: 640, h: 20 }
const BTN_MARGIN = 12

/** Screen rects (CSS px, view coordinates) the pins and the start must stay out of. */
export function overlayRects(
  viewW: number,
  viewH: number,
  measured: { glowW?: number; attrW?: number; attrH?: number } = {},
): { topLeft: Box; topRight: Box; attribution: Box } {
  const glowW = measured.glowW || GLOW_BTN_W
  const attrW = Math.min(viewW, measured.attrW || ATTRIBUTION_EST.w)
  const attrH = measured.attrH || ATTRIBUTION_EST.h
  return {
    topLeft: { x0: 0, y0: 0, x1: BTN_MARGIN + FULL_MAP_BTN.w, y1: BTN_MARGIN + FULL_MAP_BTN.h },
    topRight: { x0: viewW - BTN_MARGIN - glowW, y0: 0, x1: viewW, y1: BTN_MARGIN + FULL_MAP_BTN.h },
    attribution: { x0: viewW - attrW, y0: viewH - attrH, x1: viewW, y1: viewH },
  }
}

/** Label obstacle sizes (CSS px squares): a plain pin, a selected or Dark Sky pin, the start. */
const PIN_BOX = 16
const PIN_BOX_BIG = 28
const START_BOX = 24

type Size = { w: number; h: number }

/** The framing never asks for more than the picture: what lies past its edges would only be water color. */
const clampBox = (b: Box): Box => ({
  x0: Math.max(0, b.x0),
  y0: Math.max(0, b.y0),
  x1: Math.min(1, b.x1),
  y1: Math.min(1, b.y1),
})

const pct = (f: number) => `${f * 100}%`
const square = (x: number, y: number, side: number): ScreenBox => ({
  x0: x - side / 2,
  y0: y - side / 2,
  x1: x + side / 2,
  y1: y + side / 2,
})

/** Size of the view box, from ResizeObserver (or clientWidth/clientHeight and window resizes without it). */
function useViewSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (w: number, h: number) => setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }))
    const fromClient = () => measure(el.clientWidth, el.clientHeight)
    fromClient()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', fromClient)
      return () => window.removeEventListener('resize', fromClient)
    }
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect
      if (r) measure(r.width, r.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, size }
}

/**
 * The base picture of one variant (metro + normal/red; the parent keys it by that). A sharper file for the same
 * variant loads on top of the one on screen, which goes only once the new one has loaded: the picture never
 * blanks while it sharpens. A failed upgrade keeps the current picture; a failed current picture is reported.
 */
function BasePicture({ src, onError }: { src: string; onError(src: string): void }) {
  const [shown, setShown] = useState(src)
  const [failed, setFailed] = useState<string | null>(null)
  const pending = src !== shown && src !== failed ? src : null
  return (
    <>
      {[shown, pending].map(
        (s) =>
          s && (
            <img
              key={s}
              className="static-map-picture"
              src={s}
              alt=""
              draggable={false}
              onLoad={s === pending ? () => setShown(s) : undefined}
              onError={() => (s === shown ? onError(s) : setFailed(s))}
            />
          ),
      )}
    </>
  )
}

export function StaticMap(props: StaticMapProps) {
  const { metro, spots, start, selectedId, glow, red, driveMinutes, onSelect, onToggleGlow } = props
  const { manifest, labels, status } = useMapManifest(metro)
  const { ref, size } = useViewSize()
  const attrId = useId()
  const [attrOpen, setAttrOpen] = useState(false)

  // Measure the overlays where there is layout: the glow button and the collapsed attribution line.
  const glowBtn = useRef<HTMLButtonElement>(null)
  const attribution = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<{ glowW?: number; attrW?: number; attrH?: number }>({})
  useLayoutEffect(() => {
    const glowW = glowBtn.current?.offsetWidth || undefined
    const a = attribution.current
    const attrW = !attrOpen ? a?.offsetWidth || undefined : undefined
    const attrH = !attrOpen ? a?.offsetHeight || undefined : undefined
    setMeasured((m) => {
      const next = { glowW, attrW: attrW ?? m.attrW, attrH: attrH ?? m.attrH }
      return next.glowW === m.glowW && next.attrW === m.attrW && next.attrH === m.attrH ? m : next
    })
  }, [size, attrOpen])

  const overlays = useMemo(() => (size ? Object.values(overlayRects(size.w, size.h, measured)) : []), [size, measured])

  const fit = useMemo(() => {
    if (!manifest || !size) return null
    const inset = size.w > 2 * FIT_INSET && size.h > 2 * FIT_INSET ? FIT_INSET : 0
    if (size.w - 2 * inset <= 0 || size.h - 2 * inset <= 0) return null
    const points = spots.map((s) => ({ lon: s.lon, lat: s.lat }))
    const box = clampBox(frameView(points, start, driveMinutes, manifest.bounds))
    const marks: Mark[] = [
      { ...toFraction(start, manifest.bounds), r: START_R },
      ...points.map((p) => ({ ...toFraction(p, manifest.bounds), r: PIN_R })),
    ]
    return fitClear(box, size.w, size.h, inset, manifest.aspect, marks, overlays)
  }, [manifest, size, spots, start, driveMinutes, overlays])

  const placed = useMemo(() => {
    if (!manifest || !fit || !size) return []
    const toScreen = (p: LonLat) => {
      const f = toFraction(p, manifest.bounds)
      return { x: fit.left + f.x * fit.imgW, y: fit.top + f.y * fit.imgH }
    }
    // Pins, the start and the overlays are taken before any label.
    const s = toScreen(start)
    const obstacles: ScreenBox[] = [
      ...overlays,
      square(s.x, s.y, START_BOX),
      ...spots.map((sp) => {
        const p = toScreen(sp)
        return square(p.x, p.y, sp.id === selectedId || sp.dark_sky_place ? PIN_BOX_BIG : PIN_BOX)
      }),
    ]
    return placeLabels(labels, toScreen, size.w, size.h, obstacles)
  }, [manifest, labels, fit, size, overlays, start, spots, selectedId])

  // Width tier: never smaller than one already chosen for this metro and mode (a wider framing keeps the
  // sharper file); a new metro or mode starts over.
  const variant = `${metro}|${red ? 'red' : 'normal'}`
  const want = manifest && fit ? chooseWidth(manifest.widths, fit.imgW, window.devicePixelRatio || 1) : null
  const [tier, setTier] = useState<{ variant: string; width: number } | null>(null)
  if (want !== null && (tier?.variant !== variant || want > tier.width)) setTier({ variant, width: want })
  const width = want === null ? null : tier?.variant === variant ? Math.max(tier.width, want) : want
  const baseSrc = manifest && width ? mapFileUrl(manifest, red ? 'base_red' : 'base', width) : null
  // The glow grid is coarse (500 m): the smallest file carries all its detail, CSS scales it.
  const glowSrc = manifest && fit ? mapFileUrl(manifest, red ? 'glow_red' : 'glow', Math.min(...manifest.widths)) : null

  // A failed picture shows the unavailable state until the file, the region or the start changes (a retry).
  const [broken, setBroken] = useState<{ src: string; at: string } | null>(null)
  const at = `${metro}|${start.lon},${start.lat}`
  const unavailable = status === 'error' || (baseSrc !== null && broken?.src === baseSrc && broken.at === at)
  // A failed glow hides the glow; pressing the toggle then retries it rather than leaving it "on" but empty.
  const [glowFailed, setGlowFailed] = useState<string | null>(null)
  const glowOk = glowSrc === null || glowFailed !== glowSrc
  const glowOn = glow && glowOk
  const onGlowClick = () => {
    if (glow && !glowOk) setGlowFailed(null)
    else onToggleGlow()
  }

  // Pin positions as fractions of the picture, so they ride along with its eased transition.
  const pos = (p: LonLat): CSSProperties => {
    const f = toFraction(p, manifest!.bounds)
    return { left: pct(f.x), top: pct(f.y) }
  }

  return (
    <div className="static-map" ref={ref}>
      {/* Always mounted, so screen readers hear the message when it appears. */}
      <p className="static-map-message" role="status">
        {unavailable ? UNAVAILABLE : ''}
      </p>
      {!unavailable && (
        <>
          {manifest && fit && baseSrc && (
            <div
              className="static-map-image"
              style={{ width: fit.imgW, height: fit.imgH, transform: `translate(${fit.left}px, ${fit.top}px)` }}
            >
              {/* Keyed by variant: switching mode (e.g. red) mounts fresh images, so the previous picture never
                  stays on screen while the new one downloads; the water color shows instead. */}
              <BasePicture key={`${variant}|base`} src={baseSrc} onError={(src) => setBroken({ src, at })} />
              {glowOn && glowSrc && (
                <img
                  key={`${variant}|glow`}
                  className="static-map-picture"
                  src={glowSrc}
                  alt=""
                  draggable={false}
                  onError={() => setGlowFailed(glowSrc)}
                />
              )}
              {placed.map(({ label }) => (
                <span
                  key={`${label.name}|${label.lon}|${label.lat}`}
                  className="static-map-label"
                  aria-hidden="true"
                  style={pos(label)}
                >
                  {label.name}
                </span>
              ))}
              <span className="static-map-start" role="img" aria-label="Your start" style={pos(start)} />
              {spots.map((s) => {
                const color = pinColor(s)
                const selected = s.id === selectedId
                const cls = [
                  'static-map-pin',
                  s.dark_sky_place && 'static-map-pin--dark-sky',
                  selected && 'static-map-pin--selected',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={cls}
                    aria-label={s.display_name}
                    aria-pressed={selected}
                    style={{ ...pos(s), ['--pin' as string]: red ? toRed(color) : color }}
                    onClick={() => onSelect(s.id)}
                  />
                )
              })}
            </div>
          )}
          <button
            type="button"
            className="static-map-glow-btn"
            ref={glowBtn}
            aria-pressed={glowOn}
            onClick={onGlowClick}
          >
            Light pollution glow
          </button>
          <div
            className={`static-map-attribution${attrOpen ? ' static-map-attribution--open' : ''}`}
            ref={attribution}
          >
            <p className="static-map-attribution-text" id={attrId}>
              {ATTRIBUTION}
            </p>
            <button
              type="button"
              className="static-map-attribution-btn"
              aria-label="Map data sources"
              aria-expanded={attrOpen}
              aria-controls={attrId}
              onClick={() => setAttrOpen((o) => !o)}
            >
              i
            </button>
          </div>
        </>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Spot } from '../api/types'
import { toRed } from './color'
import { chooseWidth, fitBox, frameView, type Box } from './framing'
import { placeLabels } from './labels'
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

/**
 * Pins and the start are fitted into the view minus these insets (CSS px): the top clears the Full map and glow
 * buttons (12 px + 44 px tall) plus half a selected pin; the bottom clears the attribution line (at least this
 * much, more when it measures taller); the sides keep pins off the edge.
 */
export const SAFE_INSET = { top: 68, bottom: 34, side: 12 }

type Size = { w: number; h: number }

/** The framing never asks for more than the picture: what lies past its edges would only be water color. */
const clampBox = (b: Box): Box => ({
  x0: Math.max(0, b.x0),
  y0: Math.max(0, b.y0),
  x1: Math.min(1, b.x1),
  y1: Math.min(1, b.y1),
})

const pct = (f: number) => `${f * 100}%`

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

export function StaticMap(props: StaticMapProps) {
  const { metro, spots, start, selectedId, glow, red, driveMinutes, onSelect, onToggleGlow } = props
  const { manifest, labels, status } = useMapManifest(metro)
  const { ref, size } = useViewSize()
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  // The attribution wraps on narrow views: keep pins above however tall it actually is.
  const attribution = useRef<HTMLParagraphElement>(null)
  const [attrH, setAttrH] = useState(0)
  useEffect(() => {
    const h = attribution.current?.offsetHeight ?? 0
    setAttrH((prev) => (prev === h ? prev : h))
  }, [size])

  // The safe rect: the view minus the overlays. Pins, the start and labels are fitted into it.
  const safe = useMemo(() => {
    if (!size) return null
    const top = SAFE_INSET.top
    const bottom = Math.max(SAFE_INSET.bottom, attrH + 6)
    const side = SAFE_INSET.side
    const w = size.w - 2 * side
    const h = size.h - top - bottom
    // A view too small for the insets falls back to the whole view.
    return w > 0 && h > 0 ? { left: side, top, w, h } : { left: 0, top: 0, w: size.w, h: size.h }
  }, [size, attrH])

  const fit = useMemo(() => {
    if (!manifest || !safe || safe.w <= 0 || safe.h <= 0) return null
    const points = spots.map((s) => ({ lon: s.lon, lat: s.lat }))
    const box = clampBox(frameView(points, start, driveMinutes, manifest.bounds))
    const f = fitBox(box, safe.w, safe.h, manifest.aspect)
    return { ...f, left: f.left + safe.left, top: f.top + safe.top }
  }, [manifest, safe, spots, start, driveMinutes])

  const placed = useMemo(() => {
    if (!manifest || !fit || !safe) return []
    const toSafe = (p: LonLat) => {
      const f = toFraction(p, manifest.bounds)
      return { x: fit.left + f.x * fit.imgW - safe.left, y: fit.top + f.y * fit.imgH - safe.top }
    }
    return placeLabels(labels, toSafe, safe.w, safe.h)
  }, [manifest, labels, fit, safe])

  const width = manifest && fit ? chooseWidth(manifest.widths, fit.imgW, window.devicePixelRatio || 1) : null
  const baseSrc = manifest && width ? mapFileUrl(manifest, red ? 'base_red' : 'base', width) : null
  const glowSrc = manifest && width ? mapFileUrl(manifest, red ? 'glow_red' : 'glow', width) : null
  const unavailable = status === 'error' || (baseSrc !== null && brokenSrc === baseSrc)

  // Pin positions as fractions of the picture, so they ride along with its eased transition.
  const at = (p: LonLat): CSSProperties => {
    const f = toFraction(p, manifest!.bounds)
    return { left: pct(f.x), top: pct(f.y) }
  }

  return (
    <div className="static-map" ref={ref}>
      {unavailable ? (
        <p className="static-map-message" role="status">
          {UNAVAILABLE}
        </p>
      ) : (
        <>
          {manifest && fit && baseSrc && (
            <div
              className="static-map-image"
              style={{ width: fit.imgW, height: fit.imgH, transform: `translate(${fit.left}px, ${fit.top}px)` }}
            >
              {/* Keyed by file: a new file (e.g. red mode) mounts a fresh image, so the previous picture never
                  stays on screen while the new one downloads; the water color shows instead. */}
              <img
                key={baseSrc}
                className="static-map-picture"
                src={baseSrc}
                alt=""
                draggable={false}
                onError={() => setBrokenSrc(baseSrc)}
              />
              {glow && glowSrc && <img key={glowSrc} className="static-map-picture" src={glowSrc} alt="" draggable={false} />}
              {placed.map(({ label }) => (
                <span key={`${label.name}|${label.lon}|${label.lat}`} className="static-map-label" aria-hidden="true" style={at(label)}>
                  {label.name}
                </span>
              ))}
              <span className="static-map-start" role="img" aria-label="Your start" style={at(start)} />
              {spots.map((s) => {
                const color = pinColor(s)
                const cls = [
                  'static-map-pin',
                  s.dark_sky_place && 'static-map-pin--dark-sky',
                  s.id === selectedId && 'static-map-pin--selected',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={cls}
                    aria-label={s.display_name}
                    style={{ ...at(s), ['--pin' as string]: red ? toRed(color) : color }}
                    onClick={() => onSelect(s.id)}
                  />
                )
              })}
            </div>
          )}
          <button type="button" className="static-map-glow-btn" aria-pressed={glow} onClick={onToggleGlow}>
            Light pollution glow
          </button>
          <p className="static-map-attribution" ref={attribution}>
            {ATTRIBUTION}
          </p>
        </>
      )}
    </div>
  )
}

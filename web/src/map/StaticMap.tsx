import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Spot } from '../api/types'
import { toRed } from './color'
import { chooseLevel, chooseWidth, fitClear, frameView, visibleTiles, type Box, type Mark } from './framing'
import { placeLabels, type ScreenBox } from './labels'
import { pinColor } from './pins'
import { toFraction, type LonLat } from './projection'
import { hasGlowComposite, mapFileUrl, mapLevels, mapTileUrl, useMapManifest, type MapTileKey } from './useMapManifest'
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

/** One picture file and whether it carries the glow (a base_glow picture, or the overlay of an older manifest). */
type Pic = { src: string; glow: boolean }

/**
 * The whole level-0 picture of one variant (metro + normal/red; the parent keys it by that). A different file for the
 * same variant (sharper, or the glow switched) loads on top of the one on screen, which goes only once the new one has
 * loaded: the picture never blanks. On first paint (nothing on screen yet) `first`, the smallest file, comes first and
 * the chosen one loads over it. A failed file is reported with the one on screen (`onError`); a failed file that is
 * not the target only drops out (the target shows alone), and a failed upgrade keeps the current picture.
 */
function Picture({ pic, first, onError }: { pic: Pic; first?: Pic; onError(failed: Pic, shown: Pic): void }) {
  const [shown, setShown] = useState<Pic>(first ?? pic)
  const [failed, setFailed] = useState<string | null>(null)
  const pending = pic.src !== shown.src && pic.src !== failed ? pic : null
  return (
    <>
      {[shown, pending].map(
        (p) =>
          p && (
            <img
              key={p.src}
              className="static-map-picture"
              src={p.src}
              alt=""
              draggable={false}
              onLoad={p === pending ? () => setShown(p) : undefined}
              onError={() => {
                if (p === pending) {
                  setFailed(p.src)
                  onError(p, shown)
                } else if (pending) setShown(pending)
                else onError(p, p)
              }}
            />
          ),
      )}
    </>
  )
}

/**
 * One tile of a level >= 1, laid over the level-0 picture at its place (fractions of the picture, so it rides
 * along with the pins). Hidden until it has loaded, then faded in; a failed tile stays hidden (level 0 shows). A new
 * file for the same place (the glow switched) loads hidden over the tile on screen and replaces it once loaded.
 */
function Tile({ src, col, row, cols, rows }: { src: string; col: number; row: number; cols: number; rows: number }) {
  const [shown, setShown] = useState<string | null>(null)
  // A replacement appears at once (no fade from nothing over a picture that was already there).
  const [swapped, setSwapped] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const pending = src !== shown && src !== failed ? src : null
  const style = { left: pct(col / cols), top: pct(row / rows), width: pct(1 / cols), height: pct(1 / rows) }
  return (
    <>
      {[shown, pending].map(
        (s) =>
          s && (
            <img
              key={s}
              className={`static-map-tile${s === shown ? ` static-map-tile--loaded${swapped ? ' static-map-tile--swapped' : ''}` : ''}`}
              src={s}
              alt=""
              draggable={false}
              style={style}
              onLoad={
                s === pending
                  ? () => {
                      setSwapped(shown !== null)
                      setShown(s)
                    }
                  : undefined
              }
              onError={s === pending ? () => setFailed(s) : undefined}
            />
          ),
      )}
    </>
  )
}

/** What is asked of the files for one variant: the level-0 width, the level and the tiles ("col_row") so far. */
type Detail = { variant: string; width: number; level: number; tiles: string[] }

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

  // Width and level: never below what was already chosen for this metro and mode (a wider framing keeps the
  // sharper picture and the tiles already shown), adding the tiles that come into view; a new metro or mode
  // starts over.
  const variant = `${metro}|${red ? 'red' : 'normal'}`
  const [detail, setDetail] = useState<Detail | null>(null)
  let current: Detail | null = null
  if (manifest && fit && size) {
    const dpr = window.devicePixelRatio || 1
    const levels = mapLevels(manifest)
    const prev = detail?.variant === variant ? detail : null
    const width = Math.max(prev?.width ?? 0, chooseWidth(manifest.widths, fit.imgW, dpr))
    const level = Math.max(prev?.level ?? 0, chooseLevel(levels, Math.max(...manifest.widths), fit.imgW, dpr))
    const grid = levels.find((l) => l.level === level)
    const view: Box = {
      x0: -fit.left / fit.imgW,
      y0: -fit.top / fit.imgH,
      x1: (size.w - fit.left) / fit.imgW,
      y1: (size.h - fit.top) / fit.imgH,
    }
    const seen =
      level >= 1 && grid && manifest.tiles
        ? visibleTiles(level, grid.cols, grid.rows, view).map((t) => `${t.col}_${t.row}`)
        : []
    const kept = prev?.level === level ? prev.tiles : []
    const tiles = [...kept, ...seen.filter((k) => !kept.includes(k))]
    current = { variant, width, level, tiles }
    if (!prev || prev.width !== width || prev.level !== level || prev.tiles.length !== tiles.length) setDetail(current)
  }
  const width = current?.width ?? null
  const grid = manifest && current ? mapLevels(manifest).find((l) => l.level === current.level) : undefined
  // v3 manifests have the glow drawn into base_glow pictures; older ones lay a separate glow picture over the base.
  const composite = manifest !== null && hasGlowComposite(manifest)
  const plainKey = red ? 'base_red' : 'base'
  const litKey = red ? 'base_glow_red' : 'base_glow'
  const plainSrc = manifest && width ? mapFileUrl(manifest, plainKey, width) : null
  // The glow picture: the composite, or (older manifests) the overlay, which follows the base width and at level >= 1
  // stays at the level-0 full width.
  const glowSrc = manifest && width ? mapFileUrl(manifest, composite ? litKey : red ? 'glow_red' : 'glow', width) : null

  // A failed picture shows the unavailable state until the file, the region or the start changes (a retry).
  const [broken, setBroken] = useState<{ src: string; at: string } | null>(null)
  const at = `${metro}|${start.lon},${start.lat}`
  const unavailable = status === 'error' || (plainSrc !== null && broken?.src === plainSrc && broken.at === at)
  // A failed glow picture hides the glow (the plain base shows); pressing the toggle then retries it rather than
  // leaving it "on" but empty.
  const [glowFailed, setGlowFailed] = useState<string | null>(null)
  const glowOk = glowSrc === null || glowFailed !== glowSrc
  const glowOn = glow && glowOk
  const onGlowClick = () => {
    if (glow && !glowOk) setGlowFailed(null)
    else onToggleGlow()
  }
  const lit = composite && glowOn
  const picKey = lit ? litKey : plainKey
  const pic: Pic | null = lit && glowSrc ? { src: glowSrc, glow: true } : plainSrc ? { src: plainSrc, glow: false } : null
  // First paint: the smallest file of the same kind, then the chosen one over it.
  const first: Pic | undefined = manifest
    ? { src: mapFileUrl(manifest, picKey, Math.min(...manifest.widths)), glow: lit }
    : undefined
  const onPictureError = (failed: Pic, shown: Pic) => {
    // A glow picture that failed on screen, or while replacing a picture without glow: show the plain base instead.
    if (failed.glow && (failed.src === shown.src || !shown.glow)) setGlowFailed(failed.src)
    else if (!failed.glow && failed.src === shown.src) setBroken({ src: failed.src, at })
  }
  const tileKey: MapTileKey = lit ? litKey : plainKey

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
          {manifest && fit && pic && (
            <div
              className="static-map-image"
              style={{ width: fit.imgW, height: fit.imgH, transform: `translate(${fit.left}px, ${fit.top}px)` }}
            >
              {/* Keyed by variant: switching mode (e.g. red) mounts fresh images, so the previous picture never
                  stays on screen while the new one downloads; the water color shows instead. Switching the glow
                  keeps the variant: the picture on screen stays until the other one has loaded. */}
              <Picture key={`${variant}|base`} pic={pic} first={first} onError={onPictureError} />
              {grid &&
                current!.tiles.map((k) => {
                  const [col, row] = k.split('_').map(Number)
                  return (
                    <Tile
                      key={`${variant}|L${grid.level}|${k}`}
                      src={mapTileUrl(manifest, tileKey, grid.level, col, row)}
                      col={col}
                      row={row}
                      cols={grid.cols}
                      rows={grid.rows}
                    />
                  )
                })}
              {!composite && glowOn && glowSrc && (
                <Picture
                  key={`${variant}|glow`}
                  pic={{ src: glowSrc, glow: true }}
                  onError={(failed, shown) => failed.src === shown.src && setGlowFailed(failed.src)}
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

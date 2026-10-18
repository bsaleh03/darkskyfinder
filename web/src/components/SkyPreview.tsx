import { useId } from 'react'

const MIN_SQM = 18
const MAX_SQM = 22
const MIN_STARS = 6
const MAX_STARS = 120
// starCount is defined for this reference area; each size scales it so star density stays the same.
const REF_AREA = 120 * 72

export function starCount(sqm: number): number {
  if (!Number.isFinite(sqm)) return MIN_STARS
  const t = Math.min(1, Math.max(0, (sqm - MIN_SQM) / (MAX_SQM - MIN_SQM)))
  return Math.round(MIN_STARS + t * (MAX_STARS - MIN_STARS))
}

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFrom(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

interface Props {
  sqm: number
  label: string
  size?: 'thumb' | 'large'
  /** Same seed = same star field, so two previews compare only by darkness. */
  seed?: number
}

// Drawn at (roughly) the CSS size so stars stay crisp instead of being scaled up.
const SIZES = { thumb: { w: 132, h: 44 }, large: { w: 240, h: 120 } } as const

interface Star {
  x: number
  y: number
  b: number // brightness 0..1
}

function field(seed: number, w: number, h: number): Star[] {
  const rand = rng(seed)
  const n = Math.round((MAX_STARS * w * h) / REF_AREA)
  const stars: Star[] = []
  for (let i = 0; i < n; i++) {
    // Most stars are faint; a few are bright (roughly like a magnitude distribution).
    stars.push({ x: rand() * w, y: rand() * h, b: rand() ** 2.5 })
  }
  // Brightest first: a darker sky reveals more of the faint tail.
  return stars.sort((p, q) => q.b - p.b)
}

export function SkyPreview({ sqm, label, size = 'thumb', seed = 1234 }: Props) {
  const id = useId().replace(/:/g, '')
  const { w, h } = SIZES[size]
  const all = field(seed, w, h)
  // Sky glow erases the faint tail first, so visibility falls off faster than linearly as the sky brightens.
  const t = (starCount(sqm) - MIN_STARS) / (MAX_STARS - MIN_STARS)
  const stars = all.slice(0, Math.max(2, Math.round(all.length * (0.02 + 0.98 * t * t))))
  const milkyWay = Number.isFinite(sqm) && sqm >= 21
  const bandOpacity = milkyWay ? 0.18 + Math.min(1, sqm - 21) * 0.2 : 0
  const angle = -20 - (seed % 15)
  return (
    <svg className={`sky-preview sky-preview--${size}`} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <defs>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor="currentColor" stopOpacity="0.55" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-blur`} x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation={h / 10} />
        </filter>
      </defs>
      <rect className="sky-preview-bg" width={w} height={h} />
      {milkyWay && (
        <g transform={`rotate(${angle} ${w / 2} ${h / 2})`} filter={`url(#${id}-blur)`} opacity={bandOpacity}>
          <ellipse className="sky-preview-milkyway" cx={w / 2} cy={h / 2} rx={w * 0.75} ry={h * 0.16} />
          <ellipse className="sky-preview-milkyway-core" cx={w * 0.55} cy={h / 2} rx={w * 0.3} ry={h * 0.08} />
        </g>
      )}
      {stars.map((s, i) =>
        s.b > 0.6 ? (
          <g key={i}>
            <circle cx={s.x} cy={s.y} r={1.2 + s.b * 2.4} fill={`url(#${id}-glow)`} />
            <circle className="sky-preview-star" cx={s.x} cy={s.y} r={0.5 + s.b * 0.7} />
          </g>
        ) : (
          <circle key={i} className="sky-preview-star" cx={s.x} cy={s.y} r={0.3 + s.b * 0.6} opacity={0.35 + s.b} />
        ),
      )}
    </svg>
  )
}

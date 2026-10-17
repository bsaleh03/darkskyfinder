const MIN_SQM = 18
const MAX_SQM = 22
const MIN_STARS = 6
const MAX_STARS = 120

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

interface Props {
  sqm: number
  label: string
  size?: 'thumb' | 'large'
}

const W = 120
const H = 72

export function SkyPreview({ sqm, label, size = 'thumb' }: Props) {
  const rand = rng(1234)
  const stars = Array.from({ length: starCount(sqm) }, (_, i) => ({
    i,
    x: rand() * W,
    y: rand() * H,
    r: 0.4 + rand() * 0.9,
    o: 0.5 + rand() * 0.5,
  }))
  return (
    <svg
      className={`sky-preview sky-preview--${size}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="xMidYMid slice"
    >
      <rect className="sky-preview-bg" width={W} height={H} />
      {sqm >= 21 && (
        <rect
          className="sky-preview-milkyway"
          x={-20}
          y={H / 2 - 9}
          width={W + 40}
          height={18}
          transform={`rotate(-25 ${W / 2} ${H / 2})`}
        />
      )}
      {stars.map((s) => (
        <circle key={s.i} className="sky-preview-star" cx={s.x} cy={s.y} r={s.r} opacity={s.o} />
      ))}
    </svg>
  )
}

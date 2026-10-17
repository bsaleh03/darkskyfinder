import './NightPicker.css'

type Dot = 'go' | 'maybe' | 'no'

const DOT_LABEL: Record<Dot, string> = { go: 'good night', maybe: 'maybe', no: 'poor night' }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parse(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function nextNights(today: string, n = 7): string[] {
  const base = parse(today)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  })
}

export function nightLabel(night: string, today: string): string {
  if (night === today) return 'Tonight'
  const d = parse(night)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`
}

interface Props {
  nights: string[]
  value: string | null
  dots: Record<string, Dot | undefined>
  onChange: (n: string | null) => void
}

export function NightPicker({ nights, value, dots, onChange }: Props) {
  const today = nights[0]
  return (
    <div className="night-picker" role="group" aria-label="Choose a night">
      {nights.map((n) => {
        const dot = dots[n]
        const selected = n === value
        return (
          <button
            key={n}
            type="button"
            className={`night-chip${selected ? ' night-chip--active' : ''}`}
            aria-pressed={selected}
            onClick={() => onChange(n)}
          >
            <span className="night-chip-label">{nightLabel(n, today)}</span>
            {dot ? (
              <span className={`night-dot night-dot--${dot}`}>
                <span className="night-dot-text">{DOT_LABEL[dot]}</span>
              </span>
            ) : (
              <span className="night-dot night-dot--none" aria-hidden="true" />
            )}
          </button>
        )
      })}
    </div>
  )
}

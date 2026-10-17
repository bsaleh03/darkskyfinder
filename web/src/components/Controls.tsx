import type { ReactNode } from 'react'
import type { AccessKey, SortKey } from '../api/types'
import type { AppState } from '../state/useAppState'
import './controls.css'
import './ControlsPanel.css'

interface Props {
  state: AppState
  metro: string | null
  showVerified: boolean
  onChange: (patch: Partial<AppState>) => void
}

const MIN = 30
const MAX = 180
const STEP = 15

function snap(n: number): number {
  const s = Math.round(n / STEP) * STEP
  return Math.min(MAX, Math.max(MIN, s))
}

interface SegProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string }[]
  onSelect: (v: T) => void
}

function Segmented<T extends string>({ label, value, options, onSelect }: SegProps<T>): ReactNode {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className="ctl-btn seg-btn"
          onClick={() => onSelect(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'relevant', label: 'Relevant' },
  { value: 'closest', label: 'Closest' },
  { value: 'best_view', label: 'Best view' },
]

export function Controls({ state, metro, showVerified, onChange }: Props) {
  const accessOptions: { value: AccessKey; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'likely', label: 'Likely open' },
    ...(showVerified ? [{ value: 'verified' as AccessKey, label: 'Verified only' }] : []),
  ]
  return (
    <div className="controls">
      <label className="controls-row">
        <span className="controls-label">Within {state.drive} min</span>
        <input
          type="range"
          className="controls-slider"
          min={MIN}
          max={MAX}
          step={STEP}
          value={state.drive}
          onChange={(e) => onChange({ drive: snap(Number(e.target.value)) })}
        />
      </label>
      <Segmented label="Sort by" value={state.sort} options={SORTS} onSelect={(sort) => onChange({ sort })} />
      <Segmented
        label="Access"
        value={state.access}
        options={accessOptions}
        onSelect={(access) => onChange({ access })}
      />
      {metro === 'se_mi' && (
        <button
          type="button"
          role="switch"
          aria-checked={state.border === 'include'}
          className="ctl-btn controls-switch"
          onClick={() => onChange({ border: state.border === 'include' ? 'exclude' : 'include' })}
        >
          Include Canada
        </button>
      )}
    </div>
  )
}

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type { AccessKey, SortKey } from '../api/types'
import type { AppState } from '../state/useAppState'
import './controls.css'
import './ControlsPanel.css'

interface Props {
  state: AppState
  metro: string | null
  showVerified: boolean
  /** The drive slider commits once per gesture (on release), so one drag is one request and one history entry. */
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
  const hasMatch = options.some((o) => o.value === value)
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length
    let next: number
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else return
    e.preventDefault()
    onSelect(options[next].value)
    const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons?.[next]?.focus()
  }
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value || (!hasMatch && i === 0) ? 0 : -1}
          className="ctl-btn seg-btn"
          onClick={() => onSelect(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
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
  // While dragging, only the label follows the thumb; the URL (and the request) updates on release.
  const [draft, setDraft] = useState<number | null>(null)
  const slider = useRef<HTMLInputElement>(null)
  const latest = useRef({ drive: state.drive, onChange })
  latest.current = { drive: state.drive, onChange }
  useEffect(() => setDraft(null), [state.drive])
  const commitRef = useRef(() => {})
  commitRef.current = () => {
    const el = slider.current
    if (!el) return
    const drive = snap(Number(el.value))
    setDraft(null)
    if (drive !== latest.current.drive) latest.current.onChange({ drive })
  }
  const commit = () => commitRef.current()
  // React's onChange fires on every `input`; the native `change` marks the end of a drag or a keyboard step.
  useEffect(() => {
    const el = slider.current
    const onNativeChange = () => commitRef.current()
    el?.addEventListener('change', onNativeChange)
    return () => el?.removeEventListener('change', onNativeChange)
  }, [])
  const shown = draft ?? state.drive
  const accessOptions: { value: AccessKey; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'likely', label: 'Likely open' },
    ...(showVerified ? [{ value: 'verified' as AccessKey, label: 'Verified only' }] : []),
  ]
  return (
    <div className="controls">
      <label className="controls-row">
        <span className="controls-label">Within {shown} min</span>
        <input
          ref={slider}
          type="range"
          className="controls-slider"
          min={MIN}
          max={MAX}
          step={STEP}
          value={shown}
          onChange={(e) => {
            if (e.nativeEvent.type === 'input') setDraft(snap(Number(e.target.value)))
          }}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyUp={commit}
          onBlur={commit}
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

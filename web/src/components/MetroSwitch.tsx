import type { Region } from '../api/types'
import './controls.css'

interface Props {
  regions: Region[]
  value: string | null
  onChange: (key: string) => void
}

export function MetroSwitch({ regions, value, onChange }: Props) {
  return (
    <select
      className="ctl-btn ctl-select"
      aria-label="Region"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {value === null && (
        <option value="" disabled>
          Region
        </option>
      )}
      {regions.map((r) => (
        <option key={r.key} value={r.key}>
          {r.name}
        </option>
      ))}
    </select>
  )
}

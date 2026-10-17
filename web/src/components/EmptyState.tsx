import './controls.css'
import './Screens.css'

const MAX_DRIVE = 180

interface Props {
  drive: number
  onWiden: (drive: number) => void
}

export function EmptyState({ drive, onWiden }: Props) {
  const next = Math.min(MAX_DRIVE, drive + 30)
  const atMax = drive >= MAX_DRIVE
  return (
    <div className="state-panel">
      <p className="state-title">{`Nothing within ${drive} min.`}</p>
      <button type="button" className="ctl-btn state-action" disabled={atMax} onClick={() => onWiden(next)}>
        {atMax ? 'Already at max distance' : `Widen to ${next} min`}
      </button>
    </div>
  )
}

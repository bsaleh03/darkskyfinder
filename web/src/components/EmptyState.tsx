import './controls.css'
import './Screens.css'

const MAX_DRIVE = 180

interface Props {
  drive: number
  onWiden: (drive: number) => void
}

export function EmptyState({ drive, onWiden }: Props) {
  const next = Math.min(MAX_DRIVE, drive + 30)
  return (
    <div className="state-panel">
      <p className="state-title">{`Nothing within ${drive} min.`}</p>
      <button type="button" className="ctl-btn state-action" disabled={drive >= MAX_DRIVE} onClick={() => onWiden(next)}>
        {`Widen to ${next} min`}
      </button>
    </div>
  )
}

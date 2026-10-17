import { useRedMode } from '../state/redMode'
import './controls.css'

export function RedModeToggle() {
  const [red, setRed] = useRedMode()
  return (
    <button type="button" role="switch" aria-checked={red} className="ctl-btn" onClick={() => setRed(!red)}>
      Red mode
    </button>
  )
}

import { type ApiError, errorMessage } from '../api/client'
import './controls.css'
import './Screens.css'

interface Props {
  error: ApiError
  onRetry: () => void
}

export function ErrorState({ error, onRetry }: Props) {
  const retryable = error.kind === 'network' || error.kind === 'server'
  return (
    <div className="state-panel" role="alert">
      <p className="state-title">{errorMessage(error)}</p>
      {retryable && (
        <button type="button" className="ctl-btn state-action" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

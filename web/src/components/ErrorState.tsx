import { type ApiError, errorMessage } from '../api/client'
import type { Region } from '../api/types'
import { RegionChips } from './RegionChips'
import './controls.css'
import './Screens.css'

interface Props {
  error: ApiError
  regions: Region[]
  onRegion: (key: string) => void
  onRetry: () => void
}

export function ErrorState({ error, regions, onRegion, onRetry }: Props) {
  const retryable = error.kind === 'network' || error.kind === 'server'
  return (
    <div className="state-panel" role="alert">
      <p className="state-title">{errorMessage(error)}</p>
      {error.kind === 'out_of_coverage' && <RegionChips regions={regions} onPick={onRegion} />}
      {retryable && (
        <button type="button" className="ctl-btn state-action" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

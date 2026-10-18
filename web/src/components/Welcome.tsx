import type { RefObject } from 'react'
import type { SearchHit } from '../api/types'
import { LocateButton } from './LocateButton'
import { RedModeToggle } from './RedModeToggle'
import { SearchBox } from './SearchBox'
import './Screens.css'

interface Props {
  headingRef?: RefObject<HTMLHeadingElement>
  notice: string | null
  /** The API is slow to answer its first requests (cold start). */
  waking?: boolean
  onPick: (hit: SearchHit) => void
  onLocate: (p: { lat: number; lon: number }) => void
  onLocateError: (msg: string) => void
}

export function Welcome({ headingRef, notice, waking, onPick, onLocate, onLocateError }: Props) {
  return (
    <div className="welcome">
      <header className="welcome-brand">
        <span className="app-name">Dark Sky Finder</span>
        <RedModeToggle />
      </header>
      <h1 className="welcome-headline" tabIndex={-1} ref={headingRef}>{"Where's the closest dark sky tonight?"}</h1>
      <div className="welcome-search">
        <SearchBox onPick={onPick} />
        <LocateButton onLocate={onLocate} onError={onLocateError} />
      </div>
      {waking && (
        <p className="app-notice" role="status">
          Waking up the stargazing engine…
        </p>
      )}
      {notice && (
        <p className="app-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}

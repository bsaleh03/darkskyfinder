import type { RefObject } from 'react'
import type { Region, SearchHit } from '../api/types'
import { LocateButton } from './LocateButton'
import { RedModeToggle } from './RedModeToggle'
import { RegionChips } from './RegionChips'
import { SearchBox } from './SearchBox'
import './Screens.css'

interface Props {
  headingRef?: RefObject<HTMLHeadingElement>
  regions: Region[]
  focusRegion: string | null
  notice: string | null
  onPick: (hit: SearchHit) => void
  onLocate: (p: { lat: number; lon: number }) => void
  onLocateError: (msg: string) => void
  onRegion: (key: string) => void
}

export function Welcome({ headingRef, regions, focusRegion, notice, onPick, onLocate, onLocateError, onRegion }: Props) {
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
      <RegionChips regions={regions} active={focusRegion} onPick={onRegion} />
      <p className="welcome-hint">Pick a region, then tap the map to set your start.</p>
      {notice && (
        <p className="app-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}

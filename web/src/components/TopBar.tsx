import { useState } from 'react'
import type { Region, SearchHit } from '../api/types'
import { LocateButton } from './LocateButton'
import { MetroSwitch } from './MetroSwitch'
import { RedModeToggle } from './RedModeToggle'
import { SearchBox } from './SearchBox'
import './TopBar.css'

interface Props {
  startLabel: string | null // picked hit name, "Dropped pin", or null when no start
  regions: Region[]
  metro: string | null
  onMetroChange: (key: string) => void
  onPick: (hit: SearchHit) => void
  onLocate: (p: { lat: number; lon: number }) => void
  onLocateError: (msg: string) => void
}

export function TopBar({ startLabel, regions, metro, onMetroChange, onPick, onLocate, onLocateError }: Props) {
  const [searching, setSearching] = useState(false)
  const showSearch = searching || startLabel === null

  return (
    <header className="top-bar">
      <div className="top-bar-main">
        {showSearch ? (
          <>
            <SearchBox
              onPick={(h) => {
                setSearching(false)
                onPick(h)
              }}
            />
            <LocateButton
              onLocate={(p) => {
                setSearching(false)
                onLocate(p)
              }}
              onError={onLocateError}
            />
          </>
        ) : (
          <button type="button" className="ctl-btn start-chip" onClick={() => setSearching(true)}>
            {startLabel}
          </button>
        )}
      </div>
      <div className="top-bar-side">
        <MetroSwitch regions={regions} value={metro} onChange={onMetroChange} />
        <RedModeToggle />
      </div>
    </header>
  )
}

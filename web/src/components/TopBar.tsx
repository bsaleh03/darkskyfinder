import { useEffect, useRef, useState } from 'react'
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
  const main = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const focusChip = useRef(false)
  // A press inside the bar (e.g. on Use my location) blurs the input first; that is not leaving the search.
  const pressing = useRef(false)

  useEffect(() => {
    if (!showSearch && focusChip.current) {
      focusChip.current = false
      chip.current?.focus()
    }
  }, [showSearch])

  const onDismiss = (via: 'escape' | 'blur', next: Element | null) => {
    if (startLabel === null) return
    if (via === 'blur' && (pressing.current || (next && main.current?.contains(next)))) return
    focusChip.current = via === 'escape'
    setSearching(false)
  }

  return (
    <header className="top-bar">
      <div
        className="top-bar-main"
        ref={main}
        onPointerDown={() => {
          pressing.current = true
          const done = () => {
            pressing.current = false
            window.removeEventListener('pointerup', done, true)
            window.removeEventListener('pointercancel', done, true)
          }
          window.addEventListener('pointerup', done, true)
          window.addEventListener('pointercancel', done, true)
        }}
      >
        {showSearch ? (
          <>
            <SearchBox
              autoFocus={searching}
              onDismiss={onDismiss}
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
          <button type="button" ref={chip} className="ctl-btn start-chip" onClick={() => setSearching(true)}>
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

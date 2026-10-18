import { useId, useRef, useState } from 'react'
import { useSearch } from '../api/queries'
import type { SearchHit } from '../api/types'
import './SearchBox.css'

const METRO_NAMES: Record<string, string> = { se_mi: 'Michigan', bay_area: 'SF Bay Area' }

export function metroName(key: string): string {
  return METRO_NAMES[key] ?? key
}

interface Props {
  onPick: (hit: SearchHit) => void
  placeholder?: string
  autoFocus?: boolean
  /** Escape with no list open, or focus leaving an empty box (`next` is where focus went). */
  onDismiss?: (via: 'escape' | 'blur', next: Element | null) => void
}

export function SearchBox({ onPick, placeholder = 'Search a town or place', autoFocus, onDismiss }: Props) {
  const [text, setText] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()
  const { hits, loading } = useSearch(text)
  const enough = text.trim().length >= 2

  // Keep showing the previous hits while the next ones load, to avoid flicker.
  const prev = useRef<SearchHit[]>([])
  if (!enough) prev.current = []
  else if (hits.length > 0) prev.current = hits
  const shown = !enough ? [] : hits.length > 0 ? hits : loading ? prev.current : []

  const open = !dismissed && shown.length > 0
  const optionId = (i: number) => `${listId}-opt-${i}`

  function pick(hit: SearchHit) {
    setText(hit.name)
    setDismissed(true)
    setActive(-1)
    onPick(hit)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && shown.length > 0) {
      e.preventDefault()
      setDismissed(false)
      setActive((i) => (i + 1) % shown.length)
    } else if (e.key === 'ArrowUp' && shown.length > 0) {
      e.preventDefault()
      setDismissed(false)
      setActive((i) => (i <= 0 ? shown.length - 1 : i - 1))
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      pick(shown[active >= 0 && active < shown.length ? active : 0])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setDismissed(true)
      setActive(-1)
    } else if (e.key === 'Escape' && onDismiss) {
      e.preventDefault()
      onDismiss('escape', null)
    }
  }

  return (
    <div className="search-box">
      <input
        className="search-input"
        type="text"
        role="combobox"
        aria-label="Search for a place"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setDismissed(false)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          setDismissed(true)
          if (text.trim() === '') onDismiss?.('blur', e.relatedTarget instanceof Element ? e.relatedTarget : null)
        }}
      />
      {open && (
        <ul className="search-list" role="listbox" id={listId} aria-label="Search results">
          {shown.map((h, i) => (
            <li
              key={`${h.name}|${h.lat}|${h.lon}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className="search-option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(h)}
            >
              <span className="search-name">{h.name}</span>
              <span className="search-meta">
                {h.kind} {'·'} {metroName(h.metro)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

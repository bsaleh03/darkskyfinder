import { useId, useRef, useState } from 'react'
import { ApiError, errorMessage, fetchSearch } from '../api/client'
import { useSearch } from '../api/queries'
import type { SearchHit } from '../api/types'
import './SearchBox.css'

const METRO_NAMES: Record<string, string> = { se_mi: 'Michigan', bay_area: 'SF Bay Area' }
const ORS_ATTRIBUTION = 'Address lookup © openrouteservice.org, OpenStreetMap contributors'
const NOT_FOUND = 'Couldn’t find that place or address. Try a nearby town, or use your location.'

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

export function SearchBox({ onPick, placeholder = 'Search a town, place or address', autoFocus, onDismiss }: Props) {
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

  // The result the box currently shows (for its attribution), and the message of the last explicit search.
  const [chosen, setChosen] = useState<SearchHit | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  const lookup = useRef(0)

  function pick(hit: SearchHit) {
    lookup.current++ // a pick wins over a lookup still in flight
    setLooking(false)
    setText(hit.name)
    setChosen(hit)
    setMessage(null)
    setDismissed(true)
    setActive(-1)
    onPick(hit)
  }

  // Explicit search (Enter or the button): look the text up, including the address geocoder, and go to the best match.
  async function submit() {
    const q = text.trim()
    if (q.length < 2) return
    const id = ++lookup.current
    setLooking(true)
    setMessage(null)
    setDismissed(true)
    try {
      const hits = await fetchSearch(q, undefined, { geocode: true })
      if (id !== lookup.current) return
      if (hits.length > 0) pick(hits[0])
      else setMessage(NOT_FOUND)
    } catch (e) {
      if (id !== lookup.current) return
      setMessage(e instanceof ApiError ? errorMessage(e) : NOT_FOUND)
    } finally {
      if (id === lookup.current) setLooking(false)
    }
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
    } else if (e.key === 'Enter' && open && active >= 0 && active < shown.length) {
      e.preventDefault()
      pick(shown[active])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
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
          lookup.current++ // editing abandons a lookup in flight
          setLooking(false)
          setText(e.target.value)
          setChosen(null)
          setMessage(null)
          setDismissed(false)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          setDismissed(true)
          if (text.trim() === '') onDismiss?.('blur', e.relatedTarget instanceof Element ? e.relatedTarget : null)
        }}
      />
      <button
        type="button"
        className="search-go"
        aria-label="Search"
        aria-busy={looking}
        disabled={looking}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void submit()}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentcolor" strokeWidth="2" />
          <path d="M15.5 15.5 21 21" stroke="currentcolor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {message && (
        <p className="search-message" role="status">
          {message}
        </p>
      )}
      {!open && chosen?.source === 'openrouteservice' && text === chosen.name && (
        <p className="search-attribution search-attribution--below">{ORS_ATTRIBUTION}</p>
      )}
      {open && (
        <div className="search-popup">
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
        </div>
      )}
    </div>
  )
}

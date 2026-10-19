import { useEffect, useRef } from 'react'
import type { Spot } from '../api/types'
import { SpotCard } from './SpotCard'
import './SpotList.css'

interface Props {
  spots: Spot[]
  selectedId: string | null
  homeSqm: number | null
  homeLabel: string
  timezone: string
  onToggle: (id: string) => void
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Ranked spots first, then unavailable ones. The selected card scrolls into view. */
export function SpotList({ spots, selectedId, homeSqm, homeLabel, timezone, onToggle }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const ordered = [...spots.filter((s) => !s.unavailable), ...spots.filter((s) => s.unavailable)]
  const present = selectedId !== null && spots.some((s) => s.id === selectedId)

  useEffect(() => {
    if (!present) return
    const cards = box.current?.querySelectorAll<HTMLElement>('[data-spot-id]') ?? []
    const el = [...cards].find((c) => c.dataset.spotId === selectedId)
    // Bring the opened card to the top of the screen so its Directions and hours are in view.
    el?.scrollIntoView?.({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [selectedId, present])

  return (
    <div className="spot-list" ref={box}>
      {ordered.map((s) => (
        <SpotCard
          key={s.id}
          spot={s}
          homeSqm={homeSqm}
          homeLabel={homeLabel}
          expanded={s.id === selectedId}
          onToggle={() => onToggle(s.id)}
          timezone={timezone}
        />
      ))}
    </div>
  )
}

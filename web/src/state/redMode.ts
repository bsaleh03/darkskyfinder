import { useEffect, useSyncExternalStore } from 'react'

const KEY = 'dsf.red'
const listeners = new Set<() => void>()
let memory = false // fallback when localStorage is unavailable

function getSnapshot(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return memory
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function apply(v: boolean) {
  if (v) document.documentElement.dataset.red = 'true'
  else delete document.documentElement.dataset.red
}

function setRed(v: boolean) {
  memory = v
  try {
    localStorage.setItem(KEY, v ? '1' : '0')
  } catch {
    // storage unavailable: in-memory only
  }
  apply(v)
  listeners.forEach((l) => l())
}

export function useRedMode(): [boolean, (v: boolean) => void] {
  const red = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => apply(red), [red])
  return [red, setRed]
}

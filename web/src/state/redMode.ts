import { useCallback, useEffect, useState } from 'react'

const KEY = 'dsf.red'

function readStored(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function useRedMode(): [boolean, (v: boolean) => void] {
  const [red, setRedState] = useState<boolean>(readStored)

  useEffect(() => {
    if (red) document.documentElement.dataset.red = 'true'
    else delete document.documentElement.dataset.red
  }, [red])

  const setRed = useCallback((v: boolean) => {
    setRedState(v)
    try {
      localStorage.setItem(KEY, v ? '1' : '0')
    } catch {
      // storage unavailable: keep in-memory state only
    }
  }, [])

  return [red, setRed]
}

import './controls.css'

const DENIED = 'Location unavailable — search for a place instead.'

interface Props {
  onLocate: (p: { lat: number; lon: number }) => void
  onError: (msg: string) => void
}

export function LocateButton({ onLocate, onError }: Props) {
  function locate() {
    if (!navigator.geolocation) return onError(DENIED)
    navigator.geolocation.getCurrentPosition(
      (pos) => onLocate({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => onError(DENIED),
      { timeout: 10000, maximumAge: 60000 },
    )
  }
  return (
    <button type="button" className="ctl-btn" onClick={locate}>
      Use my location
    </button>
  )
}

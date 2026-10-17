export function directionsUrl(lat: number, lon: number, ua: string, touchPoints = 0): string {
  const ipadOs = /Macintosh/i.test(ua) && touchPoints > 1
  if (ipadOs || /iPhone|iPad|iPod/i.test(ua)) return `https://maps.apple.com/?daddr=${lat},${lon}`
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
}

export function DirectionsButton({ lat, lon }: { lat: number; lon: number }) {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints
  return (
    <a className="directions-button" href={directionsUrl(lat, lon, ua, touchPoints)} target="_blank" rel="noopener noreferrer">
      Directions
    </a>
  )
}

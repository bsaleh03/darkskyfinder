export function directionsUrl(lat: number, lon: number, ua: string): string {
  if (/iPhone|iPad|iPod/i.test(ua)) return `https://maps.apple.com/?daddr=${lat},${lon}`
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
}

export function DirectionsButton({ lat, lon }: { lat: number; lon: number }) {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return (
    <a className="directions-button" href={directionsUrl(lat, lon, ua)} target="_blank" rel="noopener noreferrer">
      Directions
    </a>
  )
}

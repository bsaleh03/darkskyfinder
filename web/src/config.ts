export const config = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:8000',
  tilesUrl: (import.meta.env.VITE_TILES_URL as string | undefined) || '/tiles',
}

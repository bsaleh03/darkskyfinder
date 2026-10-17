/** Map any #RRGGBB to a dark red of equal perceived luminance (#RR0000). */
export function toRed(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`toRed: expected #RRGGBB, got ${hex}`)
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
  return `#${y.toString(16).padStart(2, '0').toUpperCase()}0000`
}

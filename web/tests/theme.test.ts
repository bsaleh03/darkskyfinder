import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

function props(file: string): Record<string, string> {
  const css = readFileSync(resolve(process.cwd(), 'src/theme', file), 'utf8')
  const out: Record<string, string> = {}
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim().toLowerCase()
  return out
}

const norm = (v: string) =>
  v
    .replace(/rgba?\(/, 'rgb(')
    .replace(/\s*\/\s*/, ' ')
    .trim()
    .replace(/(\s|,\s*)+/g, ',')
    .replace(',)', ')')

test('tokens.css has the exact Global Constraints values', () => {
  const t = props('tokens.css')
  expect(t['--sky-1']).toBe('#1a1840')
  expect(t['--sky-2']).toBe('#0b0f2a')
  expect(t['--sky-3']).toBe('#070a18')
  expect(t['--sky-4']).toBe('#05060f')
  expect(t['--ink']).toBe('#eef0f7')
  expect(t['--muted']).toBe('#9cacc3')
  expect(t['--amber']).toBe('#f5c96b')
  expect(t['--violet']).toBe('#a58be0')
  expect(t['--go']).toBe('#7fd6a0')
  expect(t['--maybe']).toBe('#f0c070')
  expect(t['--no']).toBe('#f0808a')
  expect(norm(t['--glass'])).toBe('rgb(20,24,48,55%)')
  expect(norm(t['--glass-border'])).toBe('rgb(255,255,255,8%)')
  expect(t['--radius-card']).toBe('16px')
  expect(t['--radius-control']).toBe('12px')
})

function toRgb(v: string): [number, number, number] {
  const n = norm(v)
  const hex = n.match(/^#([0-9a-f]{6})$/)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number]
  const fn = n.match(/^rgb\((\d+),(\d+),(\d+)/)
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])]
  throw new Error(`unparsed color ${v}`)
}

function hue([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  return (h + 360) % 360
}

test('red.css remaps every token and stays black or within 10deg of red', () => {
  const t = props('tokens.css')
  const r = props('red.css')
  expect(Object.keys(r).sort()).toEqual(Object.keys(t).filter((k) => !k.startsWith('--radius')).sort())
  for (const k of ['--sky-1', '--sky-2', '--sky-3', '--sky-4']) expect(r[k]).toBe('#000')
  for (const [k, v] of Object.entries(r)) {
    if (v === '#000') continue
    const rgb = toRgb(v)
    const h = hue(rgb)
    const dist = Math.min(h, 360 - h)
    expect(dist, `${k}: ${v} hue ${h}`).toBeLessThanOrEqual(10)
  }
})

test('red mode tints emoji with a CSS filter', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/theme/red.css'), 'utf8')
  const rule = css.match(/html\[data-red="true"\]\s+\.emoji\s*\{([^}]*)\}/)
  expect(rule?.[1]).toMatch(/filter:\s*[^;]*sepia/)
})

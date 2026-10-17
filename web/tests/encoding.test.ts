import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const EXTS = new Set(['.ts', '.tsx', '.css', '.json', '.html'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : EXTS.has(extname(p)) ? [p] : []
  })
}

describe('source encoding', () => {
  it('every source file is valid UTF-8', () => {
    const bad: string[] = []
    for (const f of [...walk('src'), ...walk('tests')]) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(f))
      } catch {
        bad.push(f)
      }
    }
    expect(bad).toEqual([])
  })
})

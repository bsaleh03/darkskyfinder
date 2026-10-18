// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(tsx?|jsx?|css)$/.test(name) ? [p] : []
  })

describe('app bundle', () => {
  it('app sources never import the live map', () => {
    const offenders = sourceFiles(join(root, 'src')).filter((f) =>
      /(from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](maplibre-gl|pmtiles)(\/[^'"]*)?['"]/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('maplibre-gl and pmtiles are dev dependencies only', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    for (const dep of ['maplibre-gl', 'pmtiles']) {
      expect(pkg.dependencies ?? {}).not.toHaveProperty(dep)
      expect(pkg.devDependencies).toHaveProperty(dep)
    }
  })
})

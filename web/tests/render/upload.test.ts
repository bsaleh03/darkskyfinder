// scripts/upload_tiles.sh against a stub rclone: the allow-list must come from the manifest (level-0 widths and
// the level >= 1 base and base_red tiles) and nothing else in web/ may go up.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildManifest, manifestFiles } from '../../render/manifest'

const ROOT = resolve(__dirname, '../../..')
const SCRIPT = join(ROOT, 'scripts/upload_tiles.sh').replace(/\\/g, '/')
// On Windows, System32\bash.exe is WSL; use Git Bash explicitly.
const BASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync) ?? 'bash'

const STUB = `#!/usr/bin/env bash
case "$1" in
  listremotes) echo "r2:"; exit 0 ;;
  copy)
    shift; src="$1"; dst="$2"; shift 2
    header=""; dry=0; incs=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --include) incs+=("$2"); shift 2 ;;
        --header-upload) header="$2"; shift 2 ;;
        --dry-run) dry=1; shift ;;
        *) shift ;;
      esac
    done
    for f in "\${incs[@]}"; do echo "FILE $dst$f|$header|dry=$dry"; done ;;
  *) echo "unexpected rclone call: $*" >&2; exit 3 ;;
esac
`

const extents = {
  se_mi: { bounds: [-86.9, 41.65, -82.4, 45.9] as [number, number, number, number], width: 3496, height: 4576, levels: [0, 1] },
  bay_area: { bounds: [-123.2, 36.4, -121.0, 38.6] as [number, number, number, number], width: 3560, height: 4488, levels: [0, 1] },
}

let tmp = ''
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'upload-test-'))
  mkdirSync(join(tmp, 'bin'))
  writeFileSync(join(tmp, 'bin', 'rclone'), STUB, { mode: 0o755 })
  for (const [metro, extent] of Object.entries(extents)) {
    const dir = join(tmp, 'maps', metro, 'web')
    mkdirSync(dir, { recursive: true })
    const m = buildManifest(metro, extent)
    for (const f of manifestFiles(m)) writeFileSync(join(dir, f), 'x')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n')
    // Strays that must never go up.
    for (const f of ['base.png', 'base_L2_0_0.webp', 'notes.txt', 'glow_L0_0_0.webp', 'glow_L1_0_0.webp', 'glow_red_L1_1_1.webp']) writeFileSync(join(dir, f), 'x')
  }
})
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('upload_tiles.sh --dry-run (stub rclone)', () => {
  it('uploads exactly the manifest-derived files: 44 for both regions', () => {
    const fwd = (p: string) => p.replace(/\\/g, '/')
    const r = spawnSync(
      BASH,
      ['-c', 'b="$STUB_BIN"; command -v cygpath >/dev/null && b="$(cygpath -u "$b")"; PATH="$b:$PATH"; exec bash "$0" --dry-run', SCRIPT],
      { env: { ...process.env, STUB_BIN: fwd(join(tmp, 'bin')), MAPS_DIR: fwd(join(tmp, 'maps')) }, encoding: 'utf8' },
    )
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('FILE '))
    expect(lines).toHaveLength(44)
    const expected: string[] = []
    for (const [metro, extent] of Object.entries(extents)) {
      for (const f of manifestFiles(buildManifest(metro, extent))) expected.push(`r2:darksky-tiles/maps/${metro}/${f}`)
    }
    const got = lines.map((l) => l.slice(5).split('|')[0])
    expect(got.sort()).toEqual(expected.sort())
    for (const l of lines) {
      const [file, header, dry] = l.slice(5).split('|')
      expect(dry).toBe('dry=1')
      expect(header).toBe(file.endsWith('.json') ? 'Cache-Control: public, max-age=300' : 'Cache-Control: public, max-age=86400')
    }
    expect(r.stdout).toContain('== se_mi (22 files)')
    expect(r.stdout).toContain('== bay_area (22 files)')
    expect(r.stdout).toContain('44 files')
  })
})

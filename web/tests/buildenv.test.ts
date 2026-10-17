import { describe, expect, it } from 'vitest'
import { checkBuildEnv } from '../buildenv'

const ok = { VITE_API_URL: 'https://darksky-api.onrender.com', VITE_TILES_URL: 'https://tiles.example.dev' }

describe('checkBuildEnv', () => {
  it('fails a Render build that is missing the API or tiles URL', () => {
    expect(() => checkBuildEnv({ RENDER: 'true' })).toThrow(/VITE_API_URL, VITE_TILES_URL/)
    expect(() => checkBuildEnv({ RENDER: 'true', VITE_API_URL: ok.VITE_API_URL })).toThrow(/VITE_TILES_URL/)
    expect(() => checkBuildEnv({ RENDER: 'true', VITE_TILES_URL: ' ', VITE_API_URL: ok.VITE_API_URL })).toThrow(
      /VITE_TILES_URL/,
    )
    expect(() => checkBuildEnv({ RENDER: 'true', ...ok })).not.toThrow()
  })

  it('leaves local builds alone', () => {
    expect(() => checkBuildEnv({})).not.toThrow()
    expect(() => checkBuildEnv({ RENDER: '' })).not.toThrow()
  })
})

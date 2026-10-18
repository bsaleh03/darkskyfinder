import { describe, expect, it } from 'vitest'
import { renderFailure } from '../../render/errors'

describe('renderFailure', () => {
  it('passes when the map reported no errors', () => {
    expect(renderFailure([])).toBeNull()
  })

  it('fails on any source or tile error, naming the count and the first errors', () => {
    const msg = renderFailure(['se_mi-base: HTTP 404', 'borders: Failed to fetch', 'x', 'y'])
    expect(msg).toMatch(/^4 map errors/)
    expect(msg).toContain('se_mi-base: HTTP 404')
    expect(msg).toContain('borders: Failed to fetch')
    expect(msg).toContain('x')
    expect(msg).not.toContain('y')
  })

  it('uses the singular for one error', () => {
    expect(renderFailure(['boom'])).toBe('1 map error during render: boom')
  })
})

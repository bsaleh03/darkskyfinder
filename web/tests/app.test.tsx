import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import App from '../src/App'

vi.mock('../src/map/MapView', () => ({ MapView: () => <div data-testid="map" /> }))
vi.mock('../src/api/client', async (orig) => {
  const actual = await orig<typeof import('../src/api/client')>()
  return {
    ...actual,
    fetchRegions: vi.fn().mockResolvedValue([]),
    fetchHealth: vi.fn().mockResolvedValue({ ok: true, metros: [], release: 'test' }),
  }
})

beforeEach(() => window.history.replaceState(null, '', '/'))

test('renders the app name', () => {
  render(<App />)
  expect(screen.getByRole('banner')).toHaveTextContent('Dark Sky Finder')
})

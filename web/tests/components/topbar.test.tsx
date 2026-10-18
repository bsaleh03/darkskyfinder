import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as client from '../../src/api/client'
import { makeQueryClient } from '../../src/api/queries'
import type { Region, SearchHit } from '../../src/api/types'
import { LocateButton } from '../../src/components/LocateButton'
import { MetroSwitch } from '../../src/components/MetroSwitch'
import { RedModeToggle } from '../../src/components/RedModeToggle'
import { SearchBox } from '../../src/components/SearchBox'
import { TopBar } from '../../src/components/TopBar'

vi.mock('../../src/api/client', async (orig) => {
  const actual = await orig<typeof import('../../src/api/client')>()
  return { ...actual, fetchSearch: vi.fn() }
})
const fetchSearch = vi.mocked(client.fetchSearch)

const hit = (name: string, metro = 'se_mi'): SearchHit => ({ name, kind: 'Locality', lat: 42.5, lon: -83.1, metro })

function renderBox(onPick = vi.fn()) {
  const qc = makeQueryClient()
  render(
    <QueryClientProvider client={qc}>
      <SearchBox onPick={onPick} />
    </QueryClientProvider>,
  )
  return onPick
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  fetchSearch.mockReset()
})
afterEach(() => vi.useRealTimers())

async function advance(ms: number) {
  for (let t = 0; t < ms; t += 50) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
  }
}

function type(text: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } })
}

describe('SearchBox', () => {
  it('search shows hits and picks with keyboard', async () => {
    fetchSearch.mockResolvedValue([hit('Royal Oak'), hit('Royal Palm', 'bay_area')])
    const onPick = renderBox()
    const input = screen.getByRole('combobox')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    type('roy')
    await advance(400)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('Royal Oak')
    expect(options[0]).toHaveTextContent('Locality · Michigan')
    expect(options[1]).toHaveTextContent('Locality · SF Bay Area')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'Royal Oak' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Escape closes the list', async () => {
    fetchSearch.mockResolvedValue([hit('Royal Oak')])
    renderBox()
    type('roy')
    await advance(400)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('picks by click', async () => {
    fetchSearch.mockResolvedValue([hit('Royal Oak')])
    const onPick = renderBox()
    type('roy')
    await advance(400)
    fireEvent.click(screen.getByRole('option'))
    expect(onPick).toHaveBeenCalledOnce()
  })

  it('ignores out-of-order search responses', async () => {
    let resolveSlow: (h: SearchHit[]) => void = () => {}
    fetchSearch.mockImplementation((q: string) =>
      q === 'roy'
        ? new Promise<SearchHit[]>((r) => {
            resolveSlow = r
          })
        : Promise.resolve([hit('Royal Oak MI')]),
    )
    renderBox()
    type('roy')
    await advance(300)
    type('royal')
    await advance(400)
    await act(async () => resolveSlow([hit('Stale Result')]))
    await advance(100)
    const names = screen.getAllByRole('option').map((o) => o.textContent)
    expect(names.join()).toContain('Royal Oak MI')
    expect(names.join()).not.toContain('Stale Result')
  })

  it('no request under 2 chars', async () => {
    renderBox()
    type('r')
    await advance(500)
    expect(fetchSearch).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('LocateButton', () => {
  const orig = navigator.geolocation
  afterEach(() => Object.defineProperty(navigator, 'geolocation', { value: orig, configurable: true }))

  it('locate success calls onLocate', () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: 1, longitude: 2 } } as GeolocationPosition),
      },
    })
    const onLocate = vi.fn()
    const onError = vi.fn()
    render(<LocateButton onLocate={onLocate} onError={onError} />)
    fireEvent.click(screen.getByRole('button', { name: /use my location/i }))
    expect(onLocate).toHaveBeenCalledWith({ lat: 1, lon: 2 })
    expect(onError).not.toHaveBeenCalled()
  })

  it('locate denied shows message', () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_: PositionCallback, err: PositionErrorCallback) =>
          err({ code: 1 } as GeolocationPositionError),
      },
    })
    const onError = vi.fn()
    render(<LocateButton onLocate={vi.fn()} onError={onError} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onError).toHaveBeenCalledWith('Location unavailable — search or tap the map instead.')
  })

  it('reports unavailable when geolocation is missing', () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined })
    const onError = vi.fn()
    render(<LocateButton onLocate={vi.fn()} onError={onError} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onError).toHaveBeenCalledOnce()
  })
})

describe('RedModeToggle', () => {
  it('red toggle sets data-red', async () => {
    vi.useRealTimers()
    localStorage.clear()
    render(<RedModeToggle />)
    const sw = screen.getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(sw)
    expect(document.documentElement.dataset.red).toBe('true')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(sw)
    expect(document.documentElement.dataset.red).toBeUndefined()
  })
})

describe('MetroSwitch', () => {
  const regions: Region[] = [
    { key: 'se_mi', name: 'Michigan', bbox: [], center: [], zoom: 8, timezone: 'x' },
    { key: 'bay_area', name: 'SF Bay Area', bbox: [], center: [], zoom: 8, timezone: 'x' },
  ]
  it('metro switch lists regions', () => {
    const onChange = vi.fn()
    render(<MetroSwitch regions={regions} value="se_mi" onChange={onChange} />)
    const opts = screen.getAllByRole('option')
    expect(opts.map((o) => o.textContent)).toEqual(['Michigan', 'SF Bay Area'])
    expect(screen.getByRole('combobox')).toHaveValue('se_mi')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bay_area' } })
    expect(onChange).toHaveBeenCalledWith('bay_area')
  })
})

describe('TopBar start chip', () => {
  function renderBar(startLabel: string | null = 'Royal Oak') {
    const qc = makeQueryClient()
    render(
      <QueryClientProvider client={qc}>
        <TopBar
          startLabel={startLabel}
          regions={[]}
          metro="se_mi"
          onMetroChange={vi.fn()}
          onPick={vi.fn()}
          onLocate={vi.fn()}
          onLocateError={vi.fn()}
        />
        <button type="button">elsewhere</button>
      </QueryClientProvider>,
    )
  }

  it('tapping the chip focuses the search input; Escape returns to the chip', () => {
    renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Royal Oak' }))
    const input = screen.getByRole('combobox', { name: 'Search for a place' })
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('combobox', { name: 'Search for a place' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Royal Oak' })).toHaveFocus()
  })

  it('leaving an empty search shows the chip again, but not when moving to Use my location', () => {
    renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Royal Oak' }))
    const input = screen.getByRole('combobox', { name: 'Search for a place' })
    const locate = screen.getByRole('button', { name: 'Use my location' })
    fireEvent.blur(input, { relatedTarget: locate })
    expect(screen.getByRole('combobox', { name: 'Search for a place' })).toBeInTheDocument()
    input.focus()
    fireEvent.change(input, { target: { value: 'roy' } })
    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'elsewhere' }) })
    expect(screen.getByRole('combobox', { name: 'Search for a place' })).toBeInTheDocument() // a typed query is kept
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'elsewhere' }) })
    expect(screen.queryByRole('combobox', { name: 'Search for a place' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Royal Oak' })).toBeInTheDocument()
  })

  it('without a start the search stays', () => {
    renderBar(null)
    const input = screen.getByRole('combobox', { name: 'Search for a place' })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(screen.getByRole('combobox', { name: 'Search for a place' })).toBeInTheDocument()
  })
})

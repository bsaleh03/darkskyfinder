import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Controls } from '../../src/components/Controls'
import type { AppState } from '../../src/state/useAppState'

const base: AppState = {
  start: null,
  night: null,
  drive: 90,
  sort: 'relevant',
  access: 'all',
  border: 'include',
  glow: true,
  spot: null,
}

function setup(over: Partial<AppState> = {}, metro: string | null = 'se_mi', showVerified = false) {
  const onChange = vi.fn()
  render(<Controls state={{ ...base, ...over }} metro={metro} showVerified={showVerified} onChange={onChange} />)
  return onChange
}

describe('Controls', () => {
  it('slider emits snapped values', () => {
    const onChange = setup()
    expect(screen.getByText('Within 90 min')).toBeInTheDocument()
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '120' } })
    expect(onChange).toHaveBeenLastCalledWith({ drive: 120 })
    fireEvent.change(slider, { target: { value: '137' } })
    expect(onChange).toHaveBeenLastCalledWith({ drive: 135 })
  })

  it('sort and access emit patches', async () => {
    const onChange = setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Closest' }))
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'closest' })
    await user.click(screen.getByRole('radio', { name: 'Best view' }))
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'best_view' })
    await user.click(screen.getByRole('radio', { name: 'Likely open' }))
    expect(onChange).toHaveBeenLastCalledWith({ access: 'likely' })
    expect(screen.getByRole('radio', { name: 'Relevant' })).toHaveAttribute('aria-checked', 'true')
  })

  it('verified option hidden unless showVerified', () => {
    const { unmount } = render(
      <Controls state={base} metro="se_mi" showVerified={false} onChange={vi.fn()} />,
    )
    expect(screen.queryByRole('radio', { name: 'Verified only' })).toBeNull()
    unmount()
    render(<Controls state={base} metro="se_mi" showVerified onChange={vi.fn()} />)
    expect(screen.getByRole('radio', { name: 'Verified only' })).toBeInTheDocument()
  })

  it('Canada switch only in se_mi and maps to border', async () => {
    const onChange = setup()
    const user = userEvent.setup()
    const sw = screen.getByRole('switch', { name: 'Include Canada' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await user.click(sw)
    expect(onChange).toHaveBeenLastCalledWith({ border: 'exclude' })
  })

  it('Canada switch absent elsewhere and reflects exclude', async () => {
    const { unmount } = render(
      <Controls state={base} metro="sf_bay" showVerified={false} onChange={vi.fn()} />,
    )
    expect(screen.queryByRole('switch')).toBeNull()
    unmount()
    const onChange = vi.fn()
    render(<Controls state={{ ...base, border: 'exclude' }} metro="se_mi" showVerified={false} onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: 'Include Canada' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await userEvent.setup().click(sw)
    expect(onChange).toHaveBeenLastCalledWith({ border: 'include' })
  })
})

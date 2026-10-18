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
  stateBorder: 'include',
  glow: true,
  spot: null,
}

function setup(over: Partial<AppState> = {}, metro: string | null = 'se_mi', showVerified = false) {
  const onChange = vi.fn()
  render(<Controls state={{ ...base, ...over }} metro={metro} showVerified={showVerified} onChange={onChange} />)
  return onChange
}

describe('Controls', () => {
  it('slider label follows the drag but commits once on release', () => {
    const onChange = setup()
    expect(screen.getByText('Within 90 min')).toBeInTheDocument()
    const slider = screen.getByRole('slider')
    for (const v of ['105', '120', '137']) fireEvent.input(slider, { target: { value: v } })
    expect(screen.getByText('Within 135 min')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider)
    expect(onChange.mock.calls).toEqual([[{ drive: 135 }]])
  })

  it('slider commits on change, keyup, blur and pointercancel', () => {
    const onChange = setup()
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '120' } }) // keyboard step or programmatic fill
    expect(onChange).toHaveBeenLastCalledWith({ drive: 120 })
    fireEvent.input(slider, { target: { value: '60' } })
    fireEvent.keyUp(slider, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith({ drive: 60 })
    fireEvent.input(slider, { target: { value: '150' } })
    fireEvent.blur(slider)
    expect(onChange).toHaveBeenLastCalledWith({ drive: 150 })
    fireEvent.input(slider, { target: { value: '45' } })
    fireEvent.pointerCancel(slider)
    expect(onChange).toHaveBeenLastCalledWith({ drive: 45 })
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('release without moving does not commit', () => {
    const onChange = setup()
    const slider = screen.getByRole('slider')
    fireEvent.pointerUp(slider)
    fireEvent.keyUp(slider, { key: 'Tab' })
    fireEvent.blur(slider)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('sort emits patches; access is no longer a segmented control', async () => {
    const onChange = setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Closest' }))
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'closest' })
    await user.click(screen.getByRole('radio', { name: 'Best view' }))
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'best_view' })
    expect(screen.getByRole('radio', { name: 'Relevant' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('radiogroup', { name: 'Access' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Likely open' })).toBeNull()
  })

  it('More filters holds the three switches in se_mi with the right state and patches', async () => {
    const onChange = setup()
    const user = userEvent.setup()
    expect(screen.queryByRole('switch')).toBeNull()
    const more = screen.getByRole('button', { name: 'More filters' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    const likely = screen.getByRole('switch', { name: 'Likely open' })
    const country = screen.getByRole('switch', { name: 'Crosses country border' })
    const state = screen.getByRole('switch', { name: 'Crosses state border' })
    expect(more.getAttribute('aria-controls')).toBe(likely.closest('[id]')?.id)
    expect(likely).toHaveAttribute('aria-checked', 'false')
    expect(country).toHaveAttribute('aria-checked', 'true')
    expect(state).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('switch', { name: 'Verified only' })).toBeNull()
    await user.click(likely)
    expect(onChange).toHaveBeenLastCalledWith({ access: 'likely' })
    await user.click(country)
    expect(onChange).toHaveBeenLastCalledWith({ border: 'exclude' })
    await user.click(state)
    expect(onChange).toHaveBeenLastCalledWith({ stateBorder: 'exclude' })
    await user.click(more)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('switches reflect non-default state, count them, and toggle back', async () => {
    const onChange = setup({ access: 'likely', border: 'exclude', stateBorder: 'exclude' })
    const user = userEvent.setup()
    const more = screen.getByRole('button', { name: 'More filters (3 on)' })
    await user.click(more)
    const likely = screen.getByRole('switch', { name: 'Likely open' })
    expect(likely).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'Crosses country border' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'Crosses state border' })).toHaveAttribute('aria-checked', 'false')
    await user.click(likely)
    expect(onChange).toHaveBeenLastCalledWith({ access: 'all' })
    await user.click(screen.getByRole('switch', { name: 'Crosses country border' }))
    expect(onChange).toHaveBeenLastCalledWith({ border: 'include' })
    await user.click(screen.getByRole('switch', { name: 'Crosses state border' }))
    expect(onChange).toHaveBeenLastCalledWith({ stateBorder: 'include' })
  })

  it('outside se_mi More filters has only Likely open', async () => {
    setup({}, 'bay_area')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More filters' }))
    expect(screen.getByRole('switch', { name: 'Likely open' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Crosses country border' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Crosses state border' })).toBeNull()
  })

  it('Verified only switch appears only with showVerified', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Controls state={base} metro="se_mi" showVerified={false} onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'More filters' }))
    expect(screen.queryByRole('switch', { name: 'Verified only' })).toBeNull()
    unmount()
    const onChange = vi.fn()
    render(<Controls state={{ ...base, access: 'verified' }} metro="se_mi" showVerified onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'More filters (1 on)' }))
    const v = screen.getByRole('switch', { name: 'Verified only' })
    expect(v).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'Likely open' })).toHaveAttribute('aria-checked', 'false')
    await user.click(v)
    expect(onChange).toHaveBeenLastCalledWith({ access: 'all' })
    await user.click(screen.getByRole('switch', { name: 'Likely open' }))
    expect(onChange).toHaveBeenLastCalledWith({ access: 'likely' })
  })

  it('segmented arrow keys move selection and focus', async () => {
    const onChange = setup()
    const user = userEvent.setup()
    const relevant = screen.getByRole('radio', { name: 'Relevant' })
    relevant.focus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'closest' })
    expect(screen.getByRole('radio', { name: 'Closest' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'best_view' })
    expect(screen.getByRole('radio', { name: 'Best view' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'relevant' })
    await user.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'best_view' })
    await user.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'relevant' })
    await user.keyboard('{ArrowUp}')
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'best_view' })
  })

  it('slider clamps edge values', () => {
    const onChange = setup()
    const slider = screen.getByRole('slider')
    fireEvent.input(slider, { target: { value: '20' } })
    fireEvent.pointerUp(slider)
    expect(onChange).toHaveBeenLastCalledWith({ drive: 30 })
    fireEvent.input(slider, { target: { value: '200' } })
    fireEvent.pointerUp(slider)
    expect(onChange).toHaveBeenLastCalledWith({ drive: 180 })
  })
})

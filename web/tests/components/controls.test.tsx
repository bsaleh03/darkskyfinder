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
    screen.getByRole('radio', { name: 'All' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith({ access: 'likely' })
    expect(screen.getByRole('radio', { name: 'Likely open' })).toHaveFocus()
  })

  it('access group stays tabbable when value is hidden', () => {
    setup({ access: 'verified' }, 'se_mi', false)
    const group = screen.getByRole('radiogroup', { name: 'Access' })
    const tabbable = Array.from(group.querySelectorAll('[role="radio"]')).filter(
      (b) => (b as HTMLElement).tabIndex === 0,
    )
    expect(tabbable).toHaveLength(1)
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('tabindex', '0')
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

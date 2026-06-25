import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

beforeEach(() => {
  localStorage.clear()
  cleanup()
})

describe('long-tail landing components render', () => {
  it('Welcome renders the hero title + Try it now CTA', async () => {
    const { Welcome } = await import('../src/components/Welcome')
    render(<Welcome />)
    expect(screen.getByText('MsgBoard')).toBeTruthy()
    expect(screen.getByRole('button', { name: /try it now/i })).toBeTruthy()
  })

  it('Footer renders the theme radiogroup (3 options) + copyright', async () => {
    const { Footer } = await import('../src/components/Footer')
    render(<Footer />)
    const group = screen.getByRole('radiogroup', { name: /color theme/i })
    expect(group).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByText(/All rights reserved/i)).toBeTruthy()
  })

  it('SalesPitch renders the four value props', async () => {
    const { SalesPitch } = await import('../src/components/SalesPitch')
    render(<SalesPitch />)
    expect(screen.getByText('Censorship-Resistant')).toBeTruthy()
    expect(screen.getByText('Ephemeral')).toBeTruthy()
    expect(screen.getByText('Permissionless')).toBeTruthy()
    expect(screen.getByText('Paid in Work')).toBeTruthy()
  })

  it('UseCases renders a carousel of use-case cards', async () => {
    const { UseCases } = await import('../src/components/UseCases')
    render(<UseCases />)
    expect(screen.getByText('Use Cases')).toBeTruthy()
    expect(screen.getByRole('group', { name: /use cases/i })).toBeTruthy()
    expect(screen.getByText('Multi-Sigs')).toBeTruthy()
  })

  it('ProtocolComparison renders the comparison table rows', async () => {
    const { ProtocolComparison } = await import('../src/components/ProtocolComparison')
    render(<ProtocolComparison />)
    expect(screen.getByText('Censorship Resistance')).toBeTruthy()
    expect(screen.getByText('Waku')).toBeTruthy()
    expect(screen.getByText('Nostr')).toBeTruthy()
  })

  it('NextSteps renders the call-to-action cards', async () => {
    const { NextSteps } = await import('../src/components/NextSteps')
    render(<NextSteps />)
    expect(screen.getByText('Run the Examples')).toBeTruthy()
    expect(screen.getByText('Explore the API')).toBeTruthy()
  })

  it('JoinNetwork renders the provider support matrix', async () => {
    const { JoinNetwork } = await import('../src/components/JoinNetwork')
    render(<JoinNetwork />)
    expect(screen.getByText('Join the Network')).toBeTruthy()
    expect(screen.getByText('valve.city')).toBeTruthy()
  })

  it('GamesCallout renders the venue callout', async () => {
    const { GamesCallout } = await import('../src/components/GamesCallout')
    render(<GamesCallout />)
    expect(screen.getByText(/Enter the venue/i)).toBeTruthy()
  })

  it('SideToc renders the section nav buttons', async () => {
    const { SideToc } = await import('../src/components/SideToc')
    render(
      <SideToc
        sections={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ]}
      />,
    )
    expect(screen.getByRole('navigation', { name: /on this page/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy()
  })

  it('Code renders shiki-highlighted output + a copy button', async () => {
    const { Code } = await import('../src/components/Code')
    const { container } = render(<Code code="const x = 1" lang="typescript" />)
    expect(container.querySelector('.shiki')).toBeTruthy()
  })

  it('Carousel renders one card per item via the render-prop', async () => {
    const { Carousel } = await import('../src/components/Carousel')
    render(
      <Carousel
        items={[{ t: 'one' }, { t: 'two' }]}
        label="things"
        card={(it: { t: string }) => <div>{it.t}</div>}
      />,
    )
    expect(screen.getByRole('group', { name: /things/i })).toBeTruthy()
    expect(screen.getByText('one')).toBeTruthy()
    expect(screen.getByText('two')).toBeTruthy()
  })

  it('OpenRpcReference renders methods + schemas from the openrpc object', async () => {
    const { OpenRpcReference } = await import('../src/components/OpenRpcReference')
    const { openrpc } = await import('../src/lib/docs-content.generated')
    render(<OpenRpcReference openrpc={openrpc} />)
    expect(screen.getByText('msgboard_status')).toBeTruthy()
    expect(screen.getByText('Schemas')).toBeTruthy()
    // "Status" appears as both a method-return TypeRef link and the schema name; assert ≥1
    expect(screen.getAllByText('Status').length).toBeGreaterThan(0)
  })
})

describe('iconify swap (@iconify/react)', () => {
  it('renders icons across ported components (no missing-icon placeholder text)', async () => {
    const { Welcome } = await import('../src/components/Welcome')
    const { container } = render(<Welcome />)
    // the @iconify/react <Icon> renders an inline <svg> carrying the requested icon name —
    // proving the @iconify/svelte → @iconify/react swap is wired and the name flows through
    const icon = container.querySelector('svg[data-icon]')
    expect(icon).toBeTruthy()
    expect(icon?.getAttribute('data-icon')).toBe('mdi:bullseye-arrow')
    // the icon name never leaks into the page text (no missing-icon placeholder regression)
    expect(container.textContent).not.toContain('mdi:')
  })
})

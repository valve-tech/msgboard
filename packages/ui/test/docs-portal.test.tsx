import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

beforeEach(() => {
  localStorage.clear()
  cleanup()
})

describe('DocsPortal — markdown + shiki pipeline', () => {
  it('renders the README markdown as HTML headings with stable slug ids', async () => {
    const { DocsPortal } = await import('../src/pages/DocsPortal')
    const { container } = render(<DocsPortal />)
    // markdown-it rendered the H2s; the heading_open rule gives them slug ids
    const install = container.querySelector('#install')
    expect(install).toBeTruthy()
    expect(install?.textContent).toContain('Install')
  })

  it('highlights fenced code blocks via the shiki highlighter (shiki classes present)', async () => {
    const { DocsPortal } = await import('../src/pages/DocsPortal')
    const { container } = render(<DocsPortal />)
    // shiki emits <pre class="shiki ..."> for highlighted fences; plain markdown-it would not
    const shiki = container.querySelector('pre.shiki, .shiki')
    expect(shiki).toBeTruthy()
  })

  it('renders the structured OpenRPC reference (not flat markdown) where the generated block sits', async () => {
    const { DocsPortal } = await import('../src/pages/DocsPortal')
    render(<DocsPortal />)
    // OpenRpcReference renders a structured "JSON-RPC methods" heading (the SideToc also lists
    // it as a nav button, so scope to the heading) + the method names as <code>
    expect(await screen.findByRole('heading', { name: 'JSON-RPC methods' })).toBeTruthy()
    expect(await screen.findByText('msgboard_status')).toBeTruthy()
  })

  it('strips the GENERATED:OPENRPC HTML comment markers (no literal comment text)', async () => {
    const { DocsPortal } = await import('../src/pages/DocsPortal')
    const { container } = render(<DocsPortal />)
    expect(container.innerHTML).not.toContain('GENERATED:OPENRPC')
  })
})

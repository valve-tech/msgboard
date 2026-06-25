import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// The full app shell touches the network on mount (Interactive's worker board + the
// GamesLiveProof chain reads). Stub the SDK + viem so route rendering is offline.
vi.mock('@msgboard/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@msgboard/sdk')>()
  class FakeClient {
    async status() {
      return { enabled: true, workMultiplier: '1', workDivisor: '1' }
    }
    async content() {
      return {}
    }
  }
  return { ...actual, MsgBoardClient: FakeClient }
})
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: () => ({
      getBlockNumber: async () => 1n,
      getBalance: async () => 0n,
      // GamesLiveProof reads
      getContractEvents: async () => [],
      getBlock: async () => ({ timestamp: 0n }),
    }),
  }
})

beforeEach(() => {
  localStorage.clear()
  window.location.hash = ''
  cleanup()
})

const renderAt = async (hash: string) => {
  window.location.hash = hash
  const { hashStore } = await import('../src/router')
  hashStore.handleHashChange()
  const { App } = await import('../src/App')
  render(<App />)
}

describe('hash-router route coverage (parity with the Svelte App.svelte)', () => {
  it('#/ → Home (landing) renders the hero + interactive board', async () => {
    await renderAt('#/')
    // the interactive board's chain selector is on the home page (unique)
    expect(await screen.findByLabelText(/chain/i)).toBeTruthy()
    // hero word(s) from Welcome — "MsgBoard" appears across several sections
    expect((await screen.findAllByText('MsgBoard')).length).toBeGreaterThan(0)
    // the "Try it now" hero CTA is unique to the home landing
    expect(screen.getByRole('button', { name: /try it now/i })).toBeTruthy()
  })

  it('#/docs → DocsPortal renders the rendered README prose', async () => {
    await renderAt('#/docs')
    // "← Back to home" link is unique to the docs/examples sub-pages
    expect(await screen.findByText(/Back to home/i)).toBeTruthy()
    // the structured OpenRPC reference heading (SideToc also lists the label as a nav button)
    expect(await screen.findByRole('heading', { name: 'JSON-RPC methods' })).toBeTruthy()
  })

  it('#/examples → Examples renders the example cards', async () => {
    await renderAt('#/examples')
    expect(await screen.findByText('Examples')).toBeTruthy()
    expect(await screen.findByText('Submit a message')).toBeTruthy()
  })

  it('#/games → Games renders the venue page', async () => {
    await renderAt('#/games')
    // the prose heading (SideToc also lists this label as a nav button)
    expect(await screen.findByRole('heading', { name: 'How a draw works' })).toBeTruthy()
  })

  it('an unknown route redirects to home (#/)', async () => {
    await renderAt('#/totally-unknown')
    const { hashStore } = await import('../src/router')
    // RedirectToHome navigates back to '/'
    await new Promise((r) => setTimeout(r, 0))
    expect(hashStore.getSnapshot().id).toBe('/')
  })
})

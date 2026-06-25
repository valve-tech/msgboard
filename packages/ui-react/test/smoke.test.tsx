import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// App now renders the Interactive MVP flow, which touches the network on mount — stub it.
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
  return { ...actual, createPublicClient: () => ({ getBlockNumber: async () => 1n, getBalance: async () => 0n }) }
})

beforeEach(() => localStorage.clear())

describe('scaffold', () => {
  it('renders the app shell with the interactive board flow', async () => {
    const { App } = await import('../src/App')
    render(<App />)
    // the Interactive flow's chain selector is the entry point of the MVP screen
    expect(await screen.findByLabelText(/chain/i)).toBeTruthy()
  })
})

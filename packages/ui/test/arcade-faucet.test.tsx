import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { stringToHex, type Hex } from 'viem'

/**
 * Task 7 — Arcade "Get chips" flow.
 *
 * The faucet SERVICE watches the board category `stringToHex('chipsplease:943', { size: 32 })`
 * (a zero-padded name — NOT a keccak categoryHash) and matches requests via `isAddress(m.data)`.
 * This test proves the "Get chips" post lands on that exact wire shape: turn the memory-only
 * toggle off, connect a (mocked) wallet, click "Get chips", and assert the worker board received
 * an `addMessage` whose category/data match what the faucet service actually watches for.
 */

const WALLET_ADDR = ('0x' + 'aB'.repeat(20)) as Hex

vi.mock('../src/lib/wallet', () => ({
  connectInjectedWallet: vi.fn(async () => ({ address: WALLET_ADDR, chainId: 943 })),
}))

// The on-chain balance poll is exercised separately in chips.test.ts — stub it here so this test
// stays focused on the post shape and doesn't need a real PublicClient/RPC.
vi.mock('../src/lib/chips', () => ({
  readChipsBalance: vi.fn(async () => 5000n),
}))

type Posted = { type: string; category?: Hex; data?: Hex; [k: string]: unknown }

class FakeWorker {
  static instances: FakeWorker[] = []
  postedMessages: Posted[] = []
  private listeners: Record<string, Array<(e: unknown) => void>> = {}
  constructor() {
    FakeWorker.instances.push(this)
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    ;(this.listeners[type] ??= []).push(cb)
  }
  removeEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb)
  }
  postMessage(msg: Posted) {
    this.postedMessages.push(msg)
    queueMicrotask(() => {
      for (const l of this.listeners['message'] ?? [])
        l({ data: { type: 'complete', result: { message: {}, stats: { isValid: true } } } })
    })
  }
  terminate() {}
}

beforeEach(() => {
  localStorage.clear()
  cleanup()
  FakeWorker.instances.length = 0
})

describe('Arcade — "Get chips" (memory-only toggle off, wallet connected)', () => {
  it('posts to stringToHex("chipsplease:943",{size:32}) with data = the lowercased wallet address', async () => {
    const { useChainStore } = await import('../src/stores/chain')
    useChainStore.setState({ chainOption: 'pulsechainV4', content: null })
    const { Arcade } = await import('../src/components/Arcade')

    render(<Arcade workerFactory={() => new FakeWorker() as unknown as Worker} />)

    // memory-only is ON by default — no Connect button yet.
    expect(screen.queryByRole('button', { name: /connect/i })).toBeNull()

    // flip memory-only OFF
    const toggle = await screen.findByRole('switch')
    fireEvent.click(toggle)

    // connect the (mocked) wallet
    const connectBtn = await screen.findByRole('button', { name: /connect/i })
    fireEvent.click(connectBtn)

    // request chips
    const getChipsBtn = await screen.findByRole('button', { name: /get chips/i })
    fireEvent.click(getChipsBtn)

    await waitFor(() => expect(FakeWorker.instances.length).toBeGreaterThan(0))
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1]
    await waitFor(() => expect(worker.postedMessages.length).toBeGreaterThan(0))

    const req = worker.postedMessages[0]
    expect(req.category).toBe(stringToHex('chipsplease:943', { size: 32 }))
    expect(req.data).toBe(WALLET_ADDR.toLowerCase())

    // the on-chain balance eventually shows (from the mocked readChipsBalance)
    await screen.findByText(/5000/)
  })
})

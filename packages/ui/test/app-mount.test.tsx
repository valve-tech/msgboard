/**
 * Task 4 — App mounts the global store lifecycle helpers (Task-3 carry-forward).
 *
 * The Task-3 review flagged that `startChainPolling()` and `initThemeOSListener()` were
 * exported but never mounted. App must call both in a `useEffect` and tear them down on
 * unmount. This test spies on the real helpers and asserts mount + cleanup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

// keep the Interactive subtree headless: stub the SDK + viem network calls.
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

describe('App store mounting', () => {
  it('mounts startChainPolling + initThemeOSListener and cleans both up on unmount', async () => {
    const chain = await import('../src/stores/chain')
    const theme = await import('../src/stores/theme')

    const stopPolling = vi.fn()
    const stopTheme = vi.fn()
    const pollSpy = vi.spyOn(chain, 'startChainPolling').mockReturnValue(stopPolling)
    const themeSpy = vi.spyOn(theme, 'initThemeOSListener').mockReturnValue(stopTheme)

    const { App } = await import('../src/App')
    const { unmount } = render(<App />)

    expect(pollSpy).toHaveBeenCalledTimes(1)
    expect(themeSpy).toHaveBeenCalledTimes(1)
    expect(stopPolling).not.toHaveBeenCalled()
    expect(stopTheme).not.toHaveBeenCalled()

    unmount()
    expect(stopPolling).toHaveBeenCalledTimes(1)
    expect(stopTheme).toHaveBeenCalledTimes(1)

    pollSpy.mockRestore()
    themeSpy.mockRestore()
  })
})

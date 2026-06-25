import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

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
    createPublicClient: () => ({ getBlockNumber: async () => 1n, getBalance: async () => 0n }),
  }
})

beforeEach(() => {
  localStorage.clear()
  cleanup()
})

/**
 * Task-4 review carry-forward: a mid-session chain switch must reload the persisted
 * "interactive" state for the new scope (the Svelte scope-change `$effect`). We seed a
 * persisted message body for the second chain's scope, switch to it, and assert the
 * textarea adopts the persisted value.
 */
describe('Interactive reloads persisted state on a mid-session chain switch', () => {
  it('adopts the persisted interactive text for the newly selected chain scope', async () => {
    const { useChainStore, selectChain, selectRpcUrl } = await import('../src/stores/chain')
    const { getScope, save } = await import('../src/lib/persist')
    const { Interactive } = await import('../src/components/Interactive')

    // compute the scope for the target chain ('pulsechainV4') and seed a persisted body
    const start = useChainStore.getState()
    const initialOption = start.chainOption
    useChainStore.getState().setChainOption('pulsechainV4')
    const v4 = useChainStore.getState()
    const v4Scope = getScope(selectChain(v4)?.id, selectRpcUrl(v4))
    save(v4Scope, 'interactive', {
      text: 'persisted-on-v4',
      categoryType: 'input',
      categoryValue: 'x',
    })
    // reset back to the original chain so the switch happens AFTER mount
    useChainStore.getState().setChainOption(initialOption)

    render(
      <Interactive
        workerFactory={() =>
          ({
            postMessage() {},
            terminate() {},
            addEventListener() {},
            removeEventListener() {},
          }) as unknown as Worker
        }
      />,
    )

    // switch chains mid-session
    useChainStore.getState().setChainOption('pulsechainV4')

    await waitFor(() => {
      const textareas = screen.getAllByRole('textbox')
      const adopted = textareas.some((t) => (t as HTMLTextAreaElement).value === 'persisted-on-v4')
      expect(adopted).toBe(true)
    })
  })
})

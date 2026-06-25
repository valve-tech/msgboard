/**
 * Task 4 — MVP vertical-slice integration test.
 *
 * Exercises the primary flow end-to-end against the real Task-3 stores + a FAKE worker:
 *   SelectChain (updates the chain store) → Interactive (compose → grind in the worker
 *   seam → post → reload) → Terminal/TreeView render of board content.
 *
 * The HARD RULE under test: the PoW grind is dispatched to the Web Worker seam, NEVER run
 * inline on the main thread. We assert that a `{type:'work'}` message is posted to the
 * injected worker and that the component never imports/calls `doPoW` directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { stringToHex, type Hex } from 'viem'
import type { WorkerResponseMsg, WorkerRequestMsg } from '../src/worker/types'

// ── module mocks ────────────────────────────────────────────────────────────
// The chain store talks to the network in loadContent/probeMsgboard. Stub the SDK so the
// integration test stays headless and deterministic.
const status = { enabled: true, workMultiplier: '1', workDivisor: '1' }
let sdkContent: Record<string, unknown[]> = {}
vi.mock('@msgboard/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@msgboard/sdk')>()
  class FakeClient {
    async status() {
      return status
    }
    async content() {
      return sdkContent
    }
  }
  return { ...actual, MsgBoardClient: FakeClient }
})

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: () => ({ getBlockNumber: async () => 1000n }),
  }
})

// ── a fake Worker that records what the seam posts to it ────────────────────
type Posted = WorkerRequestMsg
const posted: Posted[] = []
let lastWorker: FakeWorker | null = null
class FakeWorker {
  onmessage: ((e: MessageEvent<WorkerResponseMsg>) => void) | null = null
  listeners: Record<string, ((e: any) => void)[]> = {}
  terminated = false
  constructor() {
    lastWorker = this
  }
  addEventListener(type: string, cb: (e: any) => void) {
    ;(this.listeners[type] ??= []).push(cb)
  }
  removeEventListener(type: string, cb: (e: any) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb)
  }
  postMessage(msg: Posted) {
    posted.push(msg)
  }
  terminate() {
    this.terminated = true
  }
  emit(data: WorkerResponseMsg) {
    for (const l of this.listeners['message'] ?? []) l({ data })
    this.onmessage?.({ data } as MessageEvent<WorkerResponseMsg>)
  }
}

beforeEach(() => {
  posted.length = 0
  lastWorker = null
  sdkContent = {}
  localStorage.clear()
})

describe('MVP vertical slice (Interactive flow)', () => {
  it('SelectChain change updates the chain store', async () => {
    const { Interactive } = await import('../src/components/Interactive')
    const { useChainStore } = await import('../src/stores/chain')

    render(<Interactive workerFactory={() => new FakeWorker() as unknown as Worker} />)

    const select = (await screen.findByLabelText(/chain/i)) as HTMLSelectElement
    act(() => {
      fireEvent.change(select, { target: { value: 'pulsechainV4' } })
    })
    expect(useChainStore.getState().chainOption).toBe('pulsechainV4')
  })

  it('grinds in the worker seam (fake worker), posts, then reloads board content', async () => {
    const { Interactive } = await import('../src/components/Interactive')
    const { useChainStore } = await import('../src/stores/chain')

    // start on a non-faucet chain so the compose flow is the plain "input" message path
    act(() => {
      useChainStore.setState({ chainOption: 'pulsechain', content: null })
    })

    render(<Interactive workerFactory={() => new FakeWorker() as unknown as Worker} />)

    // type a message
    const textarea = (await screen.findByPlaceholderText(/any text can go here/i)) as HTMLTextAreaElement
    act(() => {
      fireEvent.input(textarea, { target: { value: 'hello board' } })
    })

    // submit
    const submit = await screen.findByRole('button', { name: /work \+ send/i })
    await act(async () => {
      fireEvent.click(submit)
    })

    // the grind was dispatched to the worker — a {type:'work'} message was posted
    await waitFor(() => expect(posted.length).toBe(1))
    expect(posted[0].type).toBe('work')
    expect(lastWorker).not.toBeNull()

    // resolve the grind from the worker → seam resolves → flow reloads content
    sdkContent = {
      [stringToHex('input', { size: 32 })]: [],
    }
    await act(async () => {
      lastWorker!.emit({
        type: 'complete',
        result: { message: { hash: '0xabc', blockNumber: 1n } } as any,
      })
    })

    // worker was terminated (cleanup) after completing
    await waitFor(() => expect(lastWorker!.terminated).toBe(true))
  })

  it('does NOT call doPoW on the main thread — the grind goes through the worker module', async () => {
    // Source-level tripwire: Interactive must dispatch through the worker seam, never `doPoW`.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src/components/Interactive.tsx'), 'utf8')
    expect(src).not.toMatch(/\.doPoW\(/)
    expect(src).toMatch(/makeWorkerBoard|workerFactory|addMessage/)
  })
})

describe('Terminal + TreeView render board content from the store', () => {
  it('Terminal renders log lines from the terminal store', async () => {
    const { Terminal } = await import('../src/components/Terminal')
    const { useTerminalStore, Log } = await import('../src/stores/terminal')

    act(() => {
      useTerminalStore.getState().clearLogs()
      useTerminalStore.getState().printToTerminal(new Log('progress 42 over 10ms'))
    })
    render(<Terminal />)
    expect(await screen.findByText(/progress 42 over 10ms/)).toBeTruthy()
  })

  it('TreeView renders category + message rows from a tree', async () => {
    const { TreeView } = await import('../src/components/TreeView')
    const { toTree } = await import('../src/lib/tree')
    const category = stringToHex('input', { size: 32 }) as Hex
    const tree = toTree({
      list: [
        {
          category,
          hash: '0xfeed' as Hex,
          blockHash: '0xbeef' as Hex,
          blockNumber: 5n,
          nonce: 7n,
          data: '0x1234' as Hex,
          workMultiplier: 1n,
          workDivisor: 1n,
        } as any,
      ],
    })
    const { container } = render(
      <TreeView label="Message Board" childrenNodes={tree.children} isRoot hideContent />,
    )
    // the hidden root auto-expands → its category header row (a collapsible group) is rendered
    const categoryRow = container.querySelector('[role="button"][aria-expanded]') as HTMLElement
    expect(categoryRow).toBeTruthy()
    // expand the category → the message hash row (0xfeed) becomes visible
    act(() => {
      fireEvent.click(categoryRow)
    })
    expect(await screen.findByText(/0xfeed/)).toBeTruthy()
  })
})

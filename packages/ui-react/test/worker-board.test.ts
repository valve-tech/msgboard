import { describe, it, expect, vi } from 'vitest'
import type { Hex } from 'viem'
import { makeWorkerBoard } from '../src/seams/worker-board'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../src/worker/types'

const CATEGORY = ('0x' + '33'.repeat(32)) as Hex
const DATA = '0xdeadbeef' as Hex

/**
 * A stub `Worker` that immediately replies with the scripted response when the main
 * thread posts a `work` request. Lets us exercise the seam's message protocol headlessly
 * — the real grind is covered by the Playwright e2e (Task 6).
 */
class FakeWorker {
  postedMessages: WorkerRequestMsg[] = []
  private listeners = new Map<string, Set<(e: unknown) => void>>()
  terminated = false
  constructor(private reply: WorkerResponseMsg | WorkerResponseMsg[]) {}

  postMessage(msg: WorkerRequestMsg) {
    this.postedMessages.push(msg)
    const replies = Array.isArray(this.reply) ? this.reply : [this.reply]
    queueMicrotask(() => {
      for (const r of replies) this.emit('message', { data: r })
    })
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn)
  }
  terminate() {
    this.terminated = true
  }
  private emit(type: string, e: unknown) {
    this.listeners.get(type)?.forEach((fn) => fn(e))
  }
}

const baseOpts = {
  rpc: 'https://rpc.example/943',
  chainId: 943,
  workMultiplier: 10_000,
  workDivisor: 1_000_000,
}

describe('makeWorkerBoard', () => {
  it('posts a {type:"work"} request to the worker and resolves addMessage on complete', async () => {
    let fake!: FakeWorker
    const complete: WorkerResponseMsg = {
      type: 'complete',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result: { message: { category: CATEGORY, data: DATA } as any, stats: { isValid: true } as any },
    }
    const board = makeWorkerBoard({
      ...baseOpts,
      workerFactory: () => {
        fake = new FakeWorker(complete)
        return fake as unknown as Worker
      },
    })

    const result = await board.addMessage({ category: CATEGORY, data: DATA })

    expect(fake.postedMessages).toHaveLength(1)
    const req = fake.postedMessages[0]
    expect(req.type).toBe('work')
    if (req.type === 'work') {
      expect(req.category).toBe(CATEGORY)
      expect(req.data).toBe(DATA)
      expect(req.chainId).toBe(943)
      expect(req.workMultiplier).toBe('10000')
    }
    expect(result).toBeDefined()
    expect(fake.terminated).toBe(true)
  })

  it('forwards progress messages to the onProgress callback', async () => {
    const onProgress = vi.fn()
    const replies: WorkerResponseMsg[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'progress', stats: { iterations: 42n } as any },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'complete', result: { message: {} as any, stats: { isValid: true } as any } },
    ]
    const board = makeWorkerBoard({
      ...baseOpts,
      onProgress,
      workerFactory: () => new FakeWorker(replies) as unknown as Worker,
    })
    await board.addMessage({ category: CATEGORY, data: DATA })
    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  it('rejects addMessage with a pow error when the worker errors', async () => {
    const board = makeWorkerBoard({
      ...baseOpts,
      workerFactory: () =>
        new FakeWorker({ type: 'error', message: 'grind failed' }) as unknown as Worker,
    })
    await expect(board.addMessage({ category: CATEGORY, data: DATA })).rejects.toMatchObject({
      kind: 'pow',
      message: 'grind failed',
    })
  })
})

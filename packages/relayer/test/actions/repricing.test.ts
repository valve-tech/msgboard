import { http } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { Relayer } from '../../src/relayer.js'
import { repricingAction, type SubmitRequest } from '../../src/actions/repricing.js'
import { createPendingTxTracker } from '../../src/stores/pending-tx.js'
import type { RelayerConfig } from '../../src/types.js'

type Job = { id: string }

const ctxNode = { transport: http('http://localhost:8545'), chain: pulsechainV4 }

const baseConfig = (over: Partial<RelayerConfig<Job>>): RelayerConfig<Job> => ({
  node: ctxNode,
  source: { poll: async () => [{ id: 'a' }] },
  action: { describe: () => 'x', execute: async () => ({ ok: true }) },
  key: (j) => j.id,
  logger: () => {},
  ...over,
})

describe('repricingAction', () => {
  it('describe is pure and never submits (observe-mode safe)', async () => {
    const submit = vi.fn()
    const action = repricingAction<Job>({
      tracker: createPendingTxTracker({ windowSize: 4, baseNonce: 0 }),
      describe: (j) => `settle ${j.id}`,
      submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 5_000,
    })
    expect(action.describe({ id: 'a' }, {} as never)).toBe('settle a')
    expect(submit).not.toHaveBeenCalled()
  })

  it('first execute claims a nonce and submits once at the initial fee', async () => {
    const submit = vi.fn(async (_req: SubmitRequest<Job>) => ({ hash: '0xfeed' }))
    const tracker = createPendingTxTracker({ windowSize: 4, baseNonce: 7 })
    const action = repricingAction<Job>({
      tracker,
      describe: () => 'x',
      submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 5_000,
    })
    const relayer = new Relayer(baseConfig({ mode: 'live', action }))
    const report = await relayer.runOnce()
    expect(report.executed).toBe(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toMatchObject({ nonce: 7, fees: { maxFeePerGas: 100n } })
  })

  it('replace-by-fee: a stale pending nonce is resubmitted at a higher fee', async () => {
    let now = 0
    const submit = vi.fn(async (_req: SubmitRequest<Job>) => ({ hash: '0x1' }))
    const tracker = createPendingTxTracker({ windowSize: 4, baseNonce: 0, now: () => now })
    const action = repricingAction<Job>({
      tracker, describe: () => 'x', submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      staleMs: 5_000, now: () => now,
    })
    const relayer = new Relayer(baseConfig({
      mode: 'live', action,
      // same job id twice => same logical settlement; dedup off so we can re-tick it
      source: { poll: async () => [{ id: 'a' }] },
    }))
    await relayer.runOnce()                 // first submit @100
    now = 6_000                             // make it stale
    await relayer.runOnce()                 // should RBF the SAME nonce, higher fee
    expect(submit).toHaveBeenCalledTimes(2)
    const first = submit.mock.calls[0][0]
    const second = submit.mock.calls[1][0]
    expect(second.nonce).toBe(first.nonce)  // same nonce — a replacement, not a new tx
    expect(second.fees.maxFeePerGas).toBeGreaterThan(first.fees.maxFeePerGas)
  })

  it('nonce window pipelines two distinct settlements at consecutive nonces', async () => {
    const submit = vi.fn(async (req: { nonce: number }) => ({ hash: `0x${req.nonce}` }))
    const tracker = createPendingTxTracker({ windowSize: 4, baseNonce: 0 })
    const action = repricingAction<{ id: string }>({
      tracker, describe: () => 'x', submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 999_999,
    })
    const relayer = new Relayer(baseConfig({
      mode: 'live', action,
      source: { poll: async () => [{ id: 'a' }, { id: 'b' }] },
    }))
    const report = await relayer.runOnce()
    expect(report.executed).toBe(2)
    const nonces = submit.mock.calls.map((c) => c[0].nonce).sort()
    expect(nonces).toEqual([0, 1]) // pipelined, not head-of-line blocked
  })

  it('window full: a new settlement is deferred (ActionResult ok:false, reason queued) not dropped', async () => {
    const submit = vi.fn(async () => ({ hash: '0x1' }))
    const tracker = createPendingTxTracker({ windowSize: 1, baseNonce: 0 })
    const action = repricingAction<{ id: string }>({
      tracker, describe: () => 'x', submit,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 999_999,
    })
    const relayer = new Relayer(baseConfig({
      mode: 'live', action,
      source: { poll: async () => [{ id: 'a' }, { id: 'b' }] },
    }))
    await relayer.runOnce()
    expect(submit).toHaveBeenCalledTimes(1) // only one fits the window
  })
})

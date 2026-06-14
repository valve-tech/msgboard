import { describe, expect, it } from 'vitest'
import { createPendingTxTracker } from '../../src/stores/pending-tx.js'

describe('PendingTxTracker', () => {
  it('claims sequential nonces within a bounded window and refuses past it', () => {
    const t = createPendingTxTracker({ windowSize: 2, baseNonce: 10 })
    expect(t.claim()).toBe(10)
    expect(t.claim()).toBe(11)
    // window full (2 in flight): no nonce until one frees
    expect(t.claim()).toBeUndefined()
  })

  it('frees a nonce when its tx mines, opening the window', () => {
    const t = createPendingTxTracker({ windowSize: 1, baseNonce: 0 })
    const n = t.claim()!
    expect(n).toBe(0)
    expect(t.claim()).toBeUndefined()
    t.markMined(n)
    expect(t.claim()).toBe(1) // window advanced
  })

  it('records the submitted hash + fee + time and reports staleness past the threshold', () => {
    let now = 1_000
    const t = createPendingTxTracker({ windowSize: 4, baseNonce: 0, now: () => now })
    const n = t.claim()!
    t.recordSubmission(n, { hash: '0xaaa', maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
    expect(t.isStale(n, 5_000)).toBe(false) // 0ms elapsed
    now = 1_000 + 6_000
    expect(t.isStale(n, 5_000)).toBe(true) // 6s elapsed > 5s threshold
  })

  it('computes a replace-by-fee bump that clears the +12.5% RBF floor', () => {
    const t = createPendingTxTracker({ windowSize: 4, baseNonce: 0 })
    const n = t.claim()!
    t.recordSubmission(n, { hash: '0xaaa', maxFeePerGas: 100n, maxPriorityFeePerGas: 10n })
    const bumped = t.bumpFees(n)
    // strictly greater than +12.5% on BOTH fields (viem/geth reject < 10%; we use 12.5% for margin)
    expect(bumped.maxFeePerGas).toBeGreaterThanOrEqual(113n) // ceil(100 * 1.125)
    expect(bumped.maxPriorityFeePerGas).toBeGreaterThanOrEqual(12n) // ceil(10 * 1.125)
  })

  it('keeps independent per-nonce fee state (parallel pipelined txs do not collide)', () => {
    const t = createPendingTxTracker({ windowSize: 4, baseNonce: 0 })
    const a = t.claim()!
    const b = t.claim()!
    t.recordSubmission(a, { hash: '0xa', maxFeePerGas: 100n, maxPriorityFeePerGas: 5n })
    t.recordSubmission(b, { hash: '0xb', maxFeePerGas: 200n, maxPriorityFeePerGas: 9n })
    expect(t.bumpFees(a).maxFeePerGas).toBeLessThan(t.bumpFees(b).maxFeePerGas)
  })
})

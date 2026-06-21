import { describe, expect, it } from 'vitest'
import { type Hex } from 'viem'
import {
  categoryHash,
  checkWork,
  createChallengeSearch,
  difficulty,
  encodeData,
  getChallenge,
} from '../src/index.js'
import type { MessageSeed } from '../src/types.js'

const factors = { workMultiplier: 10_000n, workDivisor: 1_000_000n }

// Hoist the constant parts of the message — categoryHash() and encodeData() are pure
// and recomputing them per nonce makes the (already EC-heavy) suite needlessly slow.
const CATEGORY = categoryHash('lorem')
const DATA = encodeData('the quick brown fox jumps over the lazy dog')
const BLOCK_A = `0x${'ab'.repeat(32)}` as Hex
const BLOCK_B = `0x${'22'.repeat(32)}` as Hex

const seed = (over: Partial<MessageSeed> = {}): MessageSeed => ({
  version: 1,
  blockHash: BLOCK_A,
  category: CATEGORY,
  data: DATA,
  nonce: 0n,
  ...factors,
  ...over,
})

describe('checkWork / getChallenge (characterization)', () => {
  // Pin the canonical verifier's behaviour BEFORE optimizing the search around it,
  // so a future refactor that accidentally changes the work function is caught.
  it('getChallenge is deterministic for a fixed message + nonce', () => {
    const a = getChallenge(seed({ nonce: 42n }))
    const b = getChallenge(seed({ nonce: 42n }))
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'))
    expect(a.length).toBeGreaterThan(0)
  })

  it('checkWork accepts a hash iff (hash % difficulty == 0) and is reproducible', () => {
    const msg = seed({ nonce: 7n })
    const diff = 256n
    const first = checkWork(msg, diff)
    expect(checkWork(msg, diff)).toBe(first)
    if (first) expect(BigInt(first) % diff).toBe(0n)
  })
})

describe('createChallengeSearch', () => {
  // The search advances the challenge point by a constant (point addition) instead of
  // a full scalar multiply per nonce. It MUST stay bit-identical to the canonical
  // checkWork verifier, or the node rejects the work ("invalid work").
  // Generous timeout: the canonical checkWork() does a full scalar multiply per nonce
  // (~hundreds of µs), so 1000 reference calls is several seconds on a slow runner —
  // well past vitest's 5s default. The work is CPU-bound and real, not a hang.
  it(
    'matches checkWork for every nonce over a fixed-block run',
    () => {
      const diff = 64n // small modulus so ~1/64 nonces are valid — exercises hit + miss
      const search = createChallengeSearch(seed())
      let hits = 0
      for (let n = 1n; n <= 1000n; n++) {
        const stepped = search.next(diff)
        const expected = checkWork(seed({ nonce: n }), diff) // canonical, full scalar multiply
        expect(stepped).toBe(expected)
        if (stepped) hits += 1
      }
      // With difficulty 64 over 1000 nonces we expect ~15 valid hits, not zero — a zero
      // would mean both sides are trivially null and the equality proves nothing.
      expect(hits).toBeGreaterThan(0)
    },
    30_000,
  )

  it('mutates message.nonce in lockstep with the search', () => {
    const message = seed()
    const search = createChallengeSearch(message)
    search.next(1n)
    expect(message.nonce).toBe(1n)
    search.next(1n)
    expect(message.nonce).toBe(2n)
  })

  it(
    'rebases and stays correct when message.blockHash changes mid-search',
    () => {
      const diff = 64n
      const message = seed({ blockHash: BLOCK_A })
      const search = createChallengeSearch(message)

      for (let n = 1n; n <= 250n; n++) {
        expect(search.next(diff)).toBe(checkWork(seed({ blockHash: BLOCK_A, nonce: n }), diff))
      }
      // a new block arrives mid-grind (as the grind block poller would do)
      message.blockHash = BLOCK_B
      const resumeFrom = message.nonce
      for (let n = resumeFrom + 1n; n <= resumeFrom + 250n; n++) {
        expect(search.next(diff)).toBe(checkWork(seed({ blockHash: BLOCK_B, nonce: n }), diff))
      }
    },
    30_000,
  )

  it('reports valid work that the canonical checkWork independently verifies', () => {
    const diff = 64n
    const message = seed()
    const search = createChallengeSearch(message)
    let found: Hex | null = null
    for (let i = 0; i < 20_000 && !found; i++) found = search.next(diff)
    expect(found).not.toBeNull()
    // the message now carries the winning nonce — verify it the canonical way
    expect(checkWork(message, diff)).toBe(found)
    expect(BigInt(found as Hex) % diff).toBe(0n)
  })

  it('keeps the difficulty modulus wiring intact', () => {
    const dataLen = DATA.length / 2 - 1
    expect(difficulty(factors, dataLen)).toBeGreaterThan(0n)
  })
})

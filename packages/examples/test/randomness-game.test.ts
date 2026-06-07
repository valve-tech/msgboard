import { describe, it, expect } from 'vitest'
import type { Hex } from 'viem'
import { commitOf, deriveSeed, verifyReveal, rollFromSeed, settleBets } from '../src/randomness-game.js'

const SECRET_A = `0x${'a1'.repeat(32)}` as Hex
const SECRET_B = `0x${'b2'.repeat(32)}` as Hex
const SECRET_C = `0x${'c3'.repeat(32)}` as Hex

describe('commitOf / verifyReveal', () => {
  // The commitment binds a provider to a secret; revealing anything else must be caught,
  // which is the whole basis of the anti-bias guarantee.
  it('accepts a revealed secret that matches its committed preimage', () => {
    expect(verifyReveal(SECRET_A, commitOf(SECRET_A))).toBe(true)
  })

  it('rejects a revealed secret that does not match the preimage (SecretMismatch)', () => {
    expect(verifyReveal(SECRET_B, commitOf(SECRET_A))).toBe(false)
  })
})

describe('deriveSeed', () => {
  // Reproduces the contract's seed so a consumer can verify the on-chain value. It must
  // depend on every secret (so no single revealer controls it) and on their order.
  it('is deterministic for the same secrets in the same order', () => {
    expect(deriveSeed([SECRET_A, SECRET_B, SECRET_C])).toBe(deriveSeed([SECRET_A, SECRET_B, SECRET_C]))
  })

  it('changes if any secret changes', () => {
    expect(deriveSeed([SECRET_A, SECRET_B])).not.toBe(deriveSeed([SECRET_A, SECRET_C]))
  })

  it('changes if the secret order changes (every contributor matters)', () => {
    expect(deriveSeed([SECRET_A, SECRET_B])).not.toBe(deriveSeed([SECRET_B, SECRET_A]))
  })
})

describe('rollFromSeed', () => {
  // A provably-fair draw must be deterministic from the seed and always land in range.
  it('is deterministic for a given seed', () => {
    const seed = deriveSeed([SECRET_A, SECRET_B, SECRET_C])
    expect(rollFromSeed(seed, 6)).toBe(rollFromSeed(seed, 6))
  })

  it('always lands within [1, sides]', () => {
    // Sweep many distinct seeds; none may fall outside the die's faces.
    for (let i = 0; i < 50; i++) {
      const seed = deriveSeed([`0x${i.toString(16).padStart(64, '0')}` as Hex])
      const roll = rollFromSeed(seed, 6)
      expect(roll).toBeGreaterThanOrEqual(1)
      expect(roll).toBeLessThanOrEqual(6)
    }
  })
})

describe('settleBets', () => {
  it('pays exactly the players whose guess equals the roll', () => {
    const seed = deriveSeed([SECRET_A, SECRET_B, SECRET_C])
    const roll = rollFromSeed(seed, 6)
    const loser = roll === 1 ? 2 : 1
    const result = settleBets(seed, [{ player: 'alice', guess: roll }, { player: 'bob', guess: loser }], 6)
    expect(result.roll).toBe(roll)
    expect(result.winners).toEqual(['alice'])
  })

  it('returns no winners when nobody guessed the roll', () => {
    const seed = deriveSeed([SECRET_A])
    const roll = rollFromSeed(seed, 6)
    const wrong = (roll % 6) + 1 // guaranteed different from roll
    const result = settleBets(seed, [{ player: 'alice', guess: wrong }], 6)
    expect(result.winners).toEqual([])
  })
})

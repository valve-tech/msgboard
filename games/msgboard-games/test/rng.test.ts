import { describe, it, expect } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { buildSeedChain, verifyReveal, roundRandom, commitSeed } from '../src/rng'

describe('server-seed hash chain', () => {
  const tip = `0x${'77'.repeat(32)}` as Hex

  it('head is keccak applied length times to the tip', () => {
    const chain = buildSeedChain(tip, 4)
    expect(chain.commit).toBe(chain.seeds[0])
    // seeds[i-1] == keccak256(seeds[i])
    for (let i = 1; i < chain.seeds.length; i++) {
      expect(keccak256(chain.seeds[i]!)).toBe(chain.seeds[i - 1]!)
    }
  })

  it('a correct reveal verifies against the prior link; a wrong one fails', () => {
    const chain = buildSeedChain(tip, 4)
    // round 1 reveals seeds[1], verified against commit (seeds[0])
    expect(verifyReveal(chain.commit, chain.seeds[1]!)).toBe(true)
    expect(verifyReveal(chain.seeds[1]!, chain.seeds[2]!)).toBe(true)
    expect(verifyReveal(chain.commit, chain.seeds[2]!)).toBe(false) // skips a link
    expect(verifyReveal(chain.commit, `0x${'00'.repeat(32)}`)).toBe(false)
  })

  it('commitSeed binds a seed for reveal: verifyReveal(commit, seed) round-trips, wrong seed fails', () => {
    const seed = `0x${'33'.repeat(32)}` as Hex
    const commit = commitSeed(seed)
    expect(commit).toBe(keccak256(seed))
    expect(verifyReveal(commit, seed)).toBe(true) // the house checks a revealed clientSeed this way
    expect(verifyReveal(commit, `0x${'34'.repeat(32)}`)).toBe(false) // a substituted seed is rejected
  })

  it('roundRandom is deterministic and changes with each input', () => {
    const s = `0x${'12'.repeat(32)}` as Hex
    const c = `0x${'34'.repeat(32)}` as Hex
    const a = roundRandom(s, c, 0n)
    expect(roundRandom(s, c, 0n)).toBe(a)
    expect(roundRandom(s, c, 1n)).not.toBe(a)
    expect(roundRandom(s, `0x${'35'.repeat(32)}`, 0n)).not.toBe(a)
    expect(roundRandom(`0x${'13'.repeat(32)}`, c, 0n)).not.toBe(a)
  })
})

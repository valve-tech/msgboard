import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { makeSecret, seedFromSecrets, coinFlipOutcome, raffleDraw } from '../src/secrets'

describe('secrets', () => {
  it('derives a deterministic secret and its preimage', () => {
    const a = makeSecret('label', '0xdead')
    const b = makeSecret('label', '0xdead')
    expect(a.secret).to.equal(b.secret)
    expect(a.preimage).to.equal(viem.keccak256(a.secret))
  })

  it('reproduces the contract seed as keccak256(concat(secrets))', () => {
    const secrets = [viem.keccak256(viem.toHex('s0')), viem.keccak256(viem.toHex('s1'))]
    expect(seedFromSecrets(secrets)).to.equal(viem.keccak256(viem.concatHex(secrets)))
  })

  it('matches the on-chain coin-flip parity rule', () => {
    const evenSeed = viem.padHex('0x02', { size: 32 })
    const oddSeed = viem.padHex('0x03', { size: 32 })
    expect(coinFlipOutcome(evenSeed)).to.equal('heads')
    expect(coinFlipOutcome(oddSeed)).to.equal('tails')
  })

  it('matches the on-chain raffle draw reduction (1 + seed mod 256, in [1..256])', () => {
    // seed mod 256 == 0 -> draw 1; == 255 -> draw 256
    const seedMod0 = viem.padHex('0x0100', { size: 32 }) // 256 -> mod 256 == 0
    const seedMod255 = viem.padHex('0xff', { size: 32 }) // 255 -> mod 256 == 255
    expect(raffleDraw(seedMod0)).to.equal(1n)
    expect(raffleDraw(seedMod255)).to.equal(256n)
  })

  it('holds both reductions over a sweep of derived seeds (property check)', () => {
    // 256 deterministic but well-mixed seeds via keccak — every draw must land in [1..256]
    // and both reductions must equal the raw arithmetic the contracts use.
    for (let i = 0; i < 256; i++) {
      const seed = viem.keccak256(viem.toHex(`property-seed-${i}`))
      const value = BigInt(seed)
      expect(coinFlipOutcome(seed)).to.equal(value % 2n === 0n ? 'heads' : 'tails')
      const draw = raffleDraw(seed)
      expect(draw).to.equal(1n + (value % 256n))
      expect(draw >= 1n && draw <= 256n).to.equal(true)
    }
  })

  it('seed order matters: permuting the secrets changes the seed', () => {
    const s0 = viem.keccak256(viem.toHex('order-a'))
    const s1 = viem.keccak256(viem.toHex('order-b'))
    expect(seedFromSecrets([s0, s1])).to.not.equal(seedFromSecrets([s1, s0]))
  })
})

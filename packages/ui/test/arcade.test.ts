import { describe, expect, it } from 'vitest'
import { concat, keccak256, type Hex } from 'viem'
import { flipOutcome, randomSeed, encodeFlip, decodeFlip } from '../src/lib/coinflip'

const BLOCK = '0x0102030405060708091011121314151617181920212223242526272829303132' as Hex
const SEED = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex

describe('flipOutcome', () => {
  it('is deterministic — same inputs give the same side', () => {
    const a = flipOutcome(BLOCK, SEED)
    const b = flipOutcome(BLOCK, SEED)
    expect(a).toEqual(b)
  })

  it('picks the face from the parity of keccak256(blockHash ‖ clientSeed)', () => {
    const digest = keccak256(concat([BLOCK, SEED]))
    const expected = (BigInt(digest) & 1n) === 0n ? 'heads' : 'tails'
    const out = flipOutcome(BLOCK, SEED)
    expect(out.digest).toBe(digest)
    expect(out.side).toBe(expected)
  })

  it('flips the side when the low bit of the digest flips', () => {
    // craft two seeds that land on opposite parities so both branches are covered
    let heads: Hex | null = null
    let tails: Hex | null = null
    for (let i = 0; heads === null || tails === null; i++) {
      const seed = ('0x' + i.toString(16).padStart(64, '0')) as Hex
      const { side } = flipOutcome(BLOCK, seed)
      if (side === 'heads') heads ??= seed
      else tails ??= seed
      if (i > 1000) break
    }
    expect(heads).not.toBeNull()
    expect(tails).not.toBeNull()
    expect(flipOutcome(BLOCK, heads!).side).toBe('heads')
    expect(flipOutcome(BLOCK, tails!).side).toBe('tails')
  })
})

describe('randomSeed', () => {
  it('produces a 32-byte hex that differs each call', () => {
    const a = randomSeed()
    const b = randomSeed()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('encodeFlip / decodeFlip', () => {
  it('round-trips a flip record', () => {
    const record = { pick: 'heads', side: 'tails', win: false, seed: SEED, block: 12345 } as const
    const decoded = decodeFlip(encodeFlip(record))
    expect(decoded).toEqual(record)
  })

  it('rejects non-flip data', () => {
    expect(decodeFlip('0x1234' as Hex)).toBeNull()
    expect(decodeFlip(encodeFlip as unknown as Hex)).toBeNull()
  })
})

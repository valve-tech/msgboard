import { describe, it, expect } from 'vitest'
import { keccak256, toHex, bytesToHex, type Hex } from 'viem'
import { getChallenge, checkWork, difficulty } from './utils.js'
import type { MessageSeed } from './types.js'

/**
 * Regression guard for the challenge x-coordinate encoding.
 *
 * The PoW challenge is the secp256k1 x-coordinate, which the node + the Rust grinder always encode
 * as a FIXED 32-byte big-endian value (pow-grinder x_of → [u8; 32]; reth pow.rs). bn.js `toArray()`
 * with no length returns the MINIMAL representation and drops leading zero bytes — so when x is below
 * 2^248 (about one nonce in 256) it would encode to 31 bytes and the node would reject the message.
 *
 * These tests would pass ~255 times in 256 against the buggy encoding, so they DELIBERATELY cross the
 * boundary: a length invariant over hundreds of nonces, and a PINNED nonce whose x has a leading zero.
 */

// A fixed vector. workDivisor = 2^24 + dataLen*10000 with workMultiplier=1 makes difficulty exactly 1
// (every nonce is a "winner"), which the sibling sdk test reuses to pin the Rust grinder to this nonce.
const CATEGORY = keccak256(toHex('pow-encoding-test'))
const DATA = '0x00' as Hex // 1 byte
const DATA_LEN = 1
const BLOCK_HASH = keccak256(toHex('pow-encoding-block'))
const FACTORS = { workMultiplier: 1n, workDivisor: BigInt(2 ** 24 + DATA_LEN * 10000) }
const BOUNDARY_NONCE = 587n // found by scanning: the first nonce whose challenge x < 2^248

const seedAt = (nonce: bigint): MessageSeed => ({
  version: 1,
  blockHash: BLOCK_HASH,
  category: CATEGORY,
  data: DATA,
  nonce,
  ...FACTORS,
})

describe('getChallenge encoding', () => {
  it('always returns exactly 32 bytes across hundreds of nonces', () => {
    const bad: string[] = []
    const boundary = 2n ** 248n
    let boundaryCases = 0
    for (let nonce = 1n; nonce <= 1000n; nonce++) {
      const x = getChallenge(seedAt(nonce))
      if (x.length !== 32) bad.push(`nonce ${nonce} → ${x.length} bytes`)
      // Detect the boundary by the NUMERIC x value, so it holds whether or not the encoding
      // (buggily) dropped a leading zero — this proves the scan really crosses x < 2^248.
      if (BigInt(bytesToHex(x)) < boundary) boundaryCases++
    }
    expect(bad).toEqual([]) // the fix: every x is a full 32 bytes
    expect(boundaryCases).toBeGreaterThan(0) // sanity: the scan reached the boundary
  })

  it('encodes the pinned boundary nonce (x < 2^248) as a full 32 bytes with a leading zero', () => {
    const x = getChallenge(seedAt(BOUNDARY_NONCE))
    expect(x.length).toBe(32) // 31 with the bug
    expect(x[0]).toBe(0) // confirms this vector really is the leading-zero boundary case
  })

  it('checkWork accepts the pinned boundary nonce at difficulty 1', () => {
    // difficulty(FACTORS, 1) === 1, so every hash passes; checkWork returns the work hash.
    expect(difficulty(FACTORS, DATA_LEN)).toBe(1n)
    const hash = checkWork(seedAt(BOUNDARY_NONCE), 1n)
    expect(hash).not.toBeNull()
  })
})

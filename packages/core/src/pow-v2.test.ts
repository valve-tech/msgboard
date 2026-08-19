import { describe, it, expect } from 'vitest'
import { keccak256, toHex, hexToBytes, type Hex } from 'viem'
import {
  payloadHash,
  scalarHash,
  checkWorkV2,
  verifyWork,
  checkWork,
  powTarget,
  difficulty,
  createChallengeSearchV2,
} from './utils.js'
import type { MessageSeed } from './types.js'

/**
 * Revised PoW algorithm (message version >= 2). The spec doc is the authority for the byte layout;
 * these tests assert (1) a pinned regression fixture, (2) the internal grind<->verify round-trip,
 * (3) the acceptance rule (workHash < 2^256/D), and (4) version-gated coexistence with the legacy
 * algorithm.
 *
 * IMPORTANT: the fixture digests below were produced by THIS implementation of the spec, so they are
 * a REGRESSION guard, not an independent correctness proof. Before v2 messages go to a live node,
 * cross-check payloadHash/scalarHash against the node's Go TestPoWGoldenVector and replace these hex
 * values if they differ.
 */

const FIXTURE: MessageSeed = {
  version: 2,
  blockHash: keccak256(toHex('v2-golden-block')),
  category: keccak256(toHex('v2-golden-cat')),
  data: '0x0102030405' as Hex,
  nonce: 42n,
  workMultiplier: 1n,
  workDivisor: 1n,
}

describe('revised PoW (v2) transcript hashing', () => {
  it('matches the pinned regression fixture (cross-check vs the node golden vector before prod)', () => {
    const ph = payloadHash(FIXTURE)
    const sh = scalarHash(FIXTURE, hexToBytes(ph))
    expect(ph).toBe('0xd73f3e001a3e81f1483ac0cdc9c56e2fe4d8b0fff3d8e9c4b385be4941289671')
    expect(sh).toBe('0xb30158e41c77b19c5fa193978fc81310a3690db47085eb2e62bf819fa4311a89')
  })

  it('scalarHash depends on version, nonce, data, and block (fixed-width transcript)', () => {
    const base = scalarHash(FIXTURE, hexToBytes(payloadHash(FIXTURE)))
    const diffVersion = scalarHash({ ...FIXTURE, version: 3 }, hexToBytes(payloadHash(FIXTURE)))
    const diffNonce = scalarHash({ ...FIXTURE, nonce: 43n }, hexToBytes(payloadHash(FIXTURE)))
    const diffData = payloadHash({ ...FIXTURE, data: '0x0102030406' as Hex })
    expect(diffVersion).not.toBe(base)
    expect(diffNonce).not.toBe(base)
    expect(diffData).not.toBe(payloadHash(FIXTURE)) // category+data commit changes the payload hash
  })
})

// D = 1 → target = 2^256 → any in-range scalar passes. wd chosen so difficulty()==1 for this dataLen.
const DATA = '0x0102030405' as Hex
const DATA_LEN = 5
const EASY = { workMultiplier: 1n, workDivisor: BigInt(2 ** 24 + DATA_LEN * 10000) }
const easyMsg = (over: Partial<MessageSeed> = {}): MessageSeed => ({
  version: 2,
  blockHash: keccak256(toHex('v2-rt-block')),
  category: keccak256(toHex('v2-rt-cat')),
  data: DATA,
  nonce: 0n,
  ...EASY,
  ...over,
})

describe('revised PoW (v2) grind <-> verify', () => {
  it('a grinder-found nonce verifies to the same work hash', () => {
    const D = difficulty(EASY, DATA_LEN)
    expect(D).toBe(1n)
    expect(powTarget(D)).toBe(2n ** 256n)
    const msg = easyMsg()
    const search = createChallengeSearchV2(msg)
    let hash: Hex | null = null
    for (let i = 0; i < 20 && !hash; i++) hash = search.next(D)
    expect(hash).not.toBeNull()
    // the nonce the search stopped on re-verifies to the identical hash
    expect(checkWorkV2(msg, D)).toBe(hash)
    expect(verifyWork(msg, D)).toBe(hash)
  })

  it('rejects work above the target (tiny target = huge difficulty)', () => {
    const msg = easyMsg({ nonce: 1n })
    // First confirm nonce 1 passes at D=1.
    expect(verifyWork(msg, 1n)).not.toBeNull()
    // target = 2^256 / 2^255 = 2, so any hash >= 2 is rejected — essentially all of them.
    const hugeD = 2n ** 255n
    expect(() => checkWorkV2(msg, hugeD)).toThrow('invalid work')
    expect(verifyWork(msg, hugeD)).toBeNull()
  })

  it('the compressed-point work hash is 32 bytes', () => {
    const hash = verifyWork(easyMsg({ nonce: 1n }), 1n)
    expect(hash).not.toBeNull()
    expect(hexToBytes(hash!).length).toBe(32)
  })
})

describe('version-gated coexistence', () => {
  it('verifyWork routes v1 to the legacy algorithm and v2 to the revised one', () => {
    // Identical fields, different version → different algorithm → different work hash.
    const common = {
      blockHash: keccak256(toHex('gate-block')),
      category: keccak256(toHex('gate-cat')),
      data: DATA,
      nonce: 7n,
      ...EASY,
    }
    const v1: MessageSeed = { ...common, version: 1 }
    const v2: MessageSeed = { ...common, version: 2 }
    const h1 = verifyWork(v1, 1n)
    const h2 = verifyWork(v2, 1n)
    expect(h1).not.toBeNull()
    expect(h2).not.toBeNull()
    expect(h1).not.toBe(h2)
    // v1 path is exactly the legacy checkWork; v2 path is exactly checkWorkV2.
    expect(h1).toBe(checkWork(v1, 1n))
    expect(h2).toBe(checkWorkV2(v2, 1n))
  })
})

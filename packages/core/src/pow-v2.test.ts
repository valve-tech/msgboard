import { describe, it, expect } from 'vitest'
import { keccak256, toHex, hexToBytes, type Hex } from 'viem'
import {
  payloadHash,
  scalarHash,
  checkWork,
  checkWorkLegacy,
  powTarget,
  difficulty,
  createChallengeSearch,
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
    const search = createChallengeSearch(msg)
    let hash: Hex | null = null
    for (let i = 0; i < 20 && !hash; i++) hash = search.next(D)
    expect(hash).not.toBeNull()
    // the nonce the search stopped on re-verifies to the identical hash
    expect(checkWork(msg, D)).toBe(hash)
  })

  it('rejects work above the target (tiny target = huge difficulty)', () => {
    const msg = easyMsg({ nonce: 1n })
    // First confirm nonce 1 passes at D=1.
    expect(checkWork(msg, 1n)).not.toBeNull()
    // target = 2^256 / 2^255 = 2, so any hash >= 2 is rejected — essentially all of them.
    const hugeD = 2n ** 255n
    expect(checkWork(msg, hugeD)).toBeNull() // checkWork returns null on a miss (does not throw)
  })

  it('the compressed-point work hash is 32 bytes', () => {
    const hash = checkWork(easyMsg({ nonce: 1n }), 1n)
    expect(hash).not.toBeNull()
    expect(hexToBytes(hash!).length).toBe(32)
  })
})

describe('revised vs legacy are distinct algorithms (both message version 1)', () => {
  it('checkWork (revised) and checkWorkLegacy produce different hashes for the same message', () => {
    // Both schemes are message version 1 — the spec makes the revised algorithm version 1, and the
    // legacy scheme is the pre-revision implementation of the same version. They are NOT dispatched by
    // the version field; a deployment selects one. So for one message they must differ.
    const msg: MessageSeed = {
      version: 1,
      blockHash: keccak256(toHex('gate-block')),
      category: keccak256(toHex('gate-cat')),
      data: DATA,
      nonce: 7n,
      ...EASY,
    }
    const revised = checkWork(msg, 1n)
    const legacy = checkWorkLegacy(msg, 1n)
    expect(revised).not.toBeNull()
    expect(legacy).not.toBeNull()
    expect(revised).not.toBe(legacy)
  })
})

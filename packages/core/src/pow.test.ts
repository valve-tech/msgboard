import { describe, it, expect } from 'vitest'
import { keccak256, toHex, hexToBytes, type Hex } from 'viem'
import {
  payloadHash,
  scalarHash,
  checkWork,
  powTarget,
  difficulty,
  createChallengeSearch,
} from './utils.js'
import type { MessageSeed } from './types.js'

/**
 * The msgboard PoW algorithm — message version 1, the one and only scheme (the node rejects the
 * pre-revision scheme). These tests are anchored by the node's Go golden vector: the payloadHash,
 * scalarHash, and workHash below were produced by the NODE, so they prove byte-for-byte consensus
 * with it, not just internal self-consistency. The remaining tests cover the grind<->verify
 * round-trip, the acceptance rule (workHash < 2^256/D), and the transcript's field sensitivity.
 */

// The node's golden vector inputs. category = "chatter" padded to 32 bytes; data = "golden vector".
const CATEGORY = '0x6368617474657200000000000000000000000000000000000000000000000000' as Hex
const BLOCK = '0x3a2ca760216c5cb648c32aab73cbc1cdfdbcf02f77a4cd190995e3c46f3932b5' as Hex
const DATA = '0x676f6c64656e20766563746f72' as Hex // "golden vector", 13 bytes
const DATA_LEN = 13

describe('golden vector (node consensus)', () => {
  // Vector A: this nonce does NOT meet difficulty — that is the point. It pins the transcript hashes
  // and the raw work hash (checked below the target), and confirms it is correctly rejected at its D.
  it('A: nonce 1, M=10000, D=1000000 → D=169072, does NOT pass', () => {
    const msg: MessageSeed = {
      version: 1,
      blockHash: BLOCK,
      category: CATEGORY,
      data: DATA,
      nonce: 1n,
      workMultiplier: 10000n,
      workDivisor: 1000000n,
    }
    const D = difficulty({ workMultiplier: 10000n, workDivisor: 1000000n }, DATA_LEN)
    expect(D).toBe(169072n)

    const ph = payloadHash(msg)
    expect(ph).toBe('0xb66106e111b0e6cd08a49c7a37afa3259541bee8e465bef5e55f6cd7223d789a')
    const sh = scalarHash(msg, hexToBytes(ph))
    expect(sh).toBe('0x3caed3ea9a5caa6e1e069d0126e4dc6698190aa3eec8ebcdab227d3e5b0fd18d')

    // At D=1 the target is 2^256, so checkWork always returns the raw work hash — the compressed-point
    // SHA256. Matching the node's workHash here proves the compressed point matches too (SHA256 is
    // collision-resistant, so equal hashes ⇒ equal 33-byte compressed point 0x035e55…4368b9).
    const raw = checkWork(msg, 1n)
    expect(raw).toBe('0x5ba003ccdb08503a19326a201834198a49e062d2f3f0e9506ff086eddb011dee')

    // At the real difficulty the work hash is above the target, so the nonce is rejected.
    expect(checkWork(msg, D)).toBeNull()
    expect(BigInt(raw!) >= powTarget(D)).toBe(true)
  })

  // Vector B: this nonce DOES meet difficulty, and its two neighbours do not — a tight winning-nonce fix.
  it('B: nonce 57602, M=1, D=1000 → D=16907, passes (57601 and 57603 do not)', () => {
    const factors = { workMultiplier: 1n, workDivisor: 1000n }
    const D = difficulty(factors, DATA_LEN)
    expect(D).toBe(16907n)
    const at = (nonce: bigint): MessageSeed => ({
      version: 1,
      blockHash: BLOCK,
      category: CATEGORY,
      data: DATA,
      nonce,
      ...factors,
    })

    const sh = scalarHash(at(57602n), hexToBytes(payloadHash(at(57602n))))
    expect(sh).toBe('0xbcff3c0ddc5d02b05e282566461d4f30f35ce90b3bfd36cde0c694dcb54a5e7d')

    expect(checkWork(at(57602n), D)).toBe(
      '0x00037212834e250723dc736508d445a0dbc01398040a980807641b4be2d1e361',
    )
    expect(checkWork(at(57601n), D)).toBeNull()
    expect(checkWork(at(57603n), D)).toBeNull()
  })
})

const RT_DATA = '0x0102030405' as Hex
const RT_DATA_LEN = 5
// D = 1 → target = 2^256 → any in-range scalar passes. wd chosen so difficulty()==1 for this dataLen.
const EASY = { workMultiplier: 1n, workDivisor: BigInt(2 ** 24 + RT_DATA_LEN * 10000) }
const easyMsg = (over: Partial<MessageSeed> = {}): MessageSeed => ({
  version: 1,
  blockHash: keccak256(toHex('rt-block')),
  category: keccak256(toHex('rt-cat')),
  data: RT_DATA,
  nonce: 0n,
  ...EASY,
  ...over,
})

describe('transcript field sensitivity', () => {
  it('scalarHash depends on version, nonce, block; payloadHash depends on data', () => {
    const base = scalarHash(easyMsg(), hexToBytes(payloadHash(easyMsg())))
    const diffVersion = scalarHash(easyMsg({ version: 2 }), hexToBytes(payloadHash(easyMsg())))
    const diffNonce = scalarHash(easyMsg({ nonce: 1n }), hexToBytes(payloadHash(easyMsg())))
    const diffBlock = scalarHash(
      easyMsg({ blockHash: keccak256(toHex('other-block')) }),
      hexToBytes(payloadHash(easyMsg())),
    )
    const diffData = payloadHash(easyMsg({ data: '0x0102030406' as Hex }))
    expect(diffVersion).not.toBe(base)
    expect(diffNonce).not.toBe(base)
    expect(diffBlock).not.toBe(base)
    expect(diffData).not.toBe(payloadHash(easyMsg()))
  })
})

describe('grind <-> verify', () => {
  it('a grinder-found nonce verifies to the same work hash', () => {
    const D = difficulty(EASY, RT_DATA_LEN)
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
    expect(checkWork(msg, 1n)).not.toBeNull()
    // target = 2^256 / 2^255 = 2, so any hash >= 2 is rejected — essentially all of them.
    expect(checkWork(msg, 2n ** 255n)).toBeNull()
  })

  it('the compressed-point work hash is 32 bytes', () => {
    const hash = checkWork(easyMsg({ nonce: 1n }), 1n)
    expect(hash).not.toBeNull()
    expect(hexToBytes(hash!).length).toBe(32)
  })
})

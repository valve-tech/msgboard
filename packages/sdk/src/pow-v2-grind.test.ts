import { describe, it, expect } from 'vitest'
import { keccak256, toHex } from 'viem'
import { MsgBoardClient, verifyWork, difficulty, type Provider, type MessageSeed } from './index.js'

/**
 * The SDK PoW path is version-aware. This test drives `doPoW` on a v2 message through the pure-JS
 * grind and asserts the found nonce passes the version-aware verifier `verifyWork`. It needs no
 * live node: a stub provider answers the block poll, and `stamper: null` forces the JS grind
 * (it also turns off v2 engine auto-detection), so the test runs the v2 JS path deterministically.
 */

// Easy difficulty: workMultiplier=1, workDivisor = 2^24 + dataLen*10000 → difficulty()==1, target==2^256,
// so any in-range scalar passes and the grind stops within a few nonces.
const DATA = 'v2' // toHex('v2') = '0x7632' → 2 data bytes
const DATA_LEN = 2
const EASY = { workMultiplier: 1n, workDivisor: BigInt(2 ** 24 + DATA_LEN * 10000) }
const BLOCK_HASH = keccak256(toHex('v2-grind-block'))

/** Stub provider: the only RPC `doPoW` calls is the latest-block poll. */
const stubProvider: Provider = {
  async request<T, U extends unknown[]>(arg: { method: string; params: U }): Promise<T> {
    if (arg.method === 'eth_getBlockByNumber') {
      return { hash: BLOCK_HASH, number: '0x1' } as T
    }
    throw new Error(`unexpected RPC method: ${arg.method}`)
  },
}

describe('doPoW v2 JS grind', () => {
  it('grinds a v2 message and verifyWork accepts the found nonce', async () => {
    const client = new MsgBoardClient(stubProvider, {
      difficultyFactors: EASY,
      stamper: null, // force the JS grind (and disable v2 engine auto-detect)
    })
    client.version = 2

    const { message, stats } = await client.doPoW('v2-grind-cat', DATA)

    // The message really ground as v2 against the difficulty the client computed.
    expect(message.version).toBe(2)
    expect(stats.isValid).toBe(true)
    const D = difficulty(EASY, DATA_LEN)
    expect(D).toBe(1n)

    // The version-aware verifier accepts the found nonce and returns the same work hash.
    const seed: MessageSeed = {
      version: message.version,
      blockHash: message.blockHash,
      category: message.category,
      data: message.data,
      nonce: message.nonce,
      workMultiplier: message.workMultiplier,
      workDivisor: message.workDivisor,
    }
    const verified = verifyWork(seed, D)
    expect(verified).not.toBeNull()
    expect(verified).toBe(message.hash)
  }, 30_000)
})

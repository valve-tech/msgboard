import { describe, it, expect } from 'vitest'
import { keccak256, toHex } from 'viem'
import { MsgBoardClient, checkWork, difficulty, type Provider, type MessageSeed } from './index.js'

/**
 * This test drives `doPoW`'s pure-JS grind and asserts the found nonce passes the verifier `checkWork`.
 * It needs no live node: a stub provider answers the block poll, and `stamper: null` forces the JS
 * grind, so the test runs the PoW path deterministically.
 */

// Easy difficulty: workMultiplier=1, workDivisor = 2^24 + dataLen*10000 → difficulty()==1, target==2^256,
// so any in-range scalar passes and the grind stops within a few nonces.
const DATA = 'gr' // toHex('gr') = '0x6772' → 2 data bytes
const DATA_LEN = 2
const EASY = { workMultiplier: 1n, workDivisor: BigInt(2 ** 24 + DATA_LEN * 10000) }
const BLOCK_HASH = keccak256(toHex('pow-grind-block'))

/** Stub provider: the only RPC `doPoW` calls is the latest-block poll. */
const stubProvider: Provider = {
  async request<T, U extends unknown[]>(arg: { method: string; params: U }): Promise<T> {
    if (arg.method === 'eth_getBlockByNumber') {
      return { hash: BLOCK_HASH, number: '0x1' } as T
    }
    throw new Error(`unexpected RPC method: ${arg.method}`)
  },
}

describe('doPoW JS grind', () => {
  it('grinds a message and checkWork accepts the found nonce', async () => {
    const client = new MsgBoardClient(stubProvider, {
      difficultyFactors: EASY,
      stamper: null, // force the JS grind
    })

    const { message, stats } = await client.doPoW('pow-grind-cat', DATA)

    // The message is version 1 — the one and only message version.
    expect(message.version).toBe(1)
    expect(stats.isValid).toBe(true)
    const D = difficulty(EASY, DATA_LEN)
    expect(D).toBe(1n)

    // The revised verifier accepts the found nonce and returns the same work hash.
    const seed: MessageSeed = {
      version: message.version,
      blockHash: message.blockHash,
      category: message.category,
      data: message.data,
      nonce: message.nonce,
      workMultiplier: message.workMultiplier,
      workDivisor: message.workDivisor,
    }
    const verified = checkWork(seed, D)
    expect(verified).not.toBeNull()
    expect(verified).toBe(message.hash)
  }, 30_000)
})

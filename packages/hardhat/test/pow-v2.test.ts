import { describe, it, expect } from 'vitest'
import { hexToBytes, keccak256, toHex, type Hex } from 'viem'
import * as msgboard from '@msgboard/sdk'

import '../src/type-extensions'

// The provider is loaded from the compiled dist, the same way project.test.ts does it.
// This test needs no live hardhat node — it drives the provider with a mock wrapped
// provider that returns a fixed block for the two block lookups addMessage performs.
const { MsgBoardProvider } = require('../dist/provider') as {
  MsgBoardProvider: new (
    wrapped: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> },
    isHardhatNetwork: boolean,
  ) => {
    setNodeConstraints: (constraints: { workMultiplier: bigint; workDivisor: bigint }) => Promise<void>
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  }
}

// Easy difficulty so the v2 grind finishes fast: divisor >> multiplier.
const workMultiplier = 1n
const workDivisor = 1_000_000n
const blockHash = keccak256(toHex('pow-v2-block')) // a non-zero 32-byte block hash
const block = { number: '0x1', hash: blockHash }

// A wrapped provider that answers the two block lookups addMessage makes.
const mockWrapped = {
  request: async ({ method }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_getBlockByHash') return block
    if (method === 'eth_getBlockByNumber') return block
    throw new Error(`unexpected method: ${method}`)
  },
}

/**
 * Grinds a valid revised (v2) message stamp at the given easy difficulty.
 * Returns the message seed (with a passing nonce) and its work hash.
 */
const grindV2Message = () => {
  const category = keccak256(toHex('pow-v2-category'))
  const data = toHex('pow-v2-data')
  const msg: msgboard.MessageSeed = {
    version: 2,
    blockHash,
    nonce: 0n,
    workMultiplier,
    workDivisor,
    category,
    data,
  }
  const difficulty = msgboard.difficulty({ workMultiplier, workDivisor }, hexToBytes(data).length)
  let hash: Hex | null = null
  // grind the nonce until verifyWork accepts the v2 stamp
  while (!hash) {
    msg.nonce += 1n
    hash = msgboard.verifyWork(msg, difficulty)
  }
  return { msg, hash, difficulty }
}

describe('provider v2 proof-of-work', () => {
  it('verifies a v2 stamp through verifyWork, not the v1 checkWork', () => {
    const { msg, hash, difficulty } = grindV2Message()
    // the version-aware verifier accepts it
    expect(msgboard.verifyWork(msg, difficulty)).toEqual(hash)
    // the legacy v1 verifier does not accept a v2 stamp
    expect(msgboard.checkWork(msg, difficulty)).not.toEqual(hash)
  })

  it('accepts and stores a v2 message', async () => {
    const provider = new MsgBoardProvider(mockWrapped, true)
    await provider.setNodeConstraints({ workMultiplier, workDivisor })

    const { msg, hash } = grindV2Message()
    const rlp = msgboard.toRLP(msg)

    // the provider accepts the v2 message and returns its work hash
    const returned = await provider.request({ method: 'msgboard_addMessage', params: [rlp] })
    expect(returned).toEqual(hash)

    // the stored message is retrievable by that hash
    const stored = (await provider.request({ method: 'msgboard_getMessage', params: [hash] })) as {
      version: Hex
    }
    expect(stored).not.toBeNull()
    expect(BigInt(stored.version)).toEqual(2n)
  })

  it('rejects an unsupported version (0)', async () => {
    const provider = new MsgBoardProvider(mockWrapped, true)
    await provider.setNodeConstraints({ workMultiplier, workDivisor })

    const { msg } = grindV2Message()
    const badRlp = msgboard.toRLP({ ...msg, version: 0 })

    await expect(
      provider.request({ method: 'msgboard_addMessage', params: [badRlp] }),
    ).rejects.toThrow('powmsg: invalid version')
  })
})

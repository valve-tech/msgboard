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
    setNodeConstraints: (constraints: {
      workMultiplier?: bigint
      workDivisor?: bigint
    }) => Promise<void>
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  }
}

// Easy difficulty so the grind finishes fast: divisor >> multiplier.
const workMultiplier = 1n
const workDivisor = 1_000_000n
const blockHash = keccak256(toHex('pow-block')) // a non-zero 32-byte block hash
const block = { number: '0x1', hash: blockHash }

// A wrapped provider that answers the two block lookups addMessage makes.
const mockWrapped = {
  request: async ({ method }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_getBlockByHash') return block
    if (method === 'eth_getBlockByNumber') return block
    throw new Error(`unexpected method: ${method}`)
  },
}

// A stamp is a fresh message seed with a category, data and difficulty; the grind advances the nonce
// until the verifier accepts it. There is one message version — version 1.
const seed = (category: string, data: string): msgboard.MessageSeed => ({
  version: 1,
  blockHash,
  nonce: 0n,
  workMultiplier,
  workDivisor,
  category: keccak256(toHex(category)),
  data: toHex(data),
})

const diffFor = (msg: msgboard.MessageSeed) =>
  msgboard.difficulty({ workMultiplier, workDivisor }, hexToBytes(msg.data).length)

/** Grinds the nonce until `checkWork` accepts the message; returns the seed and its work hash. */
const grind = (msg: msgboard.MessageSeed) => {
  const difficulty = diffFor(msg)
  let hash: Hex | null = null
  while (!hash) {
    msg.nonce += 1n
    hash = msgboard.checkWork(msg, difficulty)
  }
  return { msg, hash, difficulty }
}

describe('provider proof-of-work', () => {
  it('checkWork accepts the stamp it grinds', () => {
    const { msg, hash, difficulty } = grind(seed('pow-category', 'pow-data'))
    expect(msgboard.checkWork(msg, difficulty)).toEqual(hash)
  })

  it('accepts and stores a stamp, retrievable by its work hash as version 1', async () => {
    const provider = new MsgBoardProvider(mockWrapped, true)
    await provider.setNodeConstraints({ workMultiplier, workDivisor })

    const { msg, hash } = grind(seed('pow-category', 'pow-data'))
    const rlp = msgboard.toRLP(msg)

    // the provider accepts the stamp and returns its work hash
    const returned = await provider.request({ method: 'msgboard_addMessage', params: [rlp] })
    expect(returned).toEqual(hash)

    // the stored message is retrievable by that hash and carries version 1
    const stored = (await provider.request({ method: 'msgboard_getMessage', params: [hash] })) as {
      version: Hex
    }
    expect(stored).not.toBeNull()
    expect(BigInt(stored.version)).toEqual(1n)
  })

  it('rejects an unsupported version (0)', async () => {
    const provider = new MsgBoardProvider(mockWrapped, true)
    await provider.setNodeConstraints({ workMultiplier, workDivisor })

    const { msg } = grind(seed('pow-category', 'pow-data'))
    const badRlp = msgboard.toRLP({ ...msg, version: 0 })

    await expect(
      provider.request({ method: 'msgboard_addMessage', params: [badRlp] }),
    ).rejects.toThrow('powmsg: invalid version')
  })
})

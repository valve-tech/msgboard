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
      algorithm?: 'legacy' | 'revised'
    }) => Promise<void>
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  }
}

// Easy difficulty so the grind finishes fast: divisor >> multiplier.
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

// Both schemes are message version 1. A stamp is a fresh message seed with a category, data and
// difficulty; the grind advances the nonce until the chosen verifier accepts it.
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

/** Grinds the nonce until `verify` accepts the message; returns the seed and its work hash. */
const grind = (
  msg: msgboard.MessageSeed,
  verify: (m: msgboard.MessageSeed, difficulty: bigint) => Hex | null,
) => {
  const difficulty = diffFor(msg)
  let hash: Hex | null = null
  while (!hash) {
    msg.nonce += 1n
    hash = verify(msg, difficulty)
  }
  return { msg, hash, difficulty }
}

describe('provider proof-of-work schemes', () => {
  it('the revised checkWork accepts a revised stamp; the legacy verifier does not return that hash', () => {
    const { msg, hash, difficulty } = grind(seed('pow-v2-category', 'pow-v2-data'), msgboard.checkWork)
    // the canonical (revised) verifier accepts it
    expect(msgboard.checkWork(msg, difficulty)).toEqual(hash)
    // the legacy verifier computes a different work hash — it never returns the revised hash
    expect(msgboard.checkWorkLegacy(msg, difficulty)).not.toEqual(hash)
  })

  it('accepts and stores a revised stamp when configured for the revised scheme', async () => {
    const provider = new MsgBoardProvider(mockWrapped, true)
    await provider.setNodeConstraints({ workMultiplier, workDivisor, algorithm: 'revised' })

    const { msg, hash } = grind(seed('pow-v2-category', 'pow-v2-data'), msgboard.checkWork)
    const rlp = msgboard.toRLP(msg)

    // the provider accepts the revised stamp and returns its work hash
    const returned = await provider.request({ method: 'msgboard_addMessage', params: [rlp] })
    expect(returned).toEqual(hash)

    // the stored message is retrievable by that hash and carries version 1
    const stored = (await provider.request({ method: 'msgboard_getMessage', params: [hash] })) as {
      version: Hex
    }
    expect(stored).not.toBeNull()
    expect(BigInt(stored.version)).toEqual(1n)
  })

  it('accepts a legacy stamp under the default legacy scheme', async () => {
    const provider = new MsgBoardProvider(mockWrapped, true)
    // no algorithm passed — the default is legacy
    await provider.setNodeConstraints({ workMultiplier, workDivisor })

    const { msg, hash } = grind(seed('pow-legacy-category', 'pow-legacy-data'), msgboard.checkWorkLegacy)
    const rlp = msgboard.toRLP(msg)

    const returned = await provider.request({ method: 'msgboard_addMessage', params: [rlp] })
    expect(returned).toEqual(hash)
  })

  it('rejects an unsupported version (0)', async () => {
    const provider = new MsgBoardProvider(mockWrapped, true)
    await provider.setNodeConstraints({ workMultiplier, workDivisor, algorithm: 'revised' })

    const { msg } = grind(seed('pow-v2-category', 'pow-v2-data'), msgboard.checkWork)
    const badRlp = msgboard.toRLP({ ...msg, version: 0 })

    await expect(
      provider.request({ method: 'msgboard_addMessage', params: [badRlp] }),
    ).rejects.toThrow('powmsg: invalid version')
  })
})

import { describe, it, expect } from 'vitest'
import { keccak256, toHex, type Hex } from 'viem'
import { checkWork, difficulty, type MessageSeed } from '@msgboard/core'
import { loadDefaultStamper } from './grinder.js'

/**
 * The fast engine must be bit-identical to the node's verifier: a stamp found by the Rust
 * grinder has to pass core's `checkWork` — the exact check the RPC applies on submit. This is
 * the parity gate that lets `doPoW` trust the engine's output without re-verifying.
 */

const CATEGORY = keccak256(toHex('grinder-parity-test'))
const DATA = toHex('hello from the grinder test') as Hex
const BLOCK_HASH = keccak256(toHex('some block')) as Hex
// Real testnet difficulty factors (the client defaults) — one stamp is ~1-2s in WASM.
const FACTORS = { workMultiplier: 10_000n, workDivisor: 1_000_000n }

describe('loadDefaultStamper', () => {
  it('resolves an engine (the committed WASM at minimum)', async () => {
    const stamper = await loadDefaultStamper()
    expect(stamper).not.toBeNull()
  })

  it('finds a stamp that passes core checkWork — the canonical verifier', async () => {
    const stamper = (await loadDefaultStamper())!
    const { nonce, hash } = await stamper({
      category: CATEGORY,
      data: DATA,
      blockHash: BLOCK_HASH,
      ...FACTORS,
    })
    const seed: MessageSeed = {
      version: 1,
      blockHash: BLOCK_HASH,
      category: CATEGORY,
      data: DATA,
      nonce,
      ...FACTORS,
    }
    const dataLen = (DATA.length - 2) / 2
    const verified = checkWork(seed, difficulty(FACTORS, dataLen))
    expect(verified).not.toBeNull()
    expect(verified).toBe(hash)
  }, 120_000)
})

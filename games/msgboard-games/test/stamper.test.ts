import { describe, it, expect, afterEach } from 'vitest'
import { stringToHex, type Hex } from 'viem'
// VERIFIER PATH: `checkWork` + `difficulty` are re-exported by `@msgboard/sdk` (it does
// `export * from '@msgboard/core'`). `checkWork(seed, difficulty)` recomputes the message hash exactly
// as the reth node does and returns it iff `BigInt(hash) % difficulty === 0n` (else null) — so a
// non-null result is a real, node-equivalent proof that the WASM-minted nonce is valid.
import { checkWork, difficulty, categoryHash } from '@msgboard/sdk'
import { loadDefaultStamper } from '../src/stamper'
import { msgBoardClientAdapter } from '../src/board'

// FAST difficulty factors: difficulty = ((2^24 + size*10000) * wm) / wd. With wm=1 and a large wd we
// shrink difficulty to a few hundred, so the grind finds a valid nonce in a few hundred iters (ms).
const workMultiplier = 1n
const workDivisor = 65536n
// A deterministic, valid 32-byte block hash (any 32-byte value works for the PoW math).
const blockHash = ('0x' + '11'.repeat(32)) as Hex

describe('default stamper (WASM/native cascade)', () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
  })

  it('(a) mints a nonce the node verifier (checkWork) accepts', async () => {
    const stamper = await loadDefaultStamper()
    // The WASM engine is committed, so a stamper MUST be available in this Node test env.
    expect(stamper).not.toBeNull()

    const category = categoryHash('games.msgboard.xyz:stamper-test')
    const data = stringToHex('hi')

    const { nonce, hash } = await stamper!({ category, data, workMultiplier, workDivisor, blockHash })

    // Rebuild the on-wire message seed and verify the nonce against the documented difficulty.
    const seed = { version: 1, blockHash, category, data, nonce, workMultiplier, workDivisor }
    const msgDifficulty = difficulty({ workMultiplier, workDivisor }, (data.length - 2) / 2)
    const verified = checkWork(seed, msgDifficulty)

    // `checkWork` returns the hash when valid, null when not — non-null proves node-equivalent validity.
    expect(verified).not.toBeNull()
    // And the hash the engine reported matches the verifier's recomputed hash.
    expect(verified).toBe(hash)
    expect(BigInt(hash) % msgDifficulty).toBe(0n)
  })
})

describe('adapter falls back to board.doPoW (JS grind)', () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document
  })

  it('(b) when the injected stamper throws, doPoW runs and its message is submitted', async () => {
    // Run in node env (no `document`) so assertOffMainThread passes.
    let doPoWCalled = false
    let submitted: unknown
    const fallbackMessage = { version: 1, category: '0xcat', data: '0xdata', nonce: 7n }
    const board = {
      status: async () => ({ workMultiplier: '1', workDivisor: '65536' }),
      lastestBlock: async () => ({ hash: blockHash }),
      doPoW: async (category: Hex, data: Hex) => {
        doPoWCalled = true
        return { message: { ...fallbackMessage, category, data } }
      },
      addMessage: async (msg: unknown) => {
        submitted = msg
        return '0xhash'
      },
    } as never

    // Inject a stamper that always throws → the fast path must be abandoned for the JS grind.
    const throwingStamper = () => {
      throw new Error('stamper boom')
    }
    const client = msgBoardClientAdapter(board, { stamp: throwingStamper })

    const result = await client.addMessage({ category: '0xcat' as Hex, data: '0xdata' as Hex })

    expect(doPoWCalled).toBe(true)
    expect(result).toBe('0xhash')
    // The exact message doPoW produced was submitted via addMessage.
    expect(submitted).toMatchObject({ ...fallbackMessage, category: '0xcat', data: '0xdata' })
  })
})

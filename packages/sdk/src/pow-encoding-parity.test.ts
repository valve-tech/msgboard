import { describe, it, expect } from 'vitest'
import { keccak256, toHex, hexToBytes, bytesToHex, type Hex } from 'viem'
import { checkWorkLegacy, getChallengeLegacy, type MessageSeed } from '@msgboard/core'

/**
 * TS ↔ Rust grinder agreement at the challenge-encoding BOUNDARY.
 *
 * The existing grinder.test.ts proves a Rust stamp passes TS checkWork, but only for whatever nonce
 * the grind happens to win on — almost never a leading-zero x. The 31-vs-32-byte bug shows ONLY when
 * the x-coordinate is below 2^248 (~1 in 256), so a random parity test lands right 255 times in 256.
 *
 * This test pins the exact boundary nonce (587 for the fixed vector below, whose challenge x < 2^248)
 * and forces the committed WASM grinder to evaluate THAT nonce: difficulty is set to 1 (every hash is
 * a "winner") and the engine is called with startNonce=586, maxIters=1 — the Rust grind increments the
 * nonce at the top of its loop, so it evaluates exactly nonce 587 and returns its work hash. If the TS
 * challenge encoding disagreed with the node's (the bug), the two hashes would differ here.
 */

// difficulty = (2^24 + dataLen*10000) * wm / wd = 1 when wm=1, wd=2^24+dataLen*10000 → accept-all.
const CATEGORY = keccak256(toHex('pow-encoding-test'))
const DATA = '0x00' as Hex // 1 byte
const DATA_LEN = 1
const BLOCK_HASH = keccak256(toHex('pow-encoding-block'))
const WM = 1n
const WD = BigInt(2 ** 24 + DATA_LEN * 10000)
const BOUNDARY_NONCE = 587n

type EngineStamp = (req: {
  category: Uint8Array
  data: Uint8Array
  workMultiplier: number
  workDivisor: number
  blockHash: Uint8Array
  startNonce: number
  maxIters: number
}) => Uint8Array | null | undefined

/** Load the committed WASM engine's raw `stamp` (Node path: init with the on-disk wasm bytes). */
async function loadRawWasmEngine(): Promise<EngineStamp | null> {
  try {
    const wasm = (await import('@msgboard/pow-grinder/wasm')) as {
      default: (arg?: { module_or_path: BufferSource }) => Promise<unknown>
      stamp: EngineStamp
    }
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const jsPath = require.resolve('@msgboard/pow-grinder/wasm')
    const { readFileSync } = await import('node:fs')
    const bytes = readFileSync(new URL('pow_grinder_bg.wasm', `file://${jsPath}`))
    await wasm.default({ module_or_path: bytes })
    return typeof wasm.stamp === 'function' ? wasm.stamp : null
  } catch {
    return null
  }
}

const seedAt = (nonce: bigint): MessageSeed => ({
  version: 1,
  blockHash: BLOCK_HASH,
  category: CATEGORY,
  data: DATA,
  nonce,
  workMultiplier: WM,
  workDivisor: WD,
})

describe('challenge encoding parity (TS ↔ committed Rust WASM)', () => {
  it('the pinned vector really is the leading-zero boundary case', () => {
    const x = getChallengeLegacy(seedAt(BOUNDARY_NONCE))
    expect(x.length).toBe(32)
    expect(x[0]).toBe(0) // x < 2^248
  })

  it('the committed WASM grinder and TS checkWorkLegacy agree on the boundary nonce', async () => {
    const engine = await loadRawWasmEngine()
    // If the committed WASM cannot load here, fail loudly — this test must actually run the compare.
    expect(engine, 'committed WASM engine failed to load').not.toBeNull()

    const out = engine!({
      category: hexToBytes(CATEGORY, { size: 32 }),
      data: hexToBytes(DATA),
      workMultiplier: Number(WM),
      workDivisor: Number(WD),
      blockHash: hexToBytes(BLOCK_HASH, { size: 32 }),
      startNonce: Number(BOUNDARY_NONCE) - 1, // grind increments first → evaluates BOUNDARY_NONCE
      maxIters: 1,
    })
    expect(out, 'engine returned no stamp at difficulty 1').not.toBeNull()

    const rustNonce = BigInt(bytesToHex(out!.subarray(0, 8)))
    const rustHash = bytesToHex(out!.subarray(8, 40)) as Hex
    expect(rustNonce).toBe(BOUNDARY_NONCE)

    // TS side: difficulty is 1, so checkWorkLegacy returns the work hash for this exact nonce.
    const tsHash = checkWorkLegacy(seedAt(BOUNDARY_NONCE), 1n)
    expect(tsHash).not.toBeNull()
    expect(rustHash).toBe(tsHash) // the encodings agree byte-for-byte at the boundary
  }, 60_000)
})

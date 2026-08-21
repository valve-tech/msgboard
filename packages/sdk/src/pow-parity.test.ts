import { describe, it, expect } from 'vitest'
import { keccak256, toHex, hexToBytes, bytesToHex, type Hex } from 'viem'
import { checkWork, difficulty, type MessageSeed } from '@msgboard/core'

/**
 * TS ↔ Rust grinder agreement. The committed WASM `stamp_v2` grinds a message; TS `checkWork` must
 * return the SAME work hash for the nonce it found. This is the consensus gate: the fast Rust engine
 * and the TS verifier have to agree byte-for-byte, or a stamp the grinder finds would be rejected by
 * the verifier (and the node).
 *
 * The work hash is over the 33-byte compressed point (no leading-zero encoding hazard), so any nonce
 * suffices — no boundary hunt needed. Difficulty is set to 1 (target 2^256 → accept-all) so the grind
 * returns quickly. version is 1 — the one and only message version.
 */

const CATEGORY = keccak256(toHex('pow-parity-cat'))
const DATA = '0x0102030405' as Hex // 1..5, dataLen 5
const DATA_LEN = 5
const BLOCK_HASH = keccak256(toHex('pow-parity-block'))
const WM = 1n
const WD = BigInt(2 ** 24 + DATA_LEN * 10000) // difficulty()==1 for this dataLen
const VERSION = 1

type EngineStampV2 = (req: {
  category: Uint8Array
  data: Uint8Array
  workMultiplier: number
  workDivisor: number
  blockHash: Uint8Array
  version: number
  startNonce: number
  maxIters: number
}) => Uint8Array | null | undefined

async function loadRawWasmV2(): Promise<EngineStampV2 | null> {
  try {
    const wasm = (await import('@msgboard/pow-grinder/wasm')) as {
      default: (arg?: { module_or_path: BufferSource }) => Promise<unknown>
      stamp_v2?: EngineStampV2
    }
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const jsPath = require.resolve('@msgboard/pow-grinder/wasm')
    const { readFileSync } = await import('node:fs')
    const bytes = readFileSync(new URL('pow_grinder_bg.wasm', `file://${jsPath}`))
    await wasm.default({ module_or_path: bytes })
    return typeof wasm.stamp_v2 === 'function' ? wasm.stamp_v2 : null
  } catch {
    return null
  }
}

const seedAt = (nonce: bigint): MessageSeed => ({
  version: VERSION,
  blockHash: BLOCK_HASH,
  category: CATEGORY,
  data: DATA,
  nonce,
  workMultiplier: WM,
  workDivisor: WD,
})

describe('PoW parity (TS ↔ committed Rust WASM stamp_v2)', () => {
  it('the WASM grinder and TS checkWork agree on the nonce the grinder found', async () => {
    const engine = await loadRawWasmV2()
    expect(engine, 'committed WASM stamp_v2 failed to load (rebuild pow-grinder?)').not.toBeNull()

    const D = difficulty({ workMultiplier: WM, workDivisor: WD }, DATA_LEN)
    expect(D).toBe(1n) // accept-all, so the grind returns a nonce fast

    const out = engine!({
      category: hexToBytes(CATEGORY, { size: 32 }),
      data: hexToBytes(DATA),
      workMultiplier: Number(WM),
      workDivisor: Number(WD),
      blockHash: hexToBytes(BLOCK_HASH, { size: 32 }),
      version: VERSION,
      startNonce: 0,
      maxIters: 5000,
    })
    expect(out, 'v2 engine returned no stamp at difficulty 1').not.toBeNull()

    const rustNonce = BigInt(bytesToHex(out!.subarray(0, 8)))
    const rustHash = bytesToHex(out!.subarray(8, 40)) as Hex

    // TS must return the identical work hash for the exact nonce the Rust engine settled on.
    const tsHash = checkWork(seedAt(rustNonce), 1n)
    expect(tsHash).toBe(rustHash)
  }, 60_000)
})

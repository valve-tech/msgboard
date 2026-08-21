import { hexToBytes, bytesToHex, type Hex } from 'viem'

/**
 * Fast proof-of-work engines for `MsgBoardClient.doPoW` — the `@msgboard/pow-grinder` Rust
 * grinder, tried native → WASM, with the SDK's incremental JS search as the always-available
 * fallback. Adapted from the games platform's proven stamper cascade
 * (games/msgboard-games/src/stamper.ts), which shipped this exact contract to production bots
 * and the games web app.
 *
 *   1. NATIVE — the `@msgboard/pow-grinder` Rust addon (`.node`). Fastest (~1s/stamp at testnet
 *      difficulty), but the `.node` is a local cargo build artifact; on most installs importing
 *      it THROWS and we fall through.
 *   2. WASM — `@msgboard/pow-grinder/wasm` (the committed `pow_grinder_bg.wasm`, also in the
 *      published package). In Node we must hand `init` the wasm bytes (its default fetches a
 *      file:// URL, which fails); in a browser/Web Worker `init()` with no arg works — though
 *      bundled apps (vite workers) should import the wasm module themselves and pass a stamper
 *      via the client's `stamper` config, so the bundler sees the asset (see
 *      `wrapEngineStamp`); the SDK ships as CommonJS and its dynamic import may not survive
 *      every bundler.
 *   3. null — neither engine loads; `doPoW` falls back to the JS grind (~30-110s at testnet
 *      difficulty). Every failure path lands here, so the cascade can never make things worse.
 */

/** What a stamper is asked to grind: the PoW-relevant fields of a message. */
export type StampInput = {
  category: Hex
  data: Hex
  workMultiplier: bigint
  workDivisor: bigint
  blockHash: Hex
}

/** A found stamp: the winning nonce and the message hash it produces. */
export type Stamp = { nonce: bigint; hash: Hex }

/**
 * A pure-compute PoW engine: grinds `input` and returns the stamp, or THROWS when its iteration
 * budget is exhausted (callers fall back to the JS grind). No keys, no network.
 */
export type Stamper = (input: StampInput) => Stamp | Promise<Stamp>

/** The low-level engine call both the native addon and the WASM module expose (the grinder's
 *  `stamp_v2`). `version` is the message version hashed into the scalar transcript — always 1. */
type EngineStamp = (req: {
  category: Uint8Array
  data: Uint8Array
  workMultiplier: number
  workDivisor: number
  blockHash: Uint8Array
  version: number
  startNonce: number
  maxIters: number
}) => Uint8Array | null | undefined

/** A generous per-call budget: the engines loop internally up to this many nonces. 50M is far
 *  beyond a testnet-difficulty message; exhaustion THROWS so the caller falls back. */
const MAX_ITERS = 50_000_000

/**
 * Adapt a raw engine `stamp_v2` (native or WASM, e.g. from `import('@msgboard/pow-grinder/wasm')`)
 * to the `Stamper` surface: Hex↔bytes conversion + unpacking the 40-byte
 * `nonce_be(8) ‖ hash(32)` result. Browser apps use this to hand their bundler-resolved WASM
 * engine to `MsgBoardClient` via the `stamper` config. `version` is pinned to 1 — the message
 * version hashed into the scalar transcript; `stamp_v2` REQUIRES the field, and omitting it makes
 * the engine reject the request (→ silent JS-grind fallback).
 */
export function wrapEngineStamp(engine: EngineStamp): Stamper {
  return (input: StampInput): Stamp => {
    const out = engine({
      category: hexToBytes(input.category, { size: 32 }),
      data: hexToBytes(input.data),
      workMultiplier: Number(input.workMultiplier),
      workDivisor: Number(input.workDivisor),
      blockHash: hexToBytes(input.blockHash, { size: 32 }),
      version: 1,
      startNonce: 0,
      maxIters: MAX_ITERS,
    })
    if (out == null) {
      throw new Error(`pow-grinder: no nonce found within ${MAX_ITERS} iterations`)
    }
    const nonce = BigInt(bytesToHex(out.subarray(0, 8)))
    const hash = bytesToHex(out.subarray(8, 40)) as Hex
    return { nonce, hash }
  }
}

/** Cache the resolved engine so we never re-init WASM (or re-probe native) per grind.
 *  `undefined` = not yet probed; `null` = probed, neither engine available. */
let cachedStamper: Stamper | null | undefined

function isNode(): boolean {
  return typeof process !== 'undefined' && process.versions != null && process.versions.node != null
}

/**
 * Try the native Rust addon (throws on machines without a local cargo build). The grinder exports the
 * PoW engine as `stamp_v2` (the pre-revision `stamp` engine is dead — the node rejects that work). Read
 * it through an optional type and guard with a `typeof` check, so an old grinder without the engine
 * yields `null` and never throws.
 */
async function tryNative(): Promise<Stamper | null> {
  try {
    // Declare the dead `stamp` too, so this type OVERLAPS the addon's compiled type (TS rejects an
    // object type with no property in common). Only `stamp_v2` is ever used.
    const mod: { stamp?: EngineStamp; stamp_v2?: EngineStamp } = await import('@msgboard/pow-grinder')
    return typeof mod.stamp_v2 === 'function' ? wrapEngineStamp(mod.stamp_v2) : null
  } catch {
    return null
  }
}

/**
 * This module's own location as a `file://` URL — the base for resolving the committed wasm.
 * Read WITHOUT a syntactic `import.meta` token so a CommonJS transpile of this file stays pure
 * CJS (a bare `import.meta` forces ESM detection and the CJS emit then dies on `exports is not
 * defined` — the exact failure the games stamper hardened against under ts-node).
 */
function selfFileUrl(): string {
  try {
    const metaUrl = (0, eval)('import.meta.url') as string | undefined
    if (typeof metaUrl === 'string') return metaUrl
  } catch {
    /* not an ES module — fall through to the CommonJS form */
  }
  if (typeof __filename !== 'undefined') return `file://${__filename}`
  return `file://${process.cwd()}/`
}

/** Locate `pow_grinder_bg.wasm` for Node as the sibling of the resolved wasm JS module. */
async function wasmBytesUrl(): Promise<URL> {
  const base = selfFileUrl()
  const { createRequire } = await import('node:module')
  const require = createRequire(base)
  const jsPath = require.resolve('@msgboard/pow-grinder/wasm') // .../pkg/pow_grinder.js
  return new URL('pow_grinder_bg.wasm', `file://${jsPath}`)
}

/**
 * Try the WASM module's `stamp_v2` engine. Env-aware init: Node reads the wasm bytes off disk; a
 * browser fetches. The `stamp_v2?` optional type plus the `typeof` guard mean an old build without the
 * engine returns `null` cleanly — a missing export is never called and never throws.
 */
async function tryWasm(): Promise<Stamper | null> {
  try {
    const wasm: {
      default: (arg?: { module_or_path: BufferSource }) => Promise<unknown>
      stamp_v2?: EngineStamp
    } = await import('@msgboard/pow-grinder/wasm')
    if (isNode()) {
      const { readFileSync } = await import('node:fs')
      const bytes = readFileSync(await wasmBytesUrl())
      await wasm.default({ module_or_path: bytes })
    } else {
      await wasm.default()
    }
    return typeof wasm.stamp_v2 === 'function' ? wrapEngineStamp(wasm.stamp_v2) : null
  } catch {
    return null
  }
}

/**
 * Resolve (and cache) the fastest available engine: native → WASM → null. Never throws — a
 * `null` simply means `doPoW` keeps its JS grind ({@link createChallengeSearch} in @msgboard/core).
 */
export async function loadDefaultStamper(): Promise<Stamper | null> {
  if (cachedStamper !== undefined) return cachedStamper
  cachedStamper = (await tryNative()) ?? (await tryWasm())
  return cachedStamper
}

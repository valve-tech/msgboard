import { hexToBytes, bytesToHex, type Hex } from 'viem'
import type { Stamper, StampInput, Stamp } from './board'

/**
 * Default "stamper cascade": pick the FASTEST proof-of-work engine that loads on this machine, with no
 * manual wiring and no compiler requirement.
 *
 *   1. NATIVE  — the `@msgboard/pow-grinder` Rust addon (`.node`). Fastest, but the `.node` is a build
 *                artifact (gitignored/cargo-built); on most machines importing it THROWS, so we try it
 *                in a try/catch and fall through when it's absent.
 *   2. WASM    — the committed `@msgboard/pow-grinder/wasm` module. Always present (`pow_grinder_bg.wasm`
 *                is committed). In Node we must hand `init` the wasm bytes (its default fetches a
 *                file:// URL, which fails); in a browser/Web Worker `init()` with no arg works.
 *   3. (none)  — if neither loads, `loadDefaultStamper` returns `null` and the adapter falls back to the
 *                SDK's JS grind (`board.doPoW`).
 *
 * Both engines expose the same `stamp(req)` → 40-byte `nonce_be(8) ‖ hash(32)` (or null/undefined when
 * `maxIters` is exhausted) contract, so a single wrapper adapts either to the `Stamper` surface.
 */

/** The low-level engine call both native and WASM expose. */
type EngineStamp = (req: {
  category: Uint8Array
  data: Uint8Array
  workMultiplier: number
  workDivisor: number
  blockHash: Uint8Array
  startNonce: number
  maxIters: number
}) => Uint8Array | null | undefined

/** A generous iteration budget per `stamp` call. The grinders loop internally up to this many nonces;
 *  if exhausted they return null and we THROW (so the adapter falls back to the JS grind rather than
 *  silently dropping the message). 50M nonces is far beyond a testnet-difficulty message. */
const MAX_ITERS = 50_000_000

/** Cache the resolved engine so we never re-init WASM (or re-probe native) per call. `undefined` = not
 *  yet probed; `null` = probed, neither engine available. */
let cachedEngine: EngineStamp | null | undefined

/** Are we in a Node-like environment (so we must feed WASM the bytes ourselves)? */
function isNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  )
}

/** Try the native Rust addon. Returns its `stamp` or null when the `.node` isn't built for this host. */
async function tryNative(): Promise<EngineStamp | null> {
  try {
    // Dynamic import: index.js `require`s a platform `.node` that is gitignored — absent on most
    // machines, in which case this THROWS and we fall through to WASM.
    const mod: { stamp?: EngineStamp } = await import('@msgboard/pow-grinder')
    return typeof mod.stamp === 'function' ? mod.stamp : null
  } catch {
    return null
  }
}

/**
 * This module's own location as a `file://` URL — the base for resolving the committed wasm.
 *
 * IMPORTANT (do not "simplify" back to a bare `import.meta.url`): this file is consumed BOTH as an ES
 * module (browser/Web Worker, vitest) AND transpiled to CommonJS by ts-node (the Hardhat suite in
 * `packages/contracts`, via the `moduleTypes` override in its tsconfig). A *syntactic* `import.meta`
 * token forces TypeScript/Node to treat the emitted file as ESM even under `module: commonjs`; the
 * CJS emit still references `exports`, so it then blows up with `ReferenceError: exports is not defined
 * in ES module scope` — which broke the whole-suite Hardhat run. So we read `import.meta.url` WITHOUT a
 * syntactic `import.meta` (so the CJS emit stays pure CJS), and fall back to CJS's `__filename` when
 * `import.meta` isn't available (i.e. when we really are running as CommonJS).
 */
function selfFileUrl(): string {
  // ESM path: read `import.meta.url` without the syntactic token (so a CJS transpile of this file does
  // not get force-detected as ESM). `eval` of a CJS module throws here → caught → CJS branch below.
  try {
    const metaUrl = (0, eval)('import.meta.url') as string | undefined
    if (typeof metaUrl === 'string') return metaUrl
  } catch {
    /* not an ES module — fall through to the CommonJS form */
  }
  // CommonJS path (ts-node / Hardhat): the module-local `__filename` is the on-disk path of this module.
  if (typeof __filename !== 'undefined') return `file://${__filename}`
  // Last resort: resolve relative to the process cwd so the workspace-relative fallback still has a base.
  return `file://${process.cwd()}/`
}

/** Locate `pow_grinder_bg.wasm` for Node: prefer the sibling of the resolved `@msgboard/pow-grinder/wasm`
 *  JS module; fall back to the workspace-relative path. Returns a file:// URL `readFileSync` accepts. */
async function wasmBytesUrl(): Promise<URL> {
  const base = selfFileUrl()
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(base)
    const jsPath = require.resolve('@msgboard/pow-grinder/wasm') // .../pkg/pow_grinder.js
    return new URL('pow_grinder_bg.wasm', `file://${jsPath}`)
  } catch {
    return new URL('../../pow-grinder/pkg/pow_grinder_bg.wasm', base)
  }
}

/** Try the committed WASM module. Env-aware init: Node reads the wasm bytes off disk; browser fetches. */
async function tryWasm(): Promise<EngineStamp | null> {
  try {
    const wasm: {
      default: (arg?: { module_or_path: BufferSource }) => Promise<unknown>
      stamp: EngineStamp
    } = await import('@msgboard/pow-grinder/wasm')
    if (isNode()) {
      // In Node, `init()` with no arg fetches a file:// URL and FAILS. Hand it the wasm bytes via the
      // single-object form (`{ module_or_path }`). Locate the committed `pow_grinder_bg.wasm` as the
      // sibling of the resolved `@msgboard/pow-grinder/wasm` JS module (robust to install layout), falling
      // back to the workspace-relative path.
      const { readFileSync } = await import('node:fs')
      const bytes = readFileSync(await wasmBytesUrl())
      await wasm.default({ module_or_path: bytes })
    } else {
      // Browser / Web Worker: the default `init()` fetches `pow_grinder_bg.wasm` relative to the module.
      await wasm.default()
    }
    return typeof wasm.stamp === 'function' ? wasm.stamp : null
  } catch {
    return null
  }
}

/** Resolve (and cache) the fastest available engine: native → WASM → none. */
async function resolveEngine(): Promise<EngineStamp | null> {
  if (cachedEngine !== undefined) return cachedEngine
  cachedEngine = (await tryNative()) ?? (await tryWasm())
  return cachedEngine
}

/**
 * Load the default `Stamper` for this environment, or `null` if no native/WASM engine is available
 * (caller then falls back to the SDK's JS grind). The returned stamper is pure compute: it converts
 * `Hex`↔bytes, runs the engine grind, and unpacks the 40-byte `nonce_be(8) ‖ hash(32)` result into
 * `{ nonce, hash }`. If the engine exhausts `MAX_ITERS` (returns null), it THROWS — no key, no network.
 */
export async function loadDefaultStamper(): Promise<Stamper | null> {
  const engine = await resolveEngine()
  if (!engine) return null
  return (input: StampInput): Stamp => {
    const out = engine({
      category: hexToBytes(input.category, { size: 32 }),
      data: hexToBytes(input.data),
      workMultiplier: Number(input.workMultiplier),
      workDivisor: Number(input.workDivisor),
      blockHash: hexToBytes(input.blockHash, { size: 32 }),
      startNonce: 0,
      maxIters: MAX_ITERS,
    })
    if (out == null) {
      // maxIters exhausted with no valid nonce — let the adapter fall back to the JS grind.
      throw new Error(`pow-grinder: no nonce found within ${MAX_ITERS} iterations`)
    }
    // 40 bytes = nonce_be(8) ‖ hash(32).
    const nonce = BigInt(bytesToHex(out.subarray(0, 8)))
    const hash = bytesToHex(out.subarray(8, 40)) as Hex
    return { nonce, hash }
  }
}

/**
 * landing-house.ts — the actor-fleet entrypoint for the msgboard.xyz LANDING coin-flip house.
 *
 * This is the long-running counterparty the landing "Arcade" tab plays against: the zero-stakes,
 * provably-fair 2× coin flip run over the REAL board-mediated commit-reveal protocol at 0 tokens at
 * risk. The house game + `runLandingHouse` live in `@msgboard/games-house-service`; this file is ONLY
 * the actor-fleet packaging — it reads env the same way the other actors do (session-bots et al),
 * derives the house SIGNING key, logs a startup banner, and starts the loop.
 *
 * The house key only ever SIGNS (EIP-712 co-sign + PoW board posts): it needs no funds. To avoid
 * collision with the other actors' mnemonic indices (validators 1-3, gate players 4-8, session-bots
 * 30, cosign-bot 40-42) the house is derived at addressIndex HOUSE_INDEX (default 50).
 *
 * Env (mirrors the other actors' conventions; RPC/MSGBOARD_RPC are the keyed valve endpoints from
 * the compose file):
 *   MNEMONIC      required — the house signer is addressIndex HOUSE_INDEX.
 *   CHAIN         default 943 — the chain the landing house serves.
 *   RPC           chain-read RPC (head block). Keyed valve endpoint, passed from compose.
 *   MSGBOARD_RPC  MsgBoard RPC (post/read board messages). Keyed valve endpoint, passed from compose.
 *   HOUSE_INDEX   default 50 — the mnemonic addressIndex the house key is derived at.
 */
import './redact-console' // first: scrub the valve RPC key from all console output before anything logs
import { initSync, stamp_v2 as wasmStamp } from '@msgboard/pow-grinder/wasm'
import { runLandingHouse, houseSignerFromMnemonic } from '@msgboard/games-house-service'
import type { Stamper } from '@msgboard/games'
import { POW_GRINDER_WASM_B64 } from './pow-grinder-wasm-b64'

const env = process.env
const CHAIN = env.CHAIN ?? '943'
const HOUSE_INDEX = env.HOUSE_INDEX ?? '50'

// FAST PoW stamper. Without this the house's board client falls to the default native→WASM cascade,
// which in a self-contained esbuild .mjs (no .node addon, no .wasm on disk) collapses to a ~150s JS
// grind — so the grant/co-sign/transcript land ~15 blocks late, past the player's 120s co-sign timeout,
// and every flip voids. Instantiate the portable WASM engine from embedded base64 (same recipe as
// pow-worker.ts), stamp synchronously (~1-2s) — fine on the bot's own thread (no game loops to starve).
initSync({ module: Buffer.from(POW_GRINDER_WASM_B64, 'base64') })
const toBytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex')
const wasmStamper: Stamper = async ({ category, data, workMultiplier, workDivisor, blockHash }) => {
  const out = wasmStamp({
    category: toBytes(category),
    data: toBytes(data),
    workMultiplier: Number(workMultiplier),
    workDivisor: Number(workDivisor),
    blockHash: toBytes(blockHash),
    version: 1, // the one and only message version, hashed into the scalar transcript; stamp_v2 requires it
    startNonce: 0,
    maxIters: 50_000_000, // ample for the 943 floor (~190k iters); the wasm grinder finds it in ~1-2s
  })
  if (!out) throw new Error('landing-house PoW: maxIters exhausted')
  const nonce = BigInt('0x' + Buffer.from(out.subarray(0, 8)).toString('hex'))
  const hash = ('0x' + Buffer.from(out.subarray(8)).toString('hex')) as `0x${string}`
  return { nonce, hash }
}

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC required')
  const houseSigner = houseSignerFromMnemonic(env.MNEMONIC, Number(HOUSE_INDEX))

  // The deploy greps the `landing house on chain 943` prefix; the address tells the operator which
  // address to pin as the landing house in the UI.
  console.log(`landing house on chain ${CHAIN} @ ${houseSigner.address}`)

  const { stop } = runLandingHouse({
    houseSigner,
    chainId: Number(CHAIN),
    rpcUrl: env.RPC,
    boardRpc: env.MSGBOARD_RPC,
    stamper: wasmStamper,
  })

  // graceful shutdown — halt the board feed + house loops, then exit (mirrors session-bots).
  const shutdown = (sig: string) => {
    console.log(`\n${sig} — stopping landing house…`)
    stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

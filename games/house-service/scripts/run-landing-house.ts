/**
 * run-landing-house.ts — the long-running LANDING coin-flip house-service process.
 *
 * Mirrors src/main.ts, but starts the zero-stakes landing coin-flip bot: coinflip-only, optimistic
 * (settlementMode 0 — nothing settles on-chain), on the isolated `landingHouseCategory` feed. It holds
 * the house SIGNING key (mnemonic index 1) which needs no funds — it only co-signs state and posts
 * PoW-stamped board messages. Run with `npm run start:landing` (or `tsx scripts/run-landing-house.ts`).
 * Ctrl-C to stop. Deploy is via the ansible runbook (a follow-up, out of code scope).
 */
import { runLandingHouse, landingHouseConfig } from '../src/runLandingHouse'
import { readMnemonic, houseSignerFromMnemonic, redactRpc } from '../src/liveConfig'

async function main(): Promise<void> {
  const mnemonic = readMnemonic()
  const houseSigner = houseSignerFromMnemonic(mnemonic, 1)
  const cfg = landingHouseConfig({ houseSigner })

  console.log(`[landing-house] chain=${cfg.chainId} houseKey=${houseSigner.address}`)
  console.log(`[landing-house] game=coinflip(gameId=5) settlementMode=${cfg.settlementMode} (optimistic — no on-chain settle)`)
  console.log(`[landing-house] category=${cfg.category?.category}`)
  console.log(`[landing-house] channel=${cfg.houseChannel} (EIP-712 domain only — never called)`)
  console.log(`[landing-house] board=${redactRpc(cfg.boardRpc)}`)

  const { stop } = runLandingHouse({ houseSigner })

  const shutdown = (sig: string) => {
    console.log(`[landing-house] ${sig} — stopping`)
    stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  console.log('[landing-house] watching the landing board — Ctrl-C to stop')
}

main().catch((err) => {
  console.error('[landing-house] fatal:', err)
  process.exit(1)
})

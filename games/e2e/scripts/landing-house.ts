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
import { runLandingHouse, houseSignerFromMnemonic } from '@msgboard/games-house-service'

const env = process.env
const CHAIN = env.CHAIN ?? '943'
const HOUSE_INDEX = env.HOUSE_INDEX ?? '50'

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

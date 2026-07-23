/**
 * main.ts — the long-running house-service process.
 *
 * Holds the house signing key (mnemonic index 1), watches the 943 board, grants opens, and co-signs
 * rounds. Purely off-chain: it posts PoW-stamped board messages and signs EIP-712 state — it never
 * sends an on-chain tx. Run with `tsx src/main.ts` (or the package `start` script). Ctrl-C to stop.
 */
import { runBoardHouse } from './runHouse'
import { DEPLOYMENT_943, DEFAULT_LIMITS, readMnemonic, houseSignerFromMnemonic, redactRpc } from './liveConfig'

async function main(): Promise<void> {
  const mnemonic = readMnemonic()
  const houseSigner = houseSignerFromMnemonic(mnemonic, 1)

  console.log(`[house] chain=${DEPLOYMENT_943.chainId} houseKey=${houseSigner.address}`)
  console.log(`[house] channel=${DEPLOYMENT_943.houseChannel}`)
  console.log(`[house] board=${redactRpc(DEPLOYMENT_943.boardRpc)}`)

  const { stop } = runBoardHouse({
    rpcUrl: DEPLOYMENT_943.rpcUrl,
    boardRpc: DEPLOYMENT_943.boardRpc,
    chainId: DEPLOYMENT_943.chainId,
    houseChannel: DEPLOYMENT_943.houseChannel,
    houseSigner,
    limits: DEFAULT_LIMITS,
  })

  const shutdown = (sig: string) => {
    console.log(`[house] ${sig} — stopping`)
    stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  console.log('[house] watching the board — Ctrl-C to stop')
}

main().catch((err) => {
  console.error('[house] fatal:', err)
  process.exit(1)
})

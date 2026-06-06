/**
 * keep-alive — keep a message alive in the board's ephemeral pool.
 *
 * The board only retains roughly the last ~120 blocks of messages: a message
 * rooted at block B is evicted once the head advances ~120 blocks past B. Any
 * use case that needs a message to PERSIST (a standing multi-sig request, an
 * open intent for solvers, a pending action request) must therefore watch its
 * own message and re-post fresh proof-of-work before it ages out.
 *
 * This demo posts one message, then loops:
 *   1. read the head block and look the message up by hash
 *   2. compute remaining life = RETENTION_BLOCKS - (head - rootBlock)
 *   3. if the message is already gone, or within REFRESH_AT_BLOCKS_LEFT of
 *      eviction, re-grind proof-of-work (which re-roots it to the current head)
 *      and re-submit — buying a fresh ~120-block lease
 *
 * Usage:
 *   MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 \
 *     npm run keep-alive --workspace=packages/examples
 *
 * Optional env vars:
 *   MSG_CATEGORY            category label (default "gasmoneyplease")
 *   MSG_DATA                message payload (default "keep me alive")
 *   RETENTION_BLOCKS        the board's retention window in blocks (default 120)
 *   REFRESH_AT_BLOCKS_LEFT  re-post when this many blocks of life remain (default 20)
 *   CHECK_INTERVAL_MS       how often to check (default 30000)
 *
 * Safe by default: this does real proof-of-work and posts live messages, so it
 * requires MSGBOARD_RPC. Each grind takes a few minutes in the JavaScript SDK
 * even at demo difficulty (the node grinds faster natively), so set
 * CHECK_INTERVAL_MS comfortably below your block time but expect re-posts to
 * take a while.
 */
import { MsgBoardClient } from '@msgboard/sdk'
import type { Provider } from '@msgboard/sdk'
import { createPublicClient, http, type Hex } from 'viem'

const rpcUrl = process.env.MSGBOARD_RPC
const category = process.env.MSG_CATEGORY ?? 'gasmoneyplease'
const data = process.env.MSG_DATA ?? 'keep me alive'
const RETENTION_BLOCKS = BigInt(process.env.RETENTION_BLOCKS ?? 120)
const REFRESH_AT_BLOCKS_LEFT = BigInt(process.env.REFRESH_AT_BLOCKS_LEFT ?? 20)
const checkIntervalMs = Number(process.env.CHECK_INTERVAL_MS ?? 30_000)

console.log('\nmsgboard keep-alive')
console.log('─────────────────────────────────────────')

if (!rpcUrl) {
  console.log('\nMSGBOARD_RPC is not set — nothing was posted.')
  console.log('This demo does real proof-of-work and posts live messages, so it needs an endpoint.\n')
  console.log('The board retains only ~120 blocks of messages. To keep one alive you:')
  console.log('  • look it up by hash each interval (msgboard_getMessage returns null once evicted)')
  console.log('  • track its root block and the head block to estimate remaining life')
  console.log('  • re-grind proof-of-work before it ages out (doPoW re-roots to the current head)\n')
  console.log('Run it for real:')
  console.log('  MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 \\')
  console.log('    npm run keep-alive --workspace=packages/examples\n')
  process.exit(0)
}

const client = new MsgBoardClient(
  createPublicClient({ transport: http(rpcUrl) }) as unknown as Provider,
)

/** Grinds fresh proof-of-work against the board's live difficulty and submits it. */
const postFreshMessage = async (): Promise<{ hash: Hex; rootBlock: bigint }> => {
  // Always re-read difficulty factors: a board can tighten them, which would
  // reject work ground against stale settings.
  const status = await client.status()
  client.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
  const work = await client.doPoW(category, data)
  const hash = await client.addMessage(work.message)
  return { hash, rootBlock: work.message.blockNumber }
}

const headBlock = async (): Promise<bigint> => BigInt((await client.lastestBlock()).number)

console.log(`RPC:       ${rpcUrl}`)
console.log(`message:   "${data}" in category "${category}"`)
console.log(`retention: ${RETENTION_BLOCKS} blocks — refresh with ${REFRESH_AT_BLOCKS_LEFT} blocks left`)
console.log(`grinding initial proof-of-work…\n`)

let { hash, rootBlock } = await postFreshMessage()
console.log(`posted ${hash} (rooted at block ${rootBlock})`)

const tick = async (): Promise<void> => {
  const head = await headBlock()
  const present = await client.getMessage(hash)

  if (present === null) {
    console.log(`[block ${head}] message evicted — resurrecting…`)
    ;({ hash, rootBlock } = await postFreshMessage())
    console.log(`  re-posted ${hash} (rooted at block ${rootBlock})`)
    return
  }

  const age = head - rootBlock
  const remaining = RETENTION_BLOCKS - age
  if (remaining <= REFRESH_AT_BLOCKS_LEFT) {
    console.log(`[block ${head}] ${remaining} blocks of life left — refreshing…`)
    ;({ hash, rootBlock } = await postFreshMessage())
    console.log(`  re-posted ${hash} (rooted at block ${rootBlock})`)
    return
  }

  console.log(`[block ${head}] alive — ${remaining} blocks of life left`)
}

const timer = setInterval(() => {
  // A transient RPC error must not kill the loop — log and try again next tick.
  tick().catch((error) => console.log(`  check failed: ${error instanceof Error ? error.message : error}`))
}, checkIntervalMs)

process.on('SIGINT', () => {
  console.log('\nstopping — the message will age out naturally within ~120 blocks.')
  clearInterval(timer)
  process.exit(0)
})

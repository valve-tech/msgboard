/**
 * submit-message — the canonical write flow: solve proof-of-work locally with the
 * SDK, then post the message to a msgboard node.
 *
 * This is the most basic "hello world" write example. The four steps are:
 *   1. status()              — read the board's current difficulty factors
 *   2. setDifficultyFactors  — grind against the same difficulty the node enforces
 *   3. doPoW(category, data) — find a valid nonce (this is the expensive part)
 *   4. addMessage(message)   — submit the proven message; the node re-verifies the work
 *
 * Usage:
 *   MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 \
 *     npm run submit-message --workspace=packages/examples
 *
 * Optional env vars:
 *   MSG_CATEGORY   category label for the message (default "gasmoneyplease")
 *   MSG_DATA       message payload (default "hello from @msgboard/examples")
 *
 * Safe by default: this demo does REAL proof-of-work and posts a REAL message, so
 * it refuses to run unless MSGBOARD_RPC is set. Proof of work takes MINUTES at
 * production difficulty and pegs a CPU core while it grinds.
 */
import { MsgBoardClient } from '@msgboard/sdk'
import type { Provider } from '@msgboard/sdk'
import { createPublicClient, http } from 'viem'

const rpcUrl = process.env.MSGBOARD_RPC
const category = process.env.MSG_CATEGORY ?? 'gasmoneyplease'
const data = process.env.MSG_DATA ?? 'hello from @msgboard/examples'

console.log('\nmsgboard submit-message')
console.log('─────────────────────────────────────────')

if (!rpcUrl) {
  console.log('\nMSGBOARD_RPC is not set — nothing was submitted.')
  console.log('This demo does real proof-of-work and posts a live message, so it')
  console.log('requires an explicit endpoint to avoid an accidental minutes-long grind.\n')
  console.log('The write flow is:')
  console.log('  1. const status = await client.status()')
  console.log('  2. client.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))')
  console.log('  3. const work = await client.doPoW(category, data)   // grinds a valid nonce')
  console.log('  4. const hash = await client.addMessage(work.message) // node re-verifies the work\n')
  console.log('Run it for real:')
  console.log('  MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 \\')
  console.log('    npm run submit-message --workspace=packages/examples\n')
  process.exit(0)
}

const viemClient = createPublicClient({ transport: http(rpcUrl) })

// viem's EIP1193RequestFn types `method` as a union of known method names rather than
// `string`; the runtime contract is identical, so the cast documents intentional
// provider-agnostic usage (see viem-demo.ts for the same pattern).
const client = new MsgBoardClient(viemClient as unknown as Provider)

console.log(`RPC:      ${rpcUrl}`)
console.log(`category: ${category}`)
console.log(`data:     ${data}\n`)

// 1 + 2: match the node's difficulty so the work we grind will be accepted.
const status = await client.status()
client.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
console.log(`difficulty factors: ${status.workMultiplier}/${status.workDivisor} — grinding (this takes a while)…`)

// 3: the expensive step. Returns { message, stats } once a valid nonce is found.
const work = await client.doPoW(category, data)
console.log(`found valid nonce after ${work.stats.iterations} iterations in ${work.stats.duration}ms`)

// 4: submit. The node re-verifies the proof of work before accepting.
const hash = await client.addMessage(work.message)
console.log(`\nSuccess: posted message — hash ${hash}`)

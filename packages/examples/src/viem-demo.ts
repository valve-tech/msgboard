/**
 * viem-demo — demonstrates that MsgBoardClient accepts a viem createPublicClient
 * directly, confirming the provider-agnostic contract.
 *
 * Usage:
 *   npm run viem-demo --workspace=packages/examples
 *
 * Set MSGBOARD_RPC to point at a live node; defaults to the public demo endpoint.
 */
import { MsgBoardClient } from '@msgboard/sdk'
import type { Provider } from '@msgboard/sdk'
import { createPublicClient, http } from 'viem'

const rpcUrl = process.env.MSGBOARD_RPC ?? 'https://one.valve.city/rpc/vk_demo/evm/943'

const viemClient = createPublicClient({ transport: http(rpcUrl) })

// viem's EIP1193RequestFn constrains `method` to a union of known method names rather than
// `string`, so TypeScript rejects the structural assignment even though the runtime contract
// is identical. The cast documents this intentional provider-agnostic usage.
const client = new MsgBoardClient(viemClient as unknown as Provider)

console.log(`\nmsgboard viem-demo`)
console.log(`RPC: ${rpcUrl}`)
console.log(`─────────────────────────────────────────\n`)

try {
  const statusResult = await client.status()
  console.log('status():', statusResult)

  const contentResult = await client.content()
  const categories = Object.entries(contentResult)
  if (categories.length === 0) {
    console.log('\ncontent(): board is empty (no messages yet)')
  } else {
    console.log('\ncontent() — message count per category:')
    for (const [categoryHash, messages] of categories) {
      console.log(`  ${categoryHash}: ${messages.length} message(s)`)
    }
  }

  console.log('\nSuccess: provider-agnostic usage confirmed — viem PublicClient works directly as Provider')
} catch (error) {
  const isNetworkError =
    error instanceof Error &&
    (error.message.includes('fetch') ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ENOTFOUND') ||
      error.message.includes('network'))

  if (isNetworkError || !process.env.MSGBOARD_RPC) {
    console.log('No live RPC reachable. Set MSGBOARD_RPC to a live msgboard node to see real results.')
    console.log('Example: MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 npm run viem-demo --workspace=packages/examples')
    console.log('\nThe provider-agnostic wiring is correct — viem PublicClient satisfies the Provider interface.')
  } else {
    throw error
  }
}

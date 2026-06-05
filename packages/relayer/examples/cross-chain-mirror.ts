import { Relayer, msgboardContentSource, memoryTtlStore, submitMessageAction } from '@msgboard/relayer'
import { hexToString } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'

// Watches category "announcements" on PulseChain (369) and mirrors each message
// onto the v4 testnet board (943). The action's context targets 943; the source's
// context targets 369 — they are separate Relayers wired by hand.
//
// True cross-node mirroring (read 369, write 943) requires two contexts. The clean
// pattern is a thin read-only relayer on 369 whose action enqueues into a shared
// store that a 943 writer drains. This example shows the single-node shape and
// documents the two-context extension via this comment.
const main = () => {
  const relayer = new Relayer<RPCMessage>({
    node: { rpcUrl: process.env.RPC_943!, chainId: 943 }, // where we WRITE
    mode: process.env.MIRROR_LIVE ? 'live' : 'observe',
    intervalMs: 30_000,
    source: msgboardContentSource({ category: 'announcements' }),
    key: (message) => message.hash,
    store: memoryTtlStore<RPCMessage>({ ttlMs: 60 * 60 * 1000 }),
    action: submitMessageAction<RPCMessage>({
      category: () => 'announcements',
      data: (message) => {
        const text = (() => {
          try {
            return hexToString(message.data)
          } catch {
            return message.data
          }
        })()
        return `mirror: ${text}`
      },
    }),
  })
  relayer.start()
}

main()

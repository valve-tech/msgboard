import type { Hex } from 'viem'
import type { RelayerAction } from '../types.js'

/**
 * Forwards a pre-computed RLP-encoded message to the board without doing
 * proof-of-work. The item must already be a valid RLP hex string produced by
 * the client's `doPoW` → `message` field.
 *
 * Use this with `httpQueueSource` to build a "write for you" relay: clients
 * solve their own proof-of-work locally then POST the result; the relay
 * submits it on-chain.
 */
export const forwardMessageAction = (): RelayerAction<Hex> => ({
  describe: (item) => `forward pre-computed message ${item.slice(0, 10)}…`,
  execute: async (item, context) => {
    const hash = await context.client.addMessage(item)
    return { ok: true, ref: hash }
  },
})

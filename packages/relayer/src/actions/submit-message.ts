import { encodeData } from '@msgboard/sdk'
import type { RelayerAction, RelayerContext } from '../types.js'

export type SubmitMessageActionOptions<T> = {
  /** Derives the category (name or bytes32 hex) for an item. */
  category: (item: T, context: RelayerContext) => string
  /** Derives the message data (text or hex) for an item. */
  data: (item: T, context: RelayerContext) => string
}

/** Posts a proof-of-work message to the board. No wallet or gas required. */
export const submitMessageAction = <T>(
  options: SubmitMessageActionOptions<T>,
): RelayerAction<T> => ({
  describe: (item, context) =>
    `post message category=${options.category(item, context)} data=${options.data(item, context)}`,
  execute: async (item, context) => {
    const category = options.category(item, context)
    const data = encodeData(options.data(item, context))
    const work = await context.client.grind(category, data)
    const hash = await context.client.addMessage(work.message)
    return { ok: true, ref: hash, meta: { stats: work.stats } }
  },
})

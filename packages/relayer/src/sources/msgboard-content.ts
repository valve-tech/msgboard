import { type Hex, stringToHex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import type { RelayerSource } from '../types.js'

export type MsgboardContentSourceOptions = {
  /** A category name (zero-padded to bytes32) or bytes32 hex. Omit to watch all categories. */
  category?: string
}

/** Normalizes a category name or hex into a bytes32 hex category. */
const toCategoryHex = (category: string): Hex => {
  if (category.startsWith('0x') && category.length === 66) return category as Hex
  return stringToHex(category, { size: 32 })
}

/** Polls msgboard content. With no category, flattens messages across every category. */
export const msgboardContentSource = (
  options: MsgboardContentSourceOptions = {},
): RelayerSource<RPCMessage> => {
  const category = options.category ? toCategoryHex(options.category) : undefined
  return {
    poll: async (context) => {
      const content = await context.client.content(category ? { category } : {})
      const groups = Object.values(content)
      return groups.flat()
    },
  }
}

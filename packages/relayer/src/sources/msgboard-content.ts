import { type Hex } from 'viem'
import { categoryHash, type RPCMessage } from '@msgboard/sdk'
import type { RelayerSource } from '../types.js'

export type MsgboardContentSourceOptions = {
  /**
   * Category to watch. Congruent with `@msgboard/sdk` / `MsgBoardClient.doPoW`:
   * - plain string → `keccak256(utf8)` via `categoryHash`
   * - `0x` + 32-byte hex → passed through as-is (Valaxy and others may pre-hash)
   * Omit to watch all categories.
   */
  category?: string
}

/** Normalizes a category name or hex into a bytes32 hex category (SDK-congruent). */
export const toCategoryHex = (category: string): Hex => categoryHash(category)

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

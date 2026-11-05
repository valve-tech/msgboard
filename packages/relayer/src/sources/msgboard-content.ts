import { stringToHex, type Hex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import type { RelayerSource } from '../types.js'

const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/

export type MsgboardContentSourceOptions = {
  /**
   * Category to watch:
   * - plain string → UTF-8 bytes zero-padded to 32 (`stringToHex(..., { size: 32 })`)
   * - `0x` + 32-byte hex → passed through as-is (e.g. `categoryHash('name')` from the SDK)
   * Omit to watch all categories.
   *
   * For keccak buckets, pass the pre-hashed hex — do not expect plaintext strings to be hashed here.
   * Pass an array to watch several categories at once (e.g. both encodings of one name).
   */
  category?: string | string[]
}

/** Normalizes a category name or hex into a bytes32 hex category. */
export const toCategoryHex = (category: string): Hex => {
  if (BYTES32_HEX.test(category)) return category as Hex
  return stringToHex(category, { size: 32 })
}

/** Polls msgboard content. With no category, flattens messages across every category. */
export const msgboardContentSource = (
  options: MsgboardContentSourceOptions = {},
): RelayerSource<RPCMessage> => {
  const categories = options.category
    ? [...new Set([options.category].flat().map(toCategoryHex))]
    : undefined
  return {
    poll: async (context) => {
      const filters = categories ? categories.map((category) => ({ category })) : [{}]
      const contents = await Promise.all(
        filters.map((filter) => context.client.contentAll(filter)),
      )
      return contents.flatMap((content) => Object.values(content).flat())
    },
  }
}

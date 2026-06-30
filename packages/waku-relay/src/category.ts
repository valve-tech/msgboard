import { keccak256, stringToBytes, stringToHex, type Hex } from 'viem'

/**
 * Two category-encoding conventions exist in the MsgBoard codebase and they produce DIFFERENT bytes32
 * for the same channel name — so a relay MUST pin one explicitly or it will silently split a channel:
 *
 *   - 'keccak256' (DEFAULT): keccak256(utf8 bytes of name). This is the `@msgboard/sdk` `categoryHash`
 *      convention, and what the games platform (`@gibs/msgboard-games`) uses.
 *   - 'ascii32': stringToHex(name, { size: 32 }) — the raw ASCII bytes right-padded to 32. This is the
 *      `@msgboard/relayer` `toCategoryHex` convention.
 *
 * Default is 'keccak256'; flip to 'ascii32' with the `--category-encoding ascii32` flag (or
 * RELAY_CATEGORY_ENCODING=ascii32).
 */
export type CategoryEncoding = 'keccak256' | 'ascii32'

export const DEFAULT_CATEGORY_ENCODING: CategoryEncoding = 'keccak256'

const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/

/** True for an already-resolved 32-byte category hash, which is returned as-is under either encoding. */
export function isCategoryHash(name: string): name is Hex {
  return BYTES32_HEX.test(name)
}

/** Resolve a channel NAME (or a 0x… 32-byte hash) to the board's 32-byte category hash. */
export function categoryFor(name: string, encoding: CategoryEncoding = DEFAULT_CATEGORY_ENCODING): Hex {
  if (isCategoryHash(name)) return name
  if (encoding === 'ascii32') {
    const len = stringToBytes(name).length
    if (len > 32) throw new Error(`category '${name}' is ${len} bytes; ascii32 encoding caps at 32`)
    return stringToHex(name, { size: 32 })
  }
  return keccak256(stringToBytes(name))
}

export function parseCategoryEncoding(value: string | undefined): CategoryEncoding {
  if (value === undefined || value === '') return DEFAULT_CATEGORY_ENCODING
  if (value === 'keccak256' || value === 'ascii32') return value
  throw new Error(`invalid category encoding '${value}' (expected 'keccak256' or 'ascii32')`)
}

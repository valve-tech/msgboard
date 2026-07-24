import { hexToString, keccak256, stringToHex, type Hex } from 'viem'
import { isPrintable, stripPadding } from './tree-format'

/**
 * Channel helpers for the IRC-style chat view. The board's model already IS a chat: a category is
 * a channel, and `content()` returns messages grouped by category. These helpers make that legible
 * — the channel name IS the category (direct-encoded so it round-trips to readable text and shows
 * up by name in `categories()`), a message decodes to `{ handle, text }`, and an anonymous message
 * gets a stable handle+color derived from its own hash so the feed reads like a room, not a hexdump.
 */

/** US (unit separator) between an optional handle and the message text inside `data`. */
const SEP = ''

/**
 * A channel name → its 32-byte category hex. Names up to 32 bytes are direct-encoded, so the
 * category round-trips to the readable name (and a human browsing `categories()` sees "lobby",
 * not a hash). Longer names fall back to keccak — still a valid channel, just not self-describing.
 */
export const channelToCategory = (name: string): Hex => {
  const bytes = new TextEncoder().encode(name)
  return (bytes.length <= 32 ? stringToHex(name, { size: 32 }) : keccak256(stringToHex(name))) as Hex
}

/** A category hex → the readable channel name when it was direct-encoded, else the short hash. */
export const categoryToChannel = (category: Hex): string => {
  try {
    const decoded = stripPadding(hexToString(category))
    if (isPrintable(decoded) && decoded.length > 0) return decoded
  } catch {
    /* not utf8 — a hashed category */
  }
  return `${category.slice(0, 10)}…`
}

/** Encode `{ handle, text }` into the message `data` hex. A blank handle posts text alone. */
export const encodeChatData = (text: string, handle?: string): Hex => {
  const body = handle && handle.trim() ? `${handle.trim()}${SEP}${text}` : text
  return stringToHex(body)
}

/** Decode message `data` hex into `{ handle, text }`. `handle` is undefined when none was set. */
export const decodeChatData = (data: Hex): { handle?: string; text: string } => {
  let raw: string
  try {
    raw = hexToString(data)
  } catch {
    return { text: data } // undecodable — show the raw hex rather than drop the line
  }
  const i = raw.indexOf(SEP)
  if (i >= 0) return { handle: raw.slice(0, i), text: raw.slice(i + 1) }
  return { text: raw }
}

/** Palette for anonymous handles — muted, legible on both themes (Tailwind text-* families). */
const HANDLE_COLORS = [
  'text-rose-500',
  'text-amber-500',
  'text-emerald-500',
  'text-sky-500',
  'text-violet-500',
  'text-fuchsia-500',
  'text-teal-500',
  'text-orange-500',
]

/**
 * A stable pseudonym for a message with no explicit handle: `anon-<4 hex>` colored deterministically
 * from the message hash. Same hash → same tag+color every render, so a returning line stays visually
 * consistent without any identity on the board.
 */
export const anonHandle = (hash: Hex): { name: string; color: string } => {
  const h = hash.replace(/^0x/, '')
  const idx = parseInt(h.slice(0, 2) || '0', 16) % HANDLE_COLORS.length
  return { name: `anon-${h.slice(0, 4)}`, color: HANDLE_COLORS[idx]! }
}

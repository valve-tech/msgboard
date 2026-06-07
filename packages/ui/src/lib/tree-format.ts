/**
 * Display helpers for the message tree — specifically for rendering category headers.
 *
 * A category is a 32-byte value. When a client hashes its category name (the common case,
 * keccak256(name)), the bytes decode to unprintable garbage; only direct utf8-encoded
 * categories (e.g. "gasmoneyplease") decode to a readable name. These helpers pick the
 * sensible thing to show and keep long hashes from dominating the tree.
 */

/** True when every character is printable (no control characters). */
export const isPrintable = (text: string): boolean => {
  if (text.length === 0) return false
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Strip trailing NUL padding (zero-padded 32-byte values) then surrounding whitespace. */
export const stripPadding = (text: string): string => {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 0) end -= 1
  return text.slice(0, end).trim()
}

/**
 * The full (untrimmed) value to show/copy for a category header: the decoded name when it
 * is real text, otherwise the raw hex (a hash is not text, so showing the hex beats garbage).
 *
 * @param target the raw category hex
 * @param decoded the utf8 decoding of `target`
 * @param decodedActive whether the decode toggle is on for this node
 */
export const resolveCategoryValue = (target: string, decoded: string, decodedActive: boolean): string => {
  const name = stripPadding(decoded)
  return decodedActive && isPrintable(name) ? name : target
}

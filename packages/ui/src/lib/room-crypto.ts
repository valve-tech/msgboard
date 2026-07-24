import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { base64urlnopad } from '@scure/base'
import {
  bytesToString,
  concat,
  hexToBytes,
  keccak256,
  stringToBytes,
  toHex,
  type Hex,
} from 'viem'
import { decodeChatData, encodeChatData } from './channel'

/**
 * room-crypto — end-to-end encrypted private rooms layered on the public Channel model.
 *
 * The board still carries category-grouped, PoW-stamped messages exactly as public Channel does;
 * the only difference is that the message `data` is ciphertext instead of plaintext. The plaintext
 * INSIDE the envelope is the same `encodeChatData(text, handle)` split public Channel uses, so a
 * decrypted room message re-uses the identical handle/text rendering.
 *
 * CRYPTO (fixed — do not "optimise"):
 *   - Cipher:  XChaCha20-Poly1305 AEAD (@noble/ciphers). 24-byte nonce → random per-message nonces
 *              are collision-safe even with many writers sharing one key (the reason this beats
 *              WebCrypto AES-GCM's 12-byte IV, which is birthday-bound for a shared-key room).
 *   - Room key: 32 random bytes from crypto.getRandomValues. NEVER posted, sent, or logged.
 *   - Nonce:    24 random bytes from crypto.getRandomValues, FRESH per message.
 *   - Category: keccak256("msgboard:eroom:v1" || key). Domain-separated + key-bound, so the room is
 *              unlinkable to any plaintext name; only key-holders can compute where to read/post.
 *   - AAD:      the category bytes. Binds a ciphertext to its room — lifting it into another
 *              category makes the Poly1305 verify fail, so messages can't be replayed cross-room.
 *   - Envelope: data = 0x01 (version) || nonce(24) || ciphertext(+16-byte Poly1305 tag), hex-encoded.
 *
 * Trust model (surfaced honestly in the UI): this is real authenticated E2E encryption and the room
 * is name-unlinkable, BUT the single shared key means any invite-holder can read AND post as any
 * handle (no per-sender auth), there is NO forward secrecy (a leaked key exposes all past+future
 * messages — mint a new room to rotate), and METADATA (activity, timing, sizes, PoW) stays public.
 */

/** Domain-separation tag mixed into the category derivation. Bump the version to break linkage. */
const CATEGORY_DOMAIN = 'msgboard:eroom:v1'

/** Envelope format version. Any other leading byte decrypts to `undecryptable` (never garbage). */
const ENVELOPE_VERSION = 0x01

/** XChaCha20-Poly1305 fixed sizes. */
const KEY_BYTES = 32
const NONCE_BYTES = 24
const TAG_BYTES = 16

/** Invite string scheme. `msgboard-room:v1:<base64url(key)>[:<base64url(utf8 name)>]`. */
const INVITE_PREFIX = 'msgboard-room'
const INVITE_VERSION = 'v1'

/** A failed decrypt: wrong key, tampered bytes, wrong version, or wrong-room AAD. Never garbage. */
export interface Undecryptable {
  undecryptable: true
}

export type DecryptedMessage = { handle?: string; text: string } | Undecryptable

export const isUndecryptable = (m: DecryptedMessage): m is Undecryptable =>
  (m as Undecryptable).undecryptable === true

/** Mint a fresh 32-byte room key from the CSPRNG. This is the ONLY secret; guard the invite. */
export function mintRoomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES))
}

/**
 * The board category for a room = keccak256("msgboard:eroom:v1" || key). Deterministic (same key →
 * same category, so all holders converge) and one-way (the category leaks nothing about the key or
 * the name). Different keys → different categories.
 */
export function deriveCategory(key: Uint8Array): Hex {
  assertKey(key)
  return keccak256(concat([stringToBytes(CATEGORY_DOMAIN), key]))
}

/**
 * Encrypt one message for a room. `category` MUST be `deriveCategory(key)` — it is bound in as AAD.
 * Returns the hex envelope to drop into board `data` (still posted through the PoW worker seam).
 */
export function encryptMessage(
  key: Uint8Array,
  category: Hex,
  text: string,
  handle?: string,
): Hex {
  assertKey(key)
  const plaintext = hexToBytes(encodeChatData(text, handle))
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const aad = hexToBytes(category)
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
  return toHex(concat([new Uint8Array([ENVELOPE_VERSION]), nonce, ciphertext]))
}

/**
 * Decrypt one board `data` envelope. Wrong key / tampered ciphertext / wrong version / wrong-room
 * AAD → the AEAD verify (or a structural check) fails and we return `{ undecryptable: true }`.
 * NEVER throws, NEVER returns garbage plaintext.
 */
export function decryptMessage(key: Uint8Array, category: Hex, dataHex: Hex): DecryptedMessage {
  try {
    assertKey(key)
    const bytes = hexToBytes(dataHex)
    // version(1) + nonce(24) + at least the Poly1305 tag(16)
    if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES) return { undecryptable: true }
    if (bytes[0] !== ENVELOPE_VERSION) return { undecryptable: true }
    const nonce = bytes.slice(1, 1 + NONCE_BYTES)
    const ciphertext = bytes.slice(1 + NONCE_BYTES)
    const aad = hexToBytes(category)
    const plaintext = xchacha20poly1305(key, nonce, aad).decrypt(ciphertext)
    return decodeChatData(toHex(plaintext))
  } catch {
    return { undecryptable: true }
  }
}

/**
 * Encode a copy-pasteable invite. The key travels in base64url (no padding); an optional display
 * name (LOCAL metadata only — it never touches the board) rides along base64url-encoded too.
 */
export function encodeInvite(key: Uint8Array, name?: string): string {
  assertKey(key)
  const parts = [INVITE_PREFIX, INVITE_VERSION, base64urlnopad.encode(key)]
  if (name && name.length) parts.push(base64urlnopad.encode(stringToBytes(name)))
  return parts.join(':')
}

/**
 * Parse + validate an invite. Returns `{ key, name? }` or `null` for ANYTHING malformed — wrong
 * prefix/version, wrong part count, non-base64url, or a key that isn't exactly 32 bytes. NEVER throws.
 */
export function parseInvite(str: string): { key: Uint8Array; name?: string } | null {
  if (typeof str !== 'string') return null
  const parts = str.trim().split(':')
  if (parts.length < 3 || parts.length > 4) return null
  if (parts[0] !== INVITE_PREFIX || parts[1] !== INVITE_VERSION) return null
  try {
    const key = base64urlnopad.decode(parts[2]!)
    if (key.length !== KEY_BYTES) return null
    let name: string | undefined
    if (parts.length === 4) {
      const decoded = bytesToString(base64urlnopad.decode(parts[3]!))
      if (decoded.length) name = decoded
    }
    return name != null ? { key, name } : { key }
  } catch {
    return null
  }
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error('room key must be 32 bytes')
  }
}

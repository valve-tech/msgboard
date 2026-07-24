/**
 * dm-crypto — per-recipient, end-to-end encrypted Direct Messages over the public board.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * A hybrid public-key sealed-box scheme. A message is encrypted ONCE under a random symmetric
 * data-encryption key (the DEK), and that DEK is then *wrapped* separately for each named
 * recipient using an ephemeral X25519 key agreement. Only a holder of a named recipient's
 * X25519 private key can unwrap the DEK and read the body. This is the classic "envelope
 * encryption" / libsodium `crypto_box_seal`-style construction, generalised to N recipients.
 *
 * It intentionally MIRRORS the style of room-crypto.ts (same AEAD, same "fail closed to
 * `undecryptable`, never throw, never emit garbage" contract, same board-`data` hex envelope),
 * but where room-crypto uses ONE shared symmetric key for a whole room, dm-crypto uses
 * PUBLIC-KEY encryption to specific people — so there is no shared secret to leak, the sender is
 * cryptographically fixed to a keypair, and every message gets per-message forward secrecy.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * PRIMITIVES (all audited @noble libraries; keccak256 from viem) — FIXED, do not "optimise":
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *   • Key agreement : X25519  (`x25519` from @noble/curves/ed25519).
 *   • KDF           : HKDF-SHA256 (`hkdf` + `sha256` from @noble/hashes). Domain-separated by a
 *                     versioned `info` label so no derived key collides with any other use.
 *   • AEAD          : XChaCha20-Poly1305 (`xchacha20poly1305` from @noble/ciphers). Its 24-byte
 *                     nonce makes fresh random nonces collision-safe (no counter state needed),
 *                     the same reason room-crypto chose it over 12-byte-IV AES-GCM.
 *   • keyId hashing : keccak256 (from viem), to locate a recipient's wrap without publishing the
 *                     full recipient pubkey on the wire.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * ENVELOPE (then hex-encoded into board `data`) — every length prefix is unsigned big-endian:
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *   version(1 = 0x01)
 *   ephemeralPub(32)                 ← one fresh X25519 public key per MESSAGE (forward secrecy)
 *   bodyNonce(24)
 *   recipientCount(uint16 BE)
 *   recipientCount × {
 *     keyId(8)                       ← keccak256(recipientPub)[0..8): locate-your-wrap, not the key
 *     wrapNonce(24)
 *     wrappedLen(uint16 BE)
 *     wrapped(wrappedLen)            ← DEK sealed under wrapKey, AAD = recipientPub
 *   }
 *   bodyCiphertext(rest)             ← encodeChatData(text, handle) sealed under DEK, AAD = category
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * KEYS & AAD BINDING
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *   • DEK       : 32 random bytes (crypto.getRandomValues), one per message. Encrypts the body.
 *   • ephemeral : one fresh X25519 keypair per message. shared_i = X25519(ephemeralPriv, recipientPub_i).
 *   • wrapKey_i : HKDF-SHA256(ikm = shared_i, info = "msgboard:dm:wrap:v1" || category, len = 32).
 *                 Mixing `category` into the KDF binds a wrap to its conversation.
 *   • body AAD  : the category bytes → a body ciphertext can't be lifted into another conversation.
 *   • wrap AAD  : the recipient's own pubkey → a wrap can't be retargeted to a different recipient.
 *   Any AEAD tag mismatch (wrong key / tampering / wrong AAD / wrong category) fails closed.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * TRUST MODEL (surfaced honestly in the UI):
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *   ✓ Real E2E confidentiality + integrity to the NAMED recipients only.
 *   ✓ Per-message forward secrecy: each message uses a throwaway ephemeral key; compromising one
 *     message's ephemeral/DEK does not expose any other message. (Recipient LONG-TERM keys are
 *     still long-term — losing one exposes all messages sent to it; this is sender FS, the strong
 *     half of the property, exactly like crypto_box_seal.)
 *   ✗ Metadata is PUBLIC: the board reveals that a conversation exists in this derived category,
 *     plus timing, sizes, recipient COUNT, and PoW stamps. Anyone who knows the member pubkeys can
 *     recompute the category and see the traffic (not read it).
 *   ✗ Recipients are fixed at send time. There is no group re-key / revocation (a later tier).
 *   ✗ No sender authentication beyond "someone who chose the recipient set": the sender pubkey is
 *     added to the recipient set so the sender can read their own message, but nothing signs WHO
 *     sent it. (An authenticated-sender tier would add a signature or a static-static DH.)
 */
import { concat, hexToBytes, keccak256, stringToBytes, toHex, type Hex } from 'viem'
import { x25519 } from '@noble/curves/ed25519'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { base64urlnopad } from '@scure/base'
import { encodeChatData, decodeChatData } from './channel'
import type { ZkIdentity } from './zk-identity'

// ── fixed sizes & domain-separation labels ───────────────────────────────────────────────────

/** Envelope format version. Any other leading byte ⇒ `undecryptable` (never garbage). */
const ENVELOPE_VERSION = 0x01
const PUBKEY_BYTES = 32
const DEK_BYTES = 32
const NONCE_BYTES = 24
const KEY_ID_BYTES = 8
/** XChaCha20-Poly1305 authentication tag length. */
const TAG_BYTES = 16
/** A wrapped DEK is exactly DEK(32) + tag(16) = 48 bytes; validated on open. */
const WRAPPED_DEK_BYTES = DEK_BYTES + TAG_BYTES

/**
 * Defensive caps so a malformed/hostile envelope can never make `openMessage` allocate wildly or
 * spin. A DM to hundreds of recipients is already far past any real use, and the whole board `data`
 * field is small; these bounds simply fail such inputs closed rather than process them.
 */
const MAX_RECIPIENTS = 512
const MAX_ENVELOPE_BYTES = 1 << 20 // 1 MiB

/** HKDF `info` label deriving a recipient's per-message wrap key (mixed with the category). */
const WRAP_INFO = 'msgboard:dm:wrap:v1'
/** HKDF info for the per-message wrap locator (keyId) — derived from the ephemeral shared secret. */
const KEY_ID_INFO = 'msgboard:dm:keyid:v1'
/** Domain tag for the conversation category (see {@link dmCategory}). */
const CATEGORY_DOMAIN = 'msgboard:dm:v1'
/** HKDF `info` label deriving a stable X25519 enc keypair from a local Zk identity. */
const ENC_KEY_INFO = 'msgboard/dm/x25519/v1'

/** Contact-card string scheme: `msgboard-contact:v1:<b64url(pubkey 32B)>[:<b64url(utf8 label)>]`. */
const CONTACT_PREFIX = 'msgboard-contact'
const CONTACT_VERSION = 'v1'

// ── result type & guard (mirrors room-crypto's contract) ─────────────────────────────────────

/** A failed open: not a recipient, wrong key, tampered bytes, bad version, or wrong category. */
export interface Undecryptable {
  undecryptable: true
}

/** The successful plaintext, or the sealed `Undecryptable` marker. Never garbage on failure. */
export type OpenedMessage = { handle?: string; text: string } | Undecryptable

/** Type guard: did an {@link openMessage} call fail to decrypt? */
export const isUndecryptable = (m: OpenedMessage): m is Undecryptable =>
  (m as Undecryptable).undecryptable === true

/** A parsed contact card: an X25519 public key (a DM address) + an optional local display label. */
export interface Contact {
  pubkey: Uint8Array
  label?: string
}

// ── enc-keypair derivation from a local identity ─────────────────────────────────────────────

/** An X25519 encryption keypair usable as a DM address. */
export interface EncKeypair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

/** A field-element secret → 32 big-endian bytes (matches zk-identity's recovery-key encoding). */
function fieldToBytes32BE(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  // Both Semaphore secrets are BN254 scalars (< 2^254), so they always fit; guard for symmetry.
  if (v !== 0n) throw new Error('identity secret exceeds 32 bytes')
  return out
}

/**
 * Derive a STABLE X25519 encryption keypair from a local Semaphore identity (nullifier + trapdoor).
 *
 * This gives the walletless, browser-local identity (zk-identity.ts) an enc keypair for DMs, exactly
 * as the wallet-derived path (wallet-identity.ts) already produces one — so a user with EITHER kind
 * of identity has a DM address. Deterministic: the same identity always yields the same keypair, so
 * a contact card stays valid across sessions as long as the identity is the same.
 *
 * Derivation: HKDF-SHA256 over the identity secrets (serialised as nullifier‖trapdoor, 32 BE bytes
 * each) with a versioned, DM-specific `info` label. The label domain-separates this key from the
 * Semaphore secrets themselves and from any wallet-path key — no derived secret reveals another.
 * X25519 clamps the 32-byte scalar internally, so any 32-byte HKDF output is a valid private key.
 */
export function deriveEncKeypair(identity: ZkIdentity): EncKeypair {
  const ikm = concat([fieldToBytes32BE(identity.nullifier), fieldToBytes32BE(identity.trapdoor)])
  const privateKey = hkdf(sha256, ikm, undefined, ENC_KEY_INFO, 32)
  const publicKey = x25519.getPublicKey(privateKey)
  return { publicKey, privateKey }
}

// ── contact cards (your shareable DM address) ────────────────────────────────────────────────

/**
 * Encode a shareable contact card = your X25519 public key, with an optional human label. The label
 * is LOCAL convenience only (it rides in the card so a recipient sees a name), never posted to the
 * board. `parseContact(encodeContact(pk, l))` round-trips exactly.
 */
export function encodeContact(pubkey: Uint8Array, label?: string): string {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== PUBKEY_BYTES) {
    throw new Error('contact pubkey must be 32 bytes')
  }
  const parts = [CONTACT_PREFIX, CONTACT_VERSION, base64urlnopad.encode(pubkey)]
  if (label && label.length) parts.push(base64urlnopad.encode(stringToBytes(label)))
  return parts.join(':')
}

/**
 * Parse + STRICTLY validate a contact card. Returns `{ pubkey, label? }` or `null` for ANYTHING
 * malformed — wrong prefix/version, wrong part count, non-base64url, or a key that isn't exactly
 * 32 bytes. NEVER throws. (Same fail-safe posture as room-crypto's `parseInvite`.)
 */
export function parseContact(str: string): Contact | null {
  if (typeof str !== 'string') return null
  const parts = str.trim().split(':')
  if (parts.length < 3 || parts.length > 4) return null
  if (parts[0] !== CONTACT_PREFIX || parts[1] !== CONTACT_VERSION) return null
  try {
    const pubkey = base64urlnopad.decode(parts[2]!)
    if (pubkey.length !== PUBKEY_BYTES) return null
    if (parts.length === 4) {
      const label = new TextDecoder('utf-8', { fatal: false }).decode(base64urlnopad.decode(parts[3]!))
      return label.length ? { pubkey, label } : { pubkey }
    }
    return { pubkey }
  } catch {
    return null
  }
}

// ── conversation category ────────────────────────────────────────────────────────────────────

/** Lexicographic (byte-wise) comparison of two Uint8Arrays. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!
  }
  return a.length - b.length
}

/**
 * The board category a DM conversation lives in = keccak256("msgboard:dm:v1" || sorted(pubkeys)).
 *
 * Sorting the member pubkeys lexicographically makes the category independent of argument order, so
 * every participant derives the SAME category from the same member set (and converges on where to
 * read/post) regardless of who they list first. It is unlinkable to identities UNLESS you already
 * know the member pubkeys — the same disclosure room-crypto's derived category makes for a key.
 * Different member sets ⇒ different categories.
 */
export function dmCategory(pubkeys: Uint8Array[]): Hex {
  const sorted = [...pubkeys].sort(compareBytes)
  return keccak256(concat([stringToBytes(CATEGORY_DOMAIN), ...sorted]))
}

// ── little-helpers for fixed-width big-endian framing ─────────────────────────────────────────

/** A uint16 big-endian (0..65535) as 2 bytes. Throws if out of range (never happens post-cap). */
function u16BE(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('u16 out of range')
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff])
}

/**
 * keyId — a PER-MESSAGE locator for a recipient's wrap, derived from the ephemeral shared secret,
 * NOT from the recipient's public key. (Audit MEDIUM: a pubkey-derived keyId is a global, stable
 * correlator — anyone holding your contact card could compute it once and scan the whole public
 * board to enumerate every DM you send or receive, across conversations whose other members they
 * don't even know. Deriving it from `shared_i` makes it change every message, so it links nothing.)
 * A recipient recomputes it from their own `shared = X25519(myPriv, ephemeralPub)` while scanning.
 */
function keyIdFromShared(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, KEY_ID_INFO, KEY_ID_BYTES)
}

/** Constant-ish equality for two same-length byte spans (keyId matching; not secret-dependent). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** Dedupe a list of pubkeys by value, preserving first-seen order. */
function dedupePubkeys(pubkeys: Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>()
  const out: Uint8Array[] = []
  for (const pk of pubkeys) {
    const k = toHex(pk)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(pk)
    }
  }
  return out
}

// ── seal ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Seal one message to a set of recipients. Returns the hex envelope to drop into board `data`
 * (still posted through the PoW worker seam — this function is pure crypto, no I/O).
 *
 * The sender's own pubkey is ALWAYS added to the recipient set (deduped) so the sender can read
 * back their own sent messages from the public board. `category` MUST equal
 * `dmCategory([...recipientPubs, senderPub])` for the recipients to find + open it — it is bound in
 * as the body AEAD's AAD and mixed into every wrap key.
 *
 * @param senderPriv    the sender's X25519 private key (only its PUBLIC half is written, via the set)
 * @param senderPub     the sender's X25519 public key (added to the recipient set)
 * @param recipientPubs the intended recipients' X25519 public keys
 * @param category      the conversation category (see {@link dmCategory})
 * @param text          the message body
 * @param handle        an optional display handle carried inside the encrypted body
 */
export function sealMessage(
  senderPriv: Uint8Array,
  senderPub: Uint8Array,
  recipientPubs: Uint8Array[],
  category: Hex,
  text: string,
  handle?: string,
): Hex {
  // senderPriv is accepted for API symmetry and future authenticated-sender tiers; the sealed-box
  // construction needs only the PUBLIC keys of the recipient set plus a fresh ephemeral key.
  void senderPriv

  // (1) Random DEK; encrypt the body once under it. AAD = category binds the body to this convo.
  const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES))
  const body = hexToBytes(encodeChatData(text, handle))
  const bodyNonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const categoryBytes = hexToBytes(category)
  const bodyCiphertext = xchacha20poly1305(dek, bodyNonce, categoryBytes).encrypt(body)

  // (2) Recipient set = dedupe(recipientPubs ∪ {senderPub}) so the sender can read their own message.
  const recipients = dedupePubkeys([...recipientPubs, senderPub])

  // (3) ONE fresh ephemeral X25519 keypair for the whole message → per-message forward secrecy.
  const ephemeralPriv = x25519.utils.randomPrivateKey()
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv)

  // (4) Wrap the DEK separately for each recipient.
  const wrapBlocks: Uint8Array[] = []
  for (const recipientPub of recipients) {
    const shared = x25519.getSharedSecret(ephemeralPriv, recipientPub)
    // Mix `category` into the KDF so a wrap key is bound to this conversation.
    const wrapInfo = concat([stringToBytes(WRAP_INFO), categoryBytes])
    const wrapKey = hkdf(sha256, shared, undefined, wrapInfo, 32)
    const wrapNonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
    // AAD = recipientPub binds this wrap to that exact recipient (can't be retargeted).
    const wrapped = xchacha20poly1305(wrapKey, wrapNonce, recipientPub).encrypt(dek)
    // Per-message keyId from the shared secret (not the pubkey) — unlinkable across messages.
    wrapBlocks.push(
      concat([keyIdFromShared(shared), wrapNonce, u16BE(wrapped.length), wrapped]),
    )
  }

  // (5) Assemble the envelope and hex-encode it.
  return toHex(
    concat([
      new Uint8Array([ENVELOPE_VERSION]),
      ephemeralPub,
      bodyNonce,
      u16BE(recipients.length),
      ...wrapBlocks,
      bodyCiphertext,
    ]),
  )
}

// ── open ─────────────────────────────────────────────────────────────────────────────────────

/** A cursor over the envelope bytes with strict, throw-free bounds checking. */
class Reader {
  private off = 0
  constructor(private readonly buf: Uint8Array) {}
  /** Remaining unread bytes. */
  get rest(): Uint8Array {
    return this.buf.subarray(this.off)
  }
  /** True if at least `n` bytes remain. */
  has(n: number): boolean {
    return this.off + n <= this.buf.length
  }
  /** Read `n` bytes, advancing the cursor. Caller must `has(n)` first. */
  take(n: number): Uint8Array {
    const out = this.buf.subarray(this.off, this.off + n)
    this.off += n
    return out
  }
  /** Read a uint16 big-endian, advancing 2 bytes. Caller must `has(2)` first. */
  takeU16(): number {
    const hi = this.buf[this.off]!
    const lo = this.buf[this.off + 1]!
    this.off += 2
    return (hi << 8) | lo
  }
}

/**
 * Open a board `data` envelope addressed (among others) to `myPub`. Returns the decrypted
 * `{ handle?, text }` or the sealed `{ undecryptable: true }` marker.
 *
 * Fails CLOSED — returns `undecryptable`, never throws, never leaks partial/garbage plaintext — on
 * ANY of: not a recipient (no matching keyId), truncated/oversized/malformed framing, wrong version,
 * a wrap that won't unseal (wrong key / tampered / wrong recipient-AAD), or a body that won't unseal
 * (tampered / wrong category-AAD).
 *
 * @param myPriv   my X25519 private key
 * @param myPub    my X25519 public key (used to locate my wrap via its keyId, and as the wrap AAD)
 * @param category the conversation category (the body's AEAD AAD)
 * @param dataHex  the hex envelope from board `data`
 */
export function openMessage(
  myPriv: Uint8Array,
  myPub: Uint8Array,
  category: Hex,
  dataHex: Hex,
): OpenedMessage {
  try {
    // Bound the input BEFORE materializing it (a hex envelope is 2 chars/byte + the "0x" prefix),
    // so a hostile oversized `data` can't force a large allocation on the decode.
    if (dataHex.length > MAX_ENVELOPE_BYTES * 2 + 2) return { undecryptable: true }
    const bytes = hexToBytes(dataHex)
    if (bytes.length > MAX_ENVELOPE_BYTES) return { undecryptable: true }

    const r = new Reader(bytes)
    // header: version(1) + ephemeralPub(32) + bodyNonce(24) + recipientCount(2)
    if (!r.has(1 + PUBKEY_BYTES + NONCE_BYTES + 2)) return { undecryptable: true }
    if (r.take(1)[0] !== ENVELOPE_VERSION) return { undecryptable: true }
    const ephemeralPub = r.take(PUBKEY_BYTES)
    const bodyNonce = r.take(NONCE_BYTES)
    const recipientCount = r.takeU16()
    if (recipientCount > MAX_RECIPIENTS) return { undecryptable: true }

    // My per-message keyId comes from the ephemeral shared secret (not my pubkey). X25519 throws on
    // a low-order / all-zero `ephemeralPub` (noble contributory check) → caught below → undecryptable.
    const categoryBytes = hexToBytes(category)
    const shared = x25519.getSharedSecret(myPriv, ephemeralPub)
    const myKeyId = keyIdFromShared(shared)

    // Scan the wrap table, validating every block's framing so the cursor lands exactly at the body.
    // Collect the blocks whose keyId matches mine (normally one; keep any others so a decoy block
    // bearing my keyId — 2^-64 to grind — can't deny a genuine read).
    const myWraps: { wrapNonce: Uint8Array; wrapped: Uint8Array }[] = []
    for (let i = 0; i < recipientCount; i++) {
      if (!r.has(KEY_ID_BYTES + NONCE_BYTES + 2)) return { undecryptable: true }
      const keyId = r.take(KEY_ID_BYTES)
      const wrapNonce = r.take(NONCE_BYTES)
      const wrappedLen = r.takeU16()
      if (!r.has(wrappedLen)) return { undecryptable: true }
      const wrapped = r.take(wrappedLen)
      // A genuine wrap is exactly DEK(32)+tag(16); ignore mis-sized decoys.
      if (bytesEqual(keyId, myKeyId) && wrapped.length === WRAPPED_DEK_BYTES) {
        myWraps.push({ wrapNonce, wrapped })
      }
    }
    if (myWraps.length === 0) return { undecryptable: true } // not a recipient of this message

    const bodyCiphertext = r.rest
    // A genuine body is at least the AEAD tag (empty plaintext still carries a 16-byte tag).
    if (bodyCiphertext.length < TAG_BYTES) return { undecryptable: true }

    const wrapInfo = concat([stringToBytes(WRAP_INFO), categoryBytes])
    const wrapKey = hkdf(sha256, shared, undefined, wrapInfo, 32)
    // Try each matching wrap; accept the first that both unseals AND whose DEK opens the body.
    for (const w of myWraps) {
      try {
        // AAD = myPub — the same binding used at seal time. Any mismatch fails the Poly1305 tag.
        const dek = xchacha20poly1305(wrapKey, w.wrapNonce, myPub).decrypt(w.wrapped)
        const plaintext = xchacha20poly1305(dek, bodyNonce, categoryBytes).decrypt(bodyCiphertext)
        return decodeChatData(toHex(plaintext))
      } catch {
        /* this candidate didn't open — try the next block with a matching keyId */
      }
    }
    return { undecryptable: true }
  } catch {
    // ANY failure — bad hex, AEAD tag mismatch, curve error — collapses to a sealed marker.
    return { undecryptable: true }
  }
}

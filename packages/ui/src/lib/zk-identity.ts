/**
 * zk-identity — the local, WALLET-INDEPENDENT Semaphore-style identity for ZK Chat.
 *
 * A ZkIdentity is two random field-element secrets (`nullifier`, `trapdoor`). Its
 * commitment — `Poseidon(Poseidon(nullifier, trapdoor))` (Semaphore v2) — is computed in
 * the Web Worker (Poseidon is WASM). The secrets themselves are generated and persisted
 * HERE, on the main thread (pure `crypto.getRandomValues` — no heavy crypto), in
 * localStorage, keyed independently of any wallet address.
 *
 * UNLINKABILITY TO A WALLET: this identity is never derived from, and never carries, a
 * wallet address or signature. The board post is PoW-gated (no signer), the proof reveals
 * only the group root + a nullifierHash, and the author tag shown in the feed is derived
 * from that nullifierHash — so two posts by the same anonymous member look consistent
 * within an epoch, but nothing links them to an on-chain address.
 */
import { toHex, sha256 } from 'viem'
import { createBase58check } from '@scure/base'
import { SNARK_FIELD } from './zk-post'

/** A member's secret identity. Keep both secrets private; publish only the commitment. */
export type ZkIdentity = { nullifier: bigint; trapdoor: bigint }

/** The localStorage shape (bigints can't be JSON'd — store decimal strings). */
type StoredIdentity = { nullifier: string; trapdoor: string }

const STORAGE_KEY = 'zkchat:identity:v1'

/** A uniformly random field element (mirrors `randomField` in zk-msgboard.ts). */
const randomField = (): bigint => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return BigInt(toHex(bytes)) % SNARK_FIELD
}

/** Generates a fresh random identity (two field-element secrets). */
export const randomIdentity = (): ZkIdentity => ({
  nullifier: randomField(),
  trapdoor: randomField(),
})

/**
 * Loads the persisted identity, generating + persisting a fresh one on first use (or if the
 * stored value is missing/corrupt). Always returns a usable identity.
 */
export const loadOrCreateIdentity = (): ZkIdentity => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity
      const nullifier = BigInt(parsed.nullifier)
      const trapdoor = BigInt(parsed.trapdoor)
      if (nullifier > 0n && trapdoor > 0n) return { nullifier, trapdoor }
    }
  } catch {
    /* fall through to regenerate */
  }
  const identity = randomIdentity()
  persistIdentity(identity)
  return identity
}

/** Persists an identity to localStorage (best-effort; storage may be unavailable). */
export const persistIdentity = (identity: ZkIdentity): void => {
  try {
    const stored: StoredIdentity = {
      nullifier: identity.nullifier.toString(),
      trapdoor: identity.trapdoor.toString(),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    /* localStorage may be unavailable */
  }
}

/** Rotates to a brand-new identity (a "new pseudonym") and persists it. */
export const rotateIdentity = (): ZkIdentity => {
  const identity = randomIdentity()
  persistIdentity(identity)
  return identity
}

// ── recovery key: the ONE copy-pasteable secret that IS this identity ─────────────────
//
// THE ENCODING. A ZkIdentity is two field-element secrets (nullifier, trapdoor), each a
// BN254 scalar in [1, SNARK_FIELD) — i.e. < 2^254, so each fits exactly in 32 big-endian
// bytes. We serialise `version(1) ‖ nullifier(32 BE) ‖ trapdoor(32 BE)` = 65 bytes and
// Base58Check-encode it (Bitcoin alphabet, 4-byte double-SHA256… — here the single-hash
// checksum @scure/base's createBase58check provides). Why Base58Check and not a BIP39
// mnemonic: a mnemonic is a clean bijection only for *round* entropy sizes (16–32 B) with a
// bit-checksum; two independent 254-bit field elements are NOT a round entropy size (all-
// 256-bit patterns aren't valid — they must be range-checked < field), so a mnemonic here
// would be a hacked-together 48-word double-phrase, not an honest bijection. Base58Check is
// compact (~93 chars, one token), copy-paste-robust, alphabet avoids look-alike chars, and
// its checksum catches typos on import. The mapping is an EXACT round-trip of the real
// secrets — nothing is derived, hashed-away, or approximated.
const RECOVERY_VERSION = 1
/** Human label so the string is self-identifying; stripped (case-insensitively) on import. */
const RECOVERY_PREFIX = 'whisper1'
/** Base58Check codec with viem's SHA-256 as the checksum hash (no extra crypto dep). */
const b58check = createBase58check((data: Uint8Array) => sha256(data, 'bytes'))

/** A field-element secret → 32 big-endian bytes (throws if it somehow exceeds 2^256). */
const toBytes32BE = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error('secret exceeds 32 bytes')
  return out
}

/** 32 big-endian bytes → bigint. */
const fromBytes32BE = (b: Uint8Array): bigint => {
  let v = 0n
  for (const byte of b) v = (v << 8n) | BigInt(byte)
  return v
}

/**
 * Serialises an identity to its recovery key: the ONE secret string that IS this pseudonym.
 * Anyone holding it can post as you. It is a LOCAL secret — never posted, never sent.
 * `importIdentity(exportIdentity(id))` reproduces `id` exactly.
 */
export const exportIdentity = (id: ZkIdentity): string => {
  const payload = new Uint8Array(65)
  payload[0] = RECOVERY_VERSION
  payload.set(toBytes32BE(id.nullifier), 1)
  payload.set(toBytes32BE(id.trapdoor), 33)
  return `${RECOVERY_PREFIX}${b58check.encode(payload)}`
}

/**
 * Parses a recovery key back into an identity, or returns null on ANY invalid input:
 * bad Base58/checksum, wrong length/version, or a secret out of the SNARK field. Never
 * throws. Tolerant of surrounding whitespace and the optional `whisper1` label.
 */
export const importIdentity = (str: string): ZkIdentity | null => {
  try {
    const trimmed = str.trim()
    const body = trimmed.toLowerCase().startsWith(RECOVERY_PREFIX)
      ? trimmed.slice(RECOVERY_PREFIX.length)
      : trimmed
    const bytes = b58check.decode(body)
    if (bytes.length !== 65) return null
    if (bytes[0] !== RECOVERY_VERSION) return null
    const nullifier = fromBytes32BE(bytes.subarray(1, 33))
    const trapdoor = fromBytes32BE(bytes.subarray(33, 65))
    // Range-check both secrets in the BN254 scalar field (reject 0 and >= field).
    if (nullifier <= 0n || nullifier >= SNARK_FIELD) return null
    if (trapdoor <= 0n || trapdoor >= SNARK_FIELD) return null
    return { nullifier, trapdoor }
  } catch {
    return null
  }
}

/** Imports a recovery key AND persists it as the active identity, or null if invalid. */
export const importAndPersistIdentity = (str: string): ZkIdentity | null => {
  const id = importIdentity(str)
  if (id) persistIdentity(id)
  return id
}

// ── anonymous author presentation, derived from the nullifierHash ────────────────────

const ADJECTIVES = [
  'anon', 'cipher', 'shadow', 'silent', 'hidden', 'masked', 'phantom', 'covert',
  'veiled', 'ghost', 'quiet', 'unseen', 'cloaked', 'stealth', 'nameless', 'obscure',
]
const NOUNS = [
  'fox', 'raven', 'wolf', 'owl', 'lynx', 'moth', 'heron', 'otter',
  'ibis', 'stoat', 'crane', 'vole', 'wren', 'skua', 'tern', 'shrew',
]
const HUES = [8, 200, 150, 280, 340, 40, 100, 250, 320, 180, 60, 300]

/** A stable, wallet-unlinkable presentation for an anonymous member, from its nullifierHash. */
export type AuthorTag = { handle: string; short: string; hue: number }

/**
 * Derives a deterministic, human-friendly pseudonym + colour from a nullifierHash. The same
 * anonymous member (same identity + epoch) always renders identically; different members
 * render differently; nothing here is invertible to a wallet.
 */
export const authorTag = (nullifierHash: string): AuthorTag => {
  let n: bigint
  try {
    n = BigInt(nullifierHash)
  } catch {
    n = 0n
  }
  const adjective = ADJECTIVES[Number(n % BigInt(ADJECTIVES.length))]
  const noun = NOUNS[Number((n / 16n) % BigInt(NOUNS.length))]
  const hue = HUES[Number((n / 256n) % BigInt(HUES.length))]
  const short = n.toString(16).padStart(4, '0').slice(-4)
  return { handle: `${adjective}-${noun}`, short, hue }
}

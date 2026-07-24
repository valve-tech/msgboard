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
import { toHex } from 'viem'
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

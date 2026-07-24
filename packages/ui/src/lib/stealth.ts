/**
 * stealth — ERC-5564 stealth addresses + ERC-6538 meta-address registry over secp256k1 (schemeId 1).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * The off-chain half of StealthMessenger.sol: the "send a private message to an address" crypto.
 * A recipient publishes a stealth META-ADDRESS (a spending pubkey + a viewing pubkey). A sender,
 * knowing only that public meta-address, derives a FRESH one-time stealth address per message plus
 * a one-time ephemeral pubkey. The recipient — and only the recipient, using their private VIEWING
 * key — can scan the on-chain announcements, cheaply reject the ~255/256 that aren't theirs via the
 * 1-byte view tag, and recognise the ones that are. Nobody else can link a stealth address to the
 * recipient. To actually spend/decrypt, the recipient combines their SPENDING key with the derived
 * shared secret to get the stealth address's private key.
 *
 * This mirrors dm-crypto.ts's conventions (audited @noble libraries, XChaCha20-Poly1305 for the
 * body, HKDF-SHA256 domain-separated by a versioned label) but solves a different problem: dm-crypto
 * hides the message CONTENT from non-recipients while the conversation's existence + members are
 * derivable; stealth addressing hides WHO THE RECIPIENT IS from everyone but the recipient.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * THE ERC-5564 secp256k1 SCHEME (schemeId 1) — exactly as implemented here:
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *   Recipient keys: spending (p_spend, P_spend), viewing (p_view, P_view). All secp256k1.
 *   Meta-address  : P_spend ‖ P_view, each a 33-byte COMPRESSED point → 66 bytes.
 *
 *   Sender derives (per message):
 *     • ephemeral keypair (r, R = r·G).                       R is published (the "ephemeralPubKey").
 *     • S   = r · P_view                                       ECDH shared secret POINT.
 *     • s_h = keccak256( compress(S) )                         hashed shared secret (32 bytes).
 *     • viewTag = s_h[0]                                       1-byte scan hint (published).
 *     • P_stealth = P_spend + s_h·G                            the one-time stealth PUBLIC key.
 *     • stealthAddress = keccak256( uncompressed(P_stealth)[1..] )[12..]   (standard 20-byte addr).
 *
 *   Recipient scans each announcement (R, viewTag, stealthAddress):
 *     • S   = p_view · R                                       same point, by ECDH symmetry.
 *     • s_h = keccak256( compress(S) );  if s_h[0] ≠ viewTag → SKIP (cheap reject, no EC add).
 *     • P_stealth = P_spend + s_h·G;  derive its address;  if ≠ stealthAddress → not mine.
 *     • else: it's mine, and `s_h` is the shared secret (keys the body cipher).
 *
 *   Recipient spends/decrypts:  p_stealth = (p_spend + s_h) mod n   →  controls stealthAddress.
 *
 * The `s_h`/viewTag both come from the VIEWING key path, so a recipient can scan (detect messages)
 * with only their viewing key online; the spending key is needed only to actually spend/act.
 */
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToNumberBE, numberToBytesBE, concatBytes, equalBytes } from '@noble/curves/utils'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'

// ── fixed sizes & domain-separation labels ───────────────────────────────────────────────────

const COMPRESSED_PUBKEY_BYTES = 33
const META_ADDRESS_BYTES = COMPRESSED_PUBKEY_BYTES * 2 // spendingPub(33) ‖ viewingPub(33)
const ADDRESS_BYTES = 20
const PRIVKEY_BYTES = 32
const AEAD_NONCE_BYTES = 24

/** HKDF `info` label deriving the message AEAD key from the ERC-5564 shared secret. */
const MSG_KEY_INFO = 'msgboard:stealth:msg:v1'

/** HKDF `info` labels domain-separating the two keys derived from a wallet-signature seed. */
const SPEND_KEY_INFO = 'msgboard:stealth:spend:v1'
const VIEW_KEY_INFO = 'msgboard:stealth:view:v1'

const Point = secp256k1.Point
/** secp256k1 base point G and scalar field Fn (arithmetic mod the curve order n). */
const G = Point.BASE
const Fn = Point.Fn

// ── types ──────────────────────────────────────────────────────────────────────────────────

/** A recipient's stealth meta-address = two keypairs + the 66-byte published form. */
export interface StealthMetaAddress {
  /** Spending private key (32 bytes) — needed to SPEND/decrypt, kept most protected. */
  spendingPrivKey: Uint8Array
  /** Spending public key (33 bytes compressed) — published in the meta-address. */
  spendingPubKey: Uint8Array
  /** Viewing private key (32 bytes) — needed to SCAN/detect; can live online. */
  viewingPrivKey: Uint8Array
  /** Viewing public key (33 bytes compressed) — published in the meta-address. */
  viewingPubKey: Uint8Array
  /** The 66-byte `spendingPubKey ‖ viewingPubKey` to register (ERC-6538) / share. */
  metaAddress: Uint8Array
}

/** The sender-side output of a derivation: what to announce, plus the shared secret to encrypt with. */
export interface StealthDerivation {
  /** The one-time 20-byte recipient address to announce (`stealthAddress` in the event). */
  stealthAddress: Uint8Array
  /** The one-time 33-byte compressed ephemeral public key R to announce. */
  ephemeralPubKey: Uint8Array
  /** The 1-byte ERC-5564 view tag for cheap recipient-side scanning. */
  viewTag: number
  /** The 32-byte hashed shared secret s_h — key material for the message cipher. */
  sharedSecret: Uint8Array
}

/** An on-chain announcement, as a scanner sees it. */
export interface Announcement {
  stealthAddress: Uint8Array
  ephemeralPubKey: Uint8Array
  viewTag: number
}

/** The recipient scanning keys: their spending PUBLIC key + their viewing PRIVATE key. */
export interface ScanKeys {
  spendingPubKey: Uint8Array
  viewingPrivKey: Uint8Array
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

/** Standard Ethereum address from a secp256k1 public key (any encoding noble accepts). */
export function stealthAddressOf(pubKey: Uint8Array): Uint8Array {
  const uncompressed = Point.fromHex(pubKey).toBytes(false) // 0x04 ‖ X(32) ‖ Y(32)
  return keccak_256(uncompressed.subarray(1)).subarray(32 - ADDRESS_BYTES) // last 20 bytes of the 32-byte hash
}

/**
 * ERC-5564 hashed shared secret s_h = keccak256(compress(S)). Taking the COMPRESSED (33-byte)
 * serialization of the shared point is the ERC-5564 convention; both sides serialize identically,
 * so they agree bit-for-bit.
 */
function hashedSharedSecret(sharedPoint: InstanceType<typeof Point>): Uint8Array {
  return keccak_256(sharedPoint.toBytes(true))
}

/** s_h as a scalar in [0, n) — reduced mod the curve order for use as a multiplier / addend. */
function sharedSecretScalar(sharedSecret: Uint8Array): bigint {
  return Fn.create(bytesToNumberBE(sharedSecret))
}

// ── recipient: publish a meta-address ─────────────────────────────────────────────────────────

/** Generate a fresh recipient stealth meta-address (two independent secp256k1 keypairs). */
export function generateStealthMetaAddress(): StealthMetaAddress {
  const spendingPrivKey = secp256k1.utils.randomSecretKey()
  const viewingPrivKey = secp256k1.utils.randomSecretKey()
  const spendingPubKey = secp256k1.getPublicKey(spendingPrivKey, true)
  const viewingPubKey = secp256k1.getPublicKey(viewingPrivKey, true)
  return {
    spendingPrivKey,
    spendingPubKey,
    viewingPrivKey,
    viewingPubKey,
    metaAddress: concatBytes(spendingPubKey, viewingPubKey),
  }
}

/**
 * Reduce an HKDF-expanded seed to a valid secp256k1 private scalar in [1, n). We expand 48 bytes
 * (384 bits) and reduce mod the curve order n — n is within ~2^-128 of 2^256, so the modulo bias is
 * cryptographically negligible. A zero result (probability ~2^-256) is rejected.
 */
function deriveScalar(seed: Uint8Array, info: string): Uint8Array {
  const out = hkdf(sha256, seed, undefined, info, 48)
  const x = Fn.create(bytesToNumberBE(out))
  if (x === 0n) throw new Error('degenerate stealth key derivation (retry signing)')
  return numberToBytesBE(x, PRIVKEY_BYTES)
}

/**
 * Derive a stealth meta-address DETERMINISTICALLY from a seed (a wallet signature over a fixed
 * message). Same seed → same spending + viewing keypairs, so the identity is recoverable on any
 * device by re-signing — mirroring wallet-identity.ts. Distinct HKDF `info` labels domain-separate
 * the spending key (needed to spend/decrypt) from the viewing key (needed only to scan), so neither
 * can be recovered from the other. The `seed` must be ≥32 bytes of key material.
 */
export function deriveStealthMetaAddressFromSeed(seed: Uint8Array): StealthMetaAddress {
  if (seed.length < 32) throw new Error('seed too short to derive stealth keys')
  const spendingPrivKey = deriveScalar(seed, SPEND_KEY_INFO)
  const viewingPrivKey = deriveScalar(seed, VIEW_KEY_INFO)
  const spendingPubKey = secp256k1.getPublicKey(spendingPrivKey, true)
  const viewingPubKey = secp256k1.getPublicKey(viewingPrivKey, true)
  return {
    spendingPrivKey,
    spendingPubKey,
    viewingPrivKey,
    viewingPubKey,
    metaAddress: concatBytes(spendingPubKey, viewingPubKey),
  }
}

/** Split a 66-byte meta-address into its two compressed pubkeys. Throws on a malformed length. */
export function parseMetaAddress(metaAddress: Uint8Array): { spendingPubKey: Uint8Array; viewingPubKey: Uint8Array } {
  if (metaAddress.length !== META_ADDRESS_BYTES) {
    throw new Error(`stealth meta-address must be ${META_ADDRESS_BYTES} bytes`)
  }
  return {
    spendingPubKey: metaAddress.subarray(0, COMPRESSED_PUBKEY_BYTES),
    viewingPubKey: metaAddress.subarray(COMPRESSED_PUBKEY_BYTES, META_ADDRESS_BYTES),
  }
}

// ── sender: derive a one-time stealth address ─────────────────────────────────────────────────

/**
 * Sender side (ERC-5564): from the recipient's published meta-address, derive a fresh one-time
 * stealth address + ephemeral pubkey + view tag, and the shared secret to key the body cipher.
 */
export function deriveStealthAddress(recipientMetaAddress: Uint8Array): StealthDerivation {
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(recipientMetaAddress)

  const ephemeralPrivKey = secp256k1.utils.randomSecretKey()
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true)

  // S = r · P_view  → s_h = keccak256(compress(S))  → viewTag = s_h[0].
  const sharedPoint = Point.fromHex(viewingPubKey).multiply(bytesToNumberBE(ephemeralPrivKey))
  const sharedSecret = hashedSharedSecret(sharedPoint)

  // P_stealth = P_spend + s_h·G.
  const stealthPoint = Point.fromHex(spendingPubKey).add(G.multiply(sharedSecretScalar(sharedSecret)))

  return {
    stealthAddress: stealthAddressOf(stealthPoint.toBytes(true)),
    ephemeralPubKey,
    viewTag: sharedSecret[0]!,
    sharedSecret,
  }
}

// ── recipient: scan an announcement ───────────────────────────────────────────────────────────

/**
 * Recipient side (ERC-5564): test one announcement against your keys.
 *   1. Recompute S = p_view · R and s_h; if s_h[0] ≠ viewTag, this isn't yours → null (cheap).
 *   2. Derive P_stealth = P_spend + s_h·G and its address; if it ≠ the announced stealthAddress,
 *      not yours → null.
 *   3. Else it's yours: returns the confirmed stealthAddress + the shared secret (to decrypt).
 * Never throws on a malformed announcement — returns null.
 */
export function checkAnnouncement(announcement: Announcement, keys: ScanKeys): { stealthAddress: Uint8Array; sharedSecret: Uint8Array } | null {
  try {
    const sharedPoint = Point.fromHex(announcement.ephemeralPubKey).multiply(bytesToNumberBE(keys.viewingPrivKey))
    const sharedSecret = hashedSharedSecret(sharedPoint)
    // Fast reject: 1 hash + 1 byte compare rules out ~255/256 of foreign announcements.
    if (sharedSecret[0] !== announcement.viewTag) return null

    const stealthPoint = Point.fromHex(keys.spendingPubKey).add(G.multiply(sharedSecretScalar(sharedSecret)))
    const derived = stealthAddressOf(stealthPoint.toBytes(true))
    // Full confirm: the derived address must match the announced one (a view-tag collision is 1/256).
    if (!equalBytes(derived, announcement.stealthAddress)) return null

    return { stealthAddress: derived, sharedSecret }
  } catch {
    return null
  }
}

// ── recipient: spend / decrypt ────────────────────────────────────────────────────────────────

/**
 * Recipient's private key for a detected stealth address: p_stealth = (p_spend + s_h) mod n. Its
 * public key is exactly the announced stealth address, so it can sign for / decrypt to that address.
 */
export function computeStealthPrivateKey(spendingPrivKey: Uint8Array, sharedSecret: Uint8Array): Uint8Array {
  const p = Fn.add(Fn.create(bytesToNumberBE(spendingPrivKey)), sharedSecretScalar(sharedSecret))
  return numberToBytesBE(p, PRIVKEY_BYTES)
}

// ── message body cipher (keyed by the shared secret) ─────────────────────────────────────────

/** Derive the XChaCha20-Poly1305 body key from the ERC-5564 shared secret (domain-separated). */
function messageKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, undefined, MSG_KEY_INFO, 32)
}

/**
 * Encrypt a message body under the shared secret. Output = nonce(24) ‖ XChaCha20-Poly1305 ciphertext.
 * This is what goes into the `ciphertext` field of a StealthMessenger announcement.
 */
export function encryptMessage(sharedSecret: Uint8Array, plaintext: Uint8Array | string): Uint8Array {
  const pt = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext
  const nonce = crypto.getRandomValues(new Uint8Array(AEAD_NONCE_BYTES))
  const ct = xchacha20poly1305(messageKey(sharedSecret), nonce).encrypt(pt)
  return concatBytes(nonce, ct)
}

/**
 * Decrypt a `nonce ‖ ciphertext` blob under the shared secret. Throws (AEAD tag mismatch) on a wrong
 * key or tampered bytes — callers that want a fail-closed marker should catch, mirroring dm-crypto.
 */
export function decryptMessage(sharedSecret: Uint8Array, blob: Uint8Array): Uint8Array {
  const nonce = blob.subarray(0, AEAD_NONCE_BYTES)
  const ct = blob.subarray(AEAD_NONCE_BYTES)
  return xchacha20poly1305(messageKey(sharedSecret), nonce).decrypt(ct)
}

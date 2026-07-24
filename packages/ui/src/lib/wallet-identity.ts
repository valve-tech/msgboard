/**
 * wallet-identity — a PORTABLE identity derived deterministically from a wallet signature.
 *
 * The walletless Whisper identity (zk-identity.ts) is a random secret trapped in one browser: clear
 * storage or switch devices and your pseudonym is gone. This module is the opt-in alternative — sign
 * one fixed message with your wallet and we derive the same identity every time, on any device. The
 * wallet IS the backup; re-signing restores everything. (Pattern: sign-in-with-Ethereum → derive
 * keys, as used by Lit, Snapshot, etc.)
 *
 * From one signature we derive BOTH:
 *   - the Semaphore identity secrets (nullifier, trapdoor) → the anonymous Whisper pseudonym, and
 *   - an X25519 encryption keypair → the key for per-recipient encrypted DMs/groups (a later tier).
 * Distinct HKDF `info` labels domain-separate them, so no derived secret can be recovered from
 * another.
 *
 * DETERMINISM CAVEAT: this relies on the wallet producing a DETERMINISTIC signature for a fixed
 * message (RFC-6979 nonces). MetaMask and virtually every mainstream wallet do; a wallet using
 * random ECDSA nonces would derive a different identity each time and break portability. We surface
 * this honestly in the UI rather than silently mis-derive.
 *
 * The signature never leaves the browser. Nothing here is posted, logged, or sent to any server.
 */
import { hexToBytes, isAddressEqual, recoverMessageAddress, type Hex } from 'viem'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha512 } from '@noble/hashes/sha512'
import { SNARK_FIELD } from './zk-post'
import type { ZkIdentity } from './zk-identity'

/**
 * The message the wallet signs. FIXED FOREVER — every user's derived identity is a function of this
 * exact string, so changing a single byte silently rotates everyone to a new identity. Do not edit.
 */
export const WALLET_IDENTITY_MESSAGE =
  'MsgBoard portable identity v1\n\n' +
  'Sign to derive your anonymous Whisper identity and encryption keys on this device.\n\n' +
  'This signature is used only to derive keys locally — it is never sent anywhere. ' +
  'Anyone who can produce this signature controls the identity, so only sign it in wallets you trust.'

/** The full derived bundle: the Semaphore identity + an X25519 encryption keypair. */
export type DerivedIdentity = {
  identity: ZkIdentity
  encPublicKey: Uint8Array
  encPrivateKey: Uint8Array
}

/**
 * Reduce an HKDF-expanded output to a field element with negligible modulo bias. We expand 64 bytes
 * (512 bits) and reduce mod the ~254-bit SNARK field — the bias is ~2^-258, cryptographically nil.
 */
function deriveField(ikm: Uint8Array, info: string): bigint {
  const out = hkdf(sha512, ikm, undefined, info, 64)
  let acc = 0n
  for (const b of out) acc = (acc << 8n) | BigInt(b)
  const x = acc % SNARK_FIELD
  // A zero field element is degenerate (and importIdentity rejects it). The probability here is
  // ~2^-254 — cryptographically impossible — but guard for symmetry with the import path.
  if (x === 0n) throw new Error('degenerate identity derivation (retry signing)')
  return x
}

/**
 * Derive the portable identity from a wallet signature over {@link WALLET_IDENTITY_MESSAGE}. Pure +
 * deterministic: the same signature always yields the same identity. The signature bytes are the
 * HKDF input keying material; distinct `info` labels separate the three secrets.
 */
export function deriveIdentityFromSignature(signature: Hex): DerivedIdentity {
  const ikm = hexToBytes(signature)
  if (ikm.length < 32) throw new Error('signature too short to derive an identity')
  const identity: ZkIdentity = {
    nullifier: deriveField(ikm, 'msgboard/whisper/nullifier/v1'),
    trapdoor: deriveField(ikm, 'msgboard/whisper/trapdoor/v1'),
  }
  // X25519 private scalar: 32 bytes of HKDF output; the curve clamps it internally.
  const encPrivateKey = hkdf(sha512, ikm, undefined, 'msgboard/whisper/x25519/v1', 32)
  const encPublicKey = x25519.getPublicKey(encPrivateKey)
  return { identity, encPublicKey, encPrivateKey }
}

/** Minimal EIP-1193 injected-provider shape (window.ethereum) — we only need request(). */
type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

/** True when an injected wallet is present (so the UI can show/hide the "make portable" affordance). */
export function hasInjectedWallet(): boolean {
  return typeof (globalThis as unknown as { ethereum?: Eip1193 }).ethereum?.request === 'function'
}

/**
 * Connect an injected wallet and `personal_sign` the fixed message, returning the signature.
 * Throws with a readable message if there is no wallet or the user rejects.
 *
 * EOA-ONLY GUARD (audit finding): portability depends on the signature being deterministic. That
 * holds for externally-owned accounts (RFC-6979 + EIP-2 low-s → byte-identical every time) but NOT
 * for smart-contract wallets (Safe/Argent/4337): their `personal_sign` returns an EIP-1271 blob
 * that changes when owners/threshold rotate, so re-signing would silently derive a DIFFERENT
 * identity and detach the user from their pseudonym. We therefore (a) reject accounts that carry
 * bytecode, and (b) verify the signature actually recovers to the connecting address — rejecting
 * EIP-1271 blobs and junk signatures that would derive an unstable identity.
 */
export async function signIdentityMessage(): Promise<Hex> {
  const eth = (globalThis as unknown as { ethereum?: Eip1193 }).ethereum
  if (!eth?.request) throw new Error('No injected wallet found — install one to make your identity portable.')
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts?.[0] as Hex | undefined
  if (!address) throw new Error('No account authorized in the wallet.')

  // (a) Reject smart-contract accounts — their signatures are not stably reproducible.
  const code = (await eth.request({ method: 'eth_getCode', params: [address, 'latest'] })) as string
  if (code && code !== '0x' && code !== '0x0') {
    throw new Error(
      'Portable identity needs a standard wallet (an EOA). Smart-contract wallets can change their ' +
        'signature when you rotate signers, which would change your pseudonym — use the recovery key instead.',
    )
  }

  // personal_sign params order is [message, address]; the human-readable string shows the user
  // exactly what they are signing (anti-blind-sign).
  const sig = (await eth.request({ method: 'personal_sign', params: [WALLET_IDENTITY_MESSAGE, address] })) as Hex

  // (b) Confirm the signature recovers to the connecting address — rejects EIP-1271 blobs and any
  // non-standard signature that wouldn't re-derive the same identity.
  const recovered = await recoverMessageAddress({ message: WALLET_IDENTITY_MESSAGE, signature: sig })
  if (!isAddressEqual(recovered, address)) {
    throw new Error(
      'This wallet did not produce a standard, reproducible signature (it may be a smart-contract ' +
        'wallet). Portable identity is unavailable — use the recovery key backup instead.',
    )
  }
  return sig
}

/** Connect + sign + derive, in one call — the button handler for "make my identity portable". */
export async function deriveIdentityFromWallet(): Promise<DerivedIdentity> {
  return deriveIdentityFromSignature(await signIdentityMessage())
}

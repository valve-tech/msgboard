import { type Hex, decodeAbiParameters, encodeAbiParameters } from 'viem'

/**
 * A generic co-signature artifact. The single source of truth shared by posters,
 * readers, and the cosign archivist (sub-project 2). Field order matches RECORD_ABI.
 */
export interface SignatureRecord {
  /** The signed digest (bytes32) — e.g. a safeTxHash. */
  digest: Hex
  /** The signer address (20-byte address). */
  signer: Hex
  /** The signature bytes (e.g. 65-byte r||s||v for ECDSA). */
  signature: Hex
  /** The signature scheme — see SCHEME. */
  scheme: number
  /** Optional scheme-specific metadata (bytes); `0x` when unused. */
  meta: Hex
}

/** Signature scheme tags for the `scheme` field. Values are law (uint8 on the wire). */
export const SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 } as const

/**
 * Canonical ABI tuple — ORDER IS LAW. Both readers and the archivist decode against
 * this exact sequence: (bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta).
 */
export const RECORD_ABI = [
  { name: 'digest', type: 'bytes32' },
  { name: 'signer', type: 'address' },
  { name: 'signature', type: 'bytes' },
  { name: 'scheme', type: 'uint8' },
  { name: 'meta', type: 'bytes' },
] as const

/** ABI-encodes a SignatureRecord into the canonical tuple. */
export function encodeRecord(r: SignatureRecord): Hex {
  return encodeAbiParameters(RECORD_ABI, [r.digest, r.signer, r.signature, r.scheme, r.meta])
}

/**
 * ABI-decodes the canonical tuple into a SignatureRecord.
 * @throws (via viem) on malformed / undecodable input.
 */
export function decodeRecord(data: Hex): SignatureRecord {
  const [digest, signer, signature, scheme, meta] = decodeAbiParameters(RECORD_ABI, data)
  return { digest, signer, signature, scheme: Number(scheme), meta }
}

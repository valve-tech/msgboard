/**
 * zk-post — the WIRE ENVELOPE + public-signal derivations for the ZK Chat channel.
 *
 * This is a browser-safe, main-thread port of the encoding half of
 * `packages/examples/src/zk-msgboard.ts`. It is byte-for-byte compatible with that
 * module: same `ZkPost` shape, same `[root, nullifierHash, externalNullifier, signalHash]`
 * public-signal order, same `encodePost = toHex(JSON.stringify(post))`, same `decodePost`
 * validation, and the same `signalHash`/`externalNullifier` keccak reductions. A message
 * posted by ZkChat therefore decodes and verifies under the EXISTING zk-msgboard watcher /
 * archive (packages/examples), and vice-versa.
 *
 * Everything here uses only viem (keccak256) — NO circomlibjs/snarkjs — so it is safe to
 * run on the render thread. The heavy crypto (Poseidon identity/tree + Groth16
 * prove/verify) lives in the Web Worker (worker/zk-worker.ts) behind the zk-prover seam.
 */
import { keccak256, toHex, hexToString, stringToHex, type Hex } from 'viem'

/** The BN254 scalar field the circom/snarkjs circuit operates over. */
export const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n

/** Merkle depth of the group tree — matches `MembershipProof(10)` in the circuit. */
export const MERKLE_DEPTH = 10

/** snarkjs Groth16 proof shape (opaque to us; verified by snarkjs in the worker). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Groth16Proof = Record<string, any>

/**
 * What gets posted as the board message `data`: the membership proof, its public signals,
 * and the actual message payload. `publicSignals` is
 * `[root, nullifierHash, externalNullifier, signalHash]` (circuit output order).
 * Identical to `ZkPost` in packages/examples/src/zk-msgboard.ts.
 */
export type ZkPost = { proof: Groth16Proof; publicSignals: string[]; payload: Hex }

/** Named accessors over the positional publicSignals array (mirror zk-msgboard.ts). */
export const rootOf = (post: ZkPost): string => post.publicSignals[0]
export const nullifierHashOf = (post: ZkPost): string => post.publicSignals[1]
export const externalNullifierOf = (post: ZkPost): string => post.publicSignals[2]
export const signalHashOf = (post: ZkPost): string => post.publicSignals[3]

/**
 * Reduces the message payload to a field element. Making this a PUBLIC input binds the
 * proof to exactly this message: a valid proof cannot be lifted onto different content.
 */
export const signalHash = (payload: Hex): bigint => BigInt(keccak256(payload)) % SNARK_FIELD

/**
 * The epoch / scope a nullifier is valid within — derived from the category string, so a
 * member's nullifier is deterministic per (epoch, identity): "one post per member per
 * epoch". Matches zk-msgboard.ts's `externalNullifier`.
 */
export const externalNullifier = (scope: string): bigint =>
  BigInt(keccak256(stringToHex(scope))) % SNARK_FIELD

/** Encodes a post as the hex `data` of a board message (identical to zk-msgboard.ts). */
export const encodePost = (post: ZkPost): Hex => toHex(JSON.stringify(post))

/** Decodes a board message's hex `data` back into a post, or null if it isn't one. */
export const decodePost = (data: Hex): ZkPost | null => {
  try {
    const parsed = JSON.parse(hexToString(data)) as ZkPost
    if (!parsed.proof || !Array.isArray(parsed.publicSignals) || parsed.publicSignals.length !== 4)
      return null
    if (typeof parsed.payload !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** Best-effort decode of a payload's bytes to text (for rendering). */
export const payloadText = (payload: Hex): string => {
  try {
    return hexToString(payload)
  } catch {
    return payload
  }
}

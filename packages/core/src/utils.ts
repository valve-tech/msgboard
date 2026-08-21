import BN from 'bn.js'
import elliptic from 'elliptic'
import {
  type ByteArray,
  bytesToHex,
  concatBytes,
  fromRlp,
  hexToBytes,
  isBytes,
  isHex,
  keccak256,
  numberToBytes,
  sha256,
  stringToBytes,
  toHex,
  toRlp,
  type Hex,
  numberToHex,
} from 'viem'
import * as types from './types.js'
import { LegacyProvider } from './types.js'

const EC = elliptic.ec
const ec = new EC('secp256k1')
const g = ec.g as elliptic.curve.base.BasePoint

/**
 * Returns the modulus used for the PoW verification = (2^24)+(10k*dataLen).
 * @param factors the message difficulty factors
 * @param dataLen the length of message data
 * @returns the computed message difficulty
 */
export function difficulty({ workMultiplier, workDivisor }: types.DifficultyFactors, dataLen: number) {
  // difficulty is increased with the size of the message
  return ((2n ** 24n + BigInt(dataLen) * 10_000n) * workMultiplier) / workDivisor
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The msgboard PoW algorithm — message version 1. This is the one and only scheme: the spec defines
// exactly one algorithm and every example carries version 0x1. (The only `msg/2` in the spec is a
// devp2p wire-capability bump reserved for changing the packet limits — NOT a message-version bump —
// so there is no "message version 2".) The node verifies with this scheme; a pre-revision scheme once
// existed but the node now rejects it, so it is gone from this repo.
//
// The scheme: the scalar is a SHA256 of the whole transcript; the work hash is over the COMPRESSED
// point (33 bytes, so no leading-zero encoding hazard); an out-of-range scalar is REJECTED, not
// reduced (mirrors Go ScalarBaseMult); and acceptance is `workHash < 2^256 / D`.

/** The acceptance target: a work hash is valid iff it is below 2^256 / D. */
export function powTarget(d: bigint): bigint {
  return d === 0n ? 0n : (2n ** 256n) / d
}

/** Revised algo, step 3: SHA256(category ‖ data). Commits category + data once per message body. */
export function payloadHash(msg: types.MessageSeed): Hex {
  return sha256(concatBytes([hexToBytes(msg.category, { size: 32 }), hexToBytes(msg.data)]))
}

/**
 * Revised algo, step 4: SHA256(version ‖ blockHash ‖ payloadHash ‖ workMultiplier ‖ workDivisor ‖ nonce).
 * Fixed-width big-endian: 1-byte version, 32-byte blockHash, 32-byte payloadHash, 8-byte M / D / nonce.
 */
export function scalarHash(msg: types.MessageSeed, payloadHashBytes: Uint8Array): Hex {
  return sha256(
    concatBytes([
      numberToBytes(msg.version, { size: 1 }),
      hexToBytes(msg.blockHash, { size: 32 }),
      payloadHashBytes,
      numberToBytes(msg.workMultiplier, { size: 8 }),
      numberToBytes(msg.workDivisor, { size: 8 }),
      numberToBytes(msg.nonce, { size: 8 }),
    ]),
  )
}

/**
 * The msgboard PoW verifier — message version 1, the one and only scheme. scalar =
 * SHA256(version ‖ blockHash ‖ payloadHash ‖ M ‖ D ‖ nonce), rejected unless 1 <= scalar < n (reject,
 * do NOT reduce — matches Go ScalarBaseMult); the work hash is SHA256 of the COMPRESSED point; accept
 * iff workHash < 2^256 / D. Returns the work hash, or null when it does not pass.
 */
export function checkWork(msg: types.MessageSeed, msgDifficulty: bigint): Hex | null {
  const payloadHashBytes = hexToBytes(payloadHash(msg))
  const scalar = new BN(hexToBytes(scalarHash(msg, payloadHashBytes)))
  // Reject rather than reduce: must match Go's secp256k1 ScalarBaseMult behaviour.
  if (scalar.isZero() || scalar.gte(ec.n as BN)) return null
  const point = g.mul(scalar)
  if (point.isInfinity()) return null
  const compressed = Uint8Array.from(point.encodeCompressed()) // 0x02/0x03 ‖ x (33 bytes)
  const hash = sha256(compressed)
  if (BigInt(hash) >= powTarget(msgDifficulty)) return null
  return hash
}

/**
 * The msgboard PoW grind — pairs with {@link checkWork}. Each nonce's scalar is an independent hash, so
 * there is no constant point step to exploit; every nonce pays a full scalar multiply. Mutates
 * `message.nonce`; returns the work hash when a nonce passes, else null.
 */
export function createChallengeSearch(message: types.MessageSeed) {
  return {
    next(msgDifficulty: bigint): Hex | null {
      message.nonce += 1n
      return checkWork(message, msgDifficulty)
    },
  }
}

/**
 * Computes a category hash for creating a pow message.
 * @param category the category string or byte array
 * - if the input category is already in hex form it will be return as-is
 * - if the input category is a byte array it will be truncated to 32 bytes and hex-encoded
 * - if the input category is a string it will be passed through the keccak256 hash function
 * @returns a 32-byte category hash
 */
export function categoryHash(category: string | Hex | ByteArray): Hex {
  if (isHex(category)) return category
  if (isBytes(category)) return bytesToHex(category, { size: 32 })
  return keccak256(stringToBytes(category))
}

/**
 * Encodes the given data into binary for creating a pow message.
 * @param data the data string to encode
 * @returns the hex-encoded data
 */
export function encodeData(data: string | ByteArray | Hex) {
  return isHex(data) ? data : toHex(data)
}

/**
 * Encodes a MessageSeed as RLP for msgboard submission.
 * @param msg the message inputs
 * @returns the RLP-encoded byte array in hex
 */
export function toRLP(msg: types.MessageSeed) {
  return toRlp([
    numberToBytes(msg.version, { size: 1 }), // single byte
    hexToBytes(msg.blockHash, { size: 32 }), // 32-byte hash
    numberToBytes(msg.nonce),
    numberToBytes(msg.workMultiplier),
    numberToBytes(msg.workDivisor),
    hexToBytes(msg.category, { size: 32 }), // 32-byte hash
    hexToBytes(msg.data),
  ])
}

/**
 * Decodes a RLP-encoded message into its seed data.
 * @param rlp the RLP-encoded byte array in hex
 * @returns the encoded message seed
 */
export function fromRLP(rlp: Hex): types.MessageSeed {
  const [version, blockHash, nonce, workMultiplier, workDivisor, category, data] = fromRlp(rlp)
  return {
    version: Number(version),
    blockHash,
    nonce: BigInt(nonce as string),
    workMultiplier: BigInt(workMultiplier as string),
    workDivisor: BigInt(workDivisor as string),
    category,
    data,
  } as types.MessageSeed
}

/**
 * Parses a hex-encoded RPCMessage.
 * @param msg the hex-encoded RPC message
 * @returns a parsed messaged type
 */
export function fromRPCMessage(msg: types.RPCMessage): types.Message {
  return {
    ...msg,
    blockNumber: BigInt(msg.blockNumber),
    nonce: BigInt(msg.nonce),
    workMultiplier: BigInt(msg.workMultiplier),
    workDivisor: BigInt(msg.workDivisor),
    version: Number(msg.version),
  }
}

export function toRPCMessage(msg: types.Message): types.RPCMessage {
  return {
    ...msg,
    blockNumber: numberToHex(msg.blockNumber),
    version: numberToHex(msg.version),
    nonce: numberToHex(msg.nonce),
    workMultiplier: numberToHex(msg.workMultiplier),
    workDivisor: numberToHex(msg.workDivisor),
  }
}

/** Wraps a legacy provider to expose a standard request method. */
export function wrapLegacySend(provider: LegacyProvider): types.Provider {
  return {
    request<T, U extends unknown[]>(args: { method: string; params: U }): Promise<T> {
      return provider.send(args.method, args.params) as Promise<T>
    },
  }
}

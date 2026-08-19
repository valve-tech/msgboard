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
 * LEGACY (pre-revision) verifier. The msgboard spec revised the PoW algorithm to the transcript-hash
 * scheme in {@link checkWork}; this is the OLD scheme (challenge = x of G·(nonce·digest + blockHash),
 * accept if hash % D == 0). The live 943 board still runs it today, so it is kept — but new work must
 * use {@link checkWork}. Selection is by deployment config, NOT the message version field (both schemes
 * are message version 1; see the spec — the revised algorithm IS version 1).
 * @returns the message hash, or null when the work does not pass.
 */
export function checkWorkLegacy(msg: types.MessageSeed, msgDifficulty: bigint) {
  const bytes = new Uint8Array([
    ...getChallengeLegacy(msg),
    ...hexToBytes(msg.category, { size: 32 }),
    ...hexToBytes(msg.data),
  ])
  const hash = sha256(bytes)
  if (BigInt(hash) % msgDifficulty !== 0n) {
    return null
  }
  return hash
}

/**
 * LEGACY challenge component (the x of G·(nonce·digest + blockHash)). Used only by {@link checkWorkLegacy}.
 * @throws error if the challenge is invalid
 */
export function getChallengeLegacy(msg: types.MessageSeed) {
  const digest = BigInt(difficultyDigest(msg))
  // nonce = msg.nonce * msg.difficultyDigest() + msg.blockHash
  const nonce = new BN((msg.nonce * digest + BigInt(msg.blockHash)).toString())
  const challenge = g.mul(nonce)
  if (challenge.isInfinity()) {
    throw new Error('unable to create challenge')
  }
  // The x-coordinate MUST be a fixed 32-byte big-endian encoding. bn.js `toArray()` with no length
  // returns the MINIMAL representation, dropping leading zero bytes — so an x below 2^248 (one input
  // in 256) would encode to 31 bytes and mismatch the node. The node's verifier and this repo's Rust
  // grinder both always produce 32 bytes (pow-grinder/src/lib.rs x_of → [u8; 32]; reth pow.rs
  // serialize_uncompressed()[1..33]). Pin the width to match them.
  return Uint8Array.from(challenge.getX().toArray('be', 32))
}

/**
 * A stateful, fast proof-of-work search over consecutive nonces.
 *
 * {@link checkWork} recomputes `challenge = g·(nonce·digest + blockHash)` from scratch
 * every nonce — a full elliptic-curve scalar MULTIPLICATION, which dominates the grind
 * (~0.6 ms each in JS, capping a naive loop near ~1.5k hashes/s). But across consecutive
 * nonces the scalar grows by a constant `digest` (nonce increments by 1), so the challenge
 * POINT advances by a constant point `D = g·digest`. Replacing the per-nonce scalar MULTIPLY
 * with a single point ADDITION makes the search ~20-50x faster while producing bit-identical
 * challenges: `g·a + g·b = g·(a+b)`, and `g·x` depends only on `x mod n`, so the running point
 * after k additions equals `g·(nonce·digest + blockHash)` exactly. The constant message bytes
 * (32-byte category + data) are concatenated once.
 *
 * `next(msgDifficulty)` advances `message.nonce` by 1, steps (or rebases) the running point,
 * and returns the work hash if `hash % msgDifficulty === 0n`, else null. It reads
 * `message.blockHash` live every call: if it changed since the running point was based (the
 * {@link MsgBoardClient.doPoW} block poller updates it mid-grind), the point is rebased with a
 * single scalar multiply before continuing. {@link checkWorkLegacy} is the verifier this matches;
 * this only accelerates finding a winning nonce, and must stay byte-for-byte equivalent to it.
 *
 * LEGACY (pre-revision) grind — pairs with {@link checkWorkLegacy}. Use {@link createChallengeSearch}
 * for the revised (spec) algorithm.
 *
 * @param message the message to grind; its `nonce` is mutated in place as the search advances.
 * @returns an object whose `next(msgDifficulty)` performs one nonce step.
 */
export function createChallengeSearchLegacy(message: types.MessageSeed) {
  const digest = BigInt(difficultyDigest(message))
  const stepPoint = g.mul(new BN(digest.toString())) // D = g·digest, constant for this grind
  const suffix = new Uint8Array([
    ...hexToBytes(message.category, { size: 32 }),
    ...hexToBytes(message.data),
  ])
  let point: elliptic.curve.base.BasePoint | undefined
  let basedBlockHash: Hex | undefined

  // (Re)anchor the running point to the current nonce + blockHash with one scalar multiply.
  const rebase = () => {
    const scalar = message.nonce * digest + BigInt(message.blockHash)
    point = g.mul(new BN(scalar.toString()))
    basedBlockHash = message.blockHash
  }

  return {
    next(msgDifficulty: bigint): Hex | null {
      message.nonce += 1n
      if (point === undefined || message.blockHash !== basedBlockHash) {
        rebase()
      } else {
        point = point.add(stepPoint)
      }
      if (point!.isInfinity()) {
        throw new Error('unable to create challenge')
      }
      // Fixed 32-byte big-endian x — see the note in getChallengeLegacy. `toArray('be', 32)` matches the
      // node + Rust grinder; a bare `toArray()` drops leading zeros (~1 nonce in 256) and mismatches.
      const challenge = Uint8Array.from(point!.getX().toArray('be', 32))
      const hash = sha256(new Uint8Array([...challenge, ...suffix]))
      if (BigInt(hash) % msgDifficulty !== 0n) {
        return null
      }
      return hash
    },
  }
}

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
// The msgboard PoW algorithm (the REVISED spec scheme). This is the CANONICAL checkWork/
// createChallengeSearch — message version 1. The spec defines exactly one algorithm, every example
// carries version 0x1, and the only `msg/2` in the spec is a devp2p wire-capability bump reserved for
// changing the packet limits — NOT a message-version bump. So there is no "message version 2": the
// revision REPLACES version 1's algorithm. The pre-revision scheme is preserved above as
// getChallengeLegacy/checkWorkLegacy/createChallengeSearchLegacy.
//
// Differences from the legacy scheme: the scalar is a SHA256 of the whole transcript (not
// nonce*digest+blockHash); the work hash is over the COMPRESSED point (33 bytes, so no leading-zero
// encoding hazard like the legacy x-coordinate had); an out-of-range scalar is REJECTED, not reduced
// (mirrors Go ScalarBaseMult); and acceptance is `workHash < 2^256 / D`, not `hash % D == 0`.
//
// CUTOVER — the live 943 board still runs the LEGACY scheme (verified against a real message), so a
// client cannot tell legacy from revised by the version field (both are version 1) or from
// msgboard_status (no algorithm marker). A deployment SELECTS the algorithm; clients default to legacy
// until the node ships the revised build, then flip in lockstep.

/** The acceptance target for the revised algo: a work hash is valid iff it is below 2^256 / D. */
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
 * The msgboard PoW verifier — the REVISED spec algorithm, which is the CANONICAL scheme at message
 * version 1 (the spec defines one algorithm and every example carries version 0x1; there is no message
 * version 2 — the only `msg/2` in the spec is a devp2p wire-capability bump reserved for changing the
 * packet limits). scalar = SHA256(version ‖ blockHash ‖ payloadHash ‖ M ‖ D ‖ nonce), rejected unless
 * 1 <= scalar < n (reject, do NOT reduce — matches Go ScalarBaseMult); the work hash is SHA256 of the
 * COMPRESSED point; accept iff workHash < 2^256 / D. Returns the work hash, or null when it does not
 * pass. The pre-revision scheme is {@link checkWorkLegacy}; both are version 1, selected by config —
 * the live 943 board still runs the legacy scheme, so clients default to it until the node cuts over.
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
 * The msgboard PoW grind — pairs with {@link checkWork} (the revised algorithm). Each nonce's scalar is
 * an independent hash, so — unlike the legacy {@link createChallengeSearchLegacy} — there is no constant
 * point step to exploit; every nonce pays a full scalar multiply. Mutates `message.nonce`; returns the
 * work hash when a nonce passes, else null.
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
 * Returns a partial digest from the combined difficulty factors.
 * @param factors the message difficulty factors
 * @returns a 16-byte partial digest in HEX form
 */
export function difficultyDigest({ workMultiplier, workDivisor }: types.DifficultyFactors) {
  return `0x${sha256(
    concatBytes([numberToBytes(workMultiplier, { size: 8 }), numberToBytes(workDivisor, { size: 8 })]),
  ).slice(34)}`
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

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
 * Computes the message hash and checks it against the given difficulty.
 * @param msg the message seed
 * @param msgDifficulty the message difficulty
 * @returns the message hash
 * @throws error if the message nonce/work is not valid
 */
export function checkWork(msg: types.MessageSeed, msgDifficulty: bigint) {
  const bytes = new Uint8Array([
    ...getChallenge(msg),
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
 * Returns the challenge component of the message hash calculation.
 * @param msg the message seed
 * @returns the challenge component
 * @throws error if the challenge is invalid
 */
export function getChallenge(msg: types.MessageSeed) {
  const digest = BigInt(difficultyDigest(msg))
  // nonce = msg.nonce * msg.difficultyDigest() + msg.blockHash
  const nonce = new BN((msg.nonce * digest + BigInt(msg.blockHash)).toString())
  const challenge = g.mul(nonce)
  if (challenge.isInfinity()) {
    throw new Error('unable to create challenge')
  }
  return Uint8Array.from(challenge.getX().toArray())
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
 * single scalar multiply before continuing. {@link checkWork} remains the canonical verifier;
 * this only accelerates finding a winning nonce, and must stay byte-for-byte equivalent to it.
 *
 * @param message the message to grind; its `nonce` is mutated in place as the search advances.
 * @returns an object whose `next(msgDifficulty)` performs one nonce step.
 */
export function createChallengeSearch(message: types.MessageSeed) {
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
      const challenge = Uint8Array.from(point!.getX().toArray())
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

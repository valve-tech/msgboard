import { keccak256, encodeAbiParameters, hexToBigInt, type Hex } from 'viem'

export interface SeedChain {
  /** seeds[0] is the published commit; seeds[k] is round k's server seed (1-indexed). */
  seeds: Hex[]
  commit: Hex
  length: number
}

/** Build a hash chain from a secret tip: seed[L]=tip, seed[i]=keccak256(seed[i+1]).
 *  The house keeps the whole array, publishes only `commit = seed[0]`. Round k uses seed[k];
 *  there are `length` playable rounds (k = 1..length). */
export function buildSeedChain(tip: Hex, length: number): SeedChain {
  if (length < 1) throw new Error('rng: chain length must be >= 1')
  const seeds: Hex[] = new Array(length + 1)
  seeds[length] = tip
  for (let i = length - 1; i >= 0; i--) seeds[i] = keccak256(seeds[i + 1]!)
  return { seeds, commit: seeds[0]!, length }
}

/** A revealed seed is valid iff hashing it yields the previously-known (prior) link. */
export function verifyReveal(priorLink: Hex, revealed: Hex): boolean {
  return keccak256(revealed) === priorLink
}

/** Commit to a secret seed for later reveal: keccak256(seed). Used by the player to bind its
 *  clientSeed at OPEN without revealing it — so the house must commit its OWN seed chain BLIND
 *  (it can't grind its tip against a known clientSeed). The seed is revealed at round time and
 *  checked with verifyReveal(commit, seed). Mirrors the server seed-chain commit (seeds[0]). */
export function commitSeed(seed: Hex): Hex {
  return keccak256(seed)
}

/** Round randomness: uint256(keccak256(abi.encode(serverSeed, clientSeed, nonce))). */
export function roundRandom(serverSeed: Hex, clientSeed: Hex, nonce: bigint): bigint {
  const packed = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }],
    [serverSeed, clientSeed, nonce],
  )
  return hexToBigInt(keccak256(packed))
}

/**
 * Derive an independent sub-random stream from a single round random: uint256(keccak256(abi.encode(
 * uint256 raw, uint64 index))). Used by games that need MULTIPLE independent draws from one round
 * (e.g. Dice X2's two rolls). Deterministic and recomputable on-chain (same keccak preimage), so it
 * stays provably fair: the sub-draws are fixed the instant `raw` is, with no extra house input.
 */
export function subRandom(raw: bigint, index: bigint): bigint {
  const packed = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint64' }],
    [raw, index],
  )
  return hexToBigInt(keccak256(packed))
}

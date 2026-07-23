import * as viem from 'viem'

/** A validator secret and its on-chain preimage (the keccak of the secret). */
export type Secret = { secret: viem.Hex; preimage: viem.Hex }

/**
 * Derive a deterministic 32-byte secret bound to a label and a per-run salt, plus its preimage.
 * Mirrors duel-943.ts's makeSecret. A production validator never reuses a secret — vary the salt.
 */
export const makeSecret = (label: string, salt: viem.Hex): Secret => {
  const secret = viem.keccak256(viem.toHex(`${label}-${salt}`))
  return { secret, preimage: viem.keccak256(secret) }
}

/**
 * The seed core Random forms at cast: keccak256 over the concatenated revealed secrets, in heat
 * order. Identical to the contracts' `revealed.hash()` and to lib/utils.ts `toSeed`.
 */
export const seedFromSecrets = (secretsInHeatOrder: viem.Hex[]): viem.Hex =>
  viem.keccak256(viem.concatHex(secretsInHeatOrder))

/** The coin-flip outcome rule: even seed -> heads, odd -> tails (seed & 1). */
export const coinFlipOutcome = (seed: viem.Hex): 'heads' | 'tails' =>
  (BigInt(seed) & 1n) === 0n ? 'heads' : 'tails'

/** The raffle draw reduction: 1 + (seed mod 256), in [1..256]. */
export const raffleDraw = (seed: viem.Hex): bigint => 1n + (BigInt(seed) % 256n)

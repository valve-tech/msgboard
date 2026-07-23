import * as viem from 'viem'

/** The hash the contracts store for a declared validator subset (keccak of the address[]). */
export const subsetHashOf = (subset: viem.Hex[]): viem.Hex =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'address[]' }], [subset]))

export type Involvement = { played: boolean; validated: boolean }

/**
 * How the connected wallet relates to a game. "Validated" is decidable only for the
 * canonical subset: the chain stores just the subset's hash, and a hash can't be reversed —
 * so a custom subset that happens to include the wallet won't be flagged. Every game this
 * site creates uses the canonical subset, so in practice this covers the venue.
 */
export const involvement = (
  game: { mine: boolean; subsetHash?: viem.Hex },
  canonicalSubset: viem.Hex[],
  myAddress?: viem.Hex,
): Involvement => {
  if (!myAddress) return { played: false, validated: false }
  const inCanonical = canonicalSubset.some((v) => v.toLowerCase() === myAddress.toLowerCase())
  return {
    played: game.mine,
    validated: inCanonical && game.subsetHash !== undefined && game.subsetHash === subsetHashOf(canonicalSubset),
  }
}

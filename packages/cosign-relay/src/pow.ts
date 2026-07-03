import { type Hex, concat, keccak256, pad, toHex } from 'viem'

/**
 * Self-contained hashcash gate (MsgBoard-style, but independent of `@msgboard/core`'s
 * elliptic-curve PoW — this relay only needs a simple leading-zero-bits stamp over a fixed
 * digest, not the board's live-difficulty message PoW). Default difficulty is ~1,000,000 hashes
 * (~1s of grinding), tunable via `POW_BITS` for ops.
 */
export const POW_BITS = Number(process.env.POW_BITS ?? 20)

/** The numeric threshold for `bits` of difficulty: a valid hash must be < 2^256 / 2^bits. */
export function powTarget(bits: number): bigint {
  return 2n ** BigInt(256 - bits)
}

/** `keccak256(digest ++ pad(nonce, 32))` — the hashcash stamp hash. */
export function powHash(digest: Hex, nonce: Hex): Hex {
  return keccak256(concat([digest, pad(nonce, { size: 32 })]))
}

/** True iff `powHash(digest, nonce)`, read as a uint256, is below the `bits`-difficulty target. */
export function verifyPow(digest: Hex, nonce: Hex, bits: number): boolean {
  return BigInt(powHash(digest, nonce)) < powTarget(bits)
}

/** Grinds nonces from 0 upward until one satisfies `bits` of difficulty. Used by tests + callers. */
export function solvePow(digest: Hex, bits: number): Hex {
  for (let i = 0n; ; i += 1n) {
    const nonce = toHex(i, { size: 32 })
    if (verifyPow(digest, nonce, bits)) return nonce
  }
}

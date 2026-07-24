import { concat, keccak256, stringToHex, hexToString, type Hex } from 'viem'

/**
 * Provably-fair coin flip — the pure math behind the Arcade tab.
 *
 * The outcome is the parity of `keccak256(houseSeed ‖ clientSeed)`:
 *   - houseSeed  = the latest chain block hash (public, the player didn't choose it)
 *   - clientSeed = a random hex the player owns (and can re-roll)
 *
 * Neither party controls both inputs, so neither can bias the result: the block hash
 * isn't known when the player fixes their seed intent, and the seed is the player's.
 * The function is a pure `(blockHash, clientSeed) → side` — same inputs always give the
 * same side, so anyone can recompute a flip and confirm it wasn't fudged.
 */

export type FlipSide = 'heads' | 'tails'

export type FlipOutcome = {
  /** The combined digest that decides the flip. */
  digest: Hex
  /** Even digest → heads, odd digest → tails. */
  side: FlipSide
}

/**
 * Compute a flip from the two seeds. Deterministic and side-effect free.
 *
 * `keccak256(blockHash ‖ clientSeed)`; the low bit of the digest picks the face
 * (even = heads, odd = tails).
 */
export function flipOutcome(blockHash: Hex, clientSeed: Hex): FlipOutcome {
  const digest = keccak256(concat([blockHash, clientSeed]))
  const side: FlipSide = (BigInt(digest) & 1n) === 0n ? 'heads' : 'tails'
  return { digest, side }
}

/** A fresh 32-byte client seed from the platform CSPRNG. */
export function randomSeed(): Hex {
  const bytes = new Uint8Array(32)
  ;(globalThis.crypto ?? crypto).getRandomValues(bytes)
  return ('0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')) as Hex
}

/** A published flip as it lives on the board (opt-in showcase record). */
export type FlipRecord = {
  /** What the player called. */
  pick: FlipSide
  /** What the seeds produced. */
  side: FlipSide
  /** pick === side. */
  win: boolean
  /** The player's client seed (so anyone can recompute). */
  seed: Hex
  /** The block number whose hash was the house seed. */
  block: number
}

/** Encode a flip record into board `data` hex (compact JSON). */
export function encodeFlip(record: FlipRecord): Hex {
  return stringToHex(JSON.stringify(record))
}

/** Decode board `data` hex back into a flip record, or `null` if it isn't one. */
export function decodeFlip(data: Hex): FlipRecord | null {
  try {
    const parsed = JSON.parse(hexToString(data)) as Partial<FlipRecord>
    if (
      (parsed.pick === 'heads' || parsed.pick === 'tails') &&
      (parsed.side === 'heads' || parsed.side === 'tails') &&
      typeof parsed.win === 'boolean'
    ) {
      return {
        pick: parsed.pick,
        side: parsed.side,
        win: parsed.win,
        seed: (parsed.seed ?? '0x') as Hex,
        block: typeof parsed.block === 'number' ? parsed.block : 0,
      }
    }
  } catch {
    /* not a flip record */
  }
  return null
}

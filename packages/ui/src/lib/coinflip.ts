import type { Hex } from 'viem'

/**
 * Coin-flip vocabulary + tiny display helpers — the LIGHT half of the Arcade, deliberately free of any
 * `@msgboard/games` / `@msgboard/settle` import so it adds no engine weight to the landing bundle.
 *
 * There is no outcome math here. The flip is a REAL provably-fair commit-reveal round played on
 * msgboard against a house bot (see `arcade-engine.ts`, lazy-loaded): the house commits its server seed
 * (hash) before the player reveals its client seed, so neither side can grind the 50/50, and every step
 * is a signed public board message anyone can re-audit. The outcome is the parity of the co-signed
 * round entropy — computed by `@msgboard/games`' own verified helpers, NEVER re-derived here.
 */

/** Which face — the whole vocabulary of a coin flip. */
export type FlipSide = 'heads' | 'tails'

/** The opposite face. A fair coin has exactly two, so a loss on one implies the other landed. */
export const otherSide = (s: FlipSide): FlipSide => (s === 'heads' ? 'tails' : 'heads')

/** One decoded round for the public "recent flips on the board" feed. */
export type FlipFeedRecord = {
  /** What the player called. */
  pick: FlipSide
  /** What the co-signed round entropy produced. */
  side: FlipSide
  /** pick === side. */
  win: boolean
  /** The session/table the round was played on (its public board anchor). */
  tableId: Hex
}

/** Abbreviate a hex value for display: `0x1234…abcdef`. */
export const shortHex = (h: Hex, lead = 10): string => `${h.slice(0, lead)}…${h.slice(-6)}`

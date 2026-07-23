import { HUNDREDTHS } from './game'

/**
 * ZK skill games — the proof-driven analog of the RNG `Game<TParams>` interface (game.ts).
 *
 * Where an RNG game settles from `raw = roundRandom(...)`, a *skill* game settles from a
 * verified ROUND RESULT: a small, on-chain-checkable summary of play that a ZK proof attests to
 * (Wordle: how many guesses the solve took, each clue proven honest against the committed word;
 * Sudoku: whether a valid solution to the committed puzzle was proven). The economics are NOT a
 * hidden dealer advantage — they are an explicit, PUBLISHED payout curve: a skilled player can beat
 * it, but the "average player" (a documented reference outcome distribution) returns < 1× stake.
 * See wordle.ts / sudoku.ts for each game's reference distribution and the RTP it implies.
 *
 * The on-chain mirror of this math is packages/contracts/contracts/games/SkillPayouts.sol; the
 * proving/verification glue (circuits → proofs → result) lives in the @msgboard/zk-skill peer package,
 * exactly as @msgboard/zk-settle mirrors the RNG settle.
 */

export interface SkillOutcome {
  /** signed player delta in chip base units: >0 player wins from house, <0 player loses. */
  playerDelta: bigint
  win: boolean
  /** multiplier applied, in hundredths (190 == 1.90x); 0 on a loss. */
  multiplierX100: bigint
}

/**
 * A skill game is a pure pair: settle a round from a verified result, and report the escrow ceiling.
 * `TParams` is the bet config (fixed at open); `TResult` is the verified round summary the settle
 * math consumes. Both are proof-attested on-chain before this settle is trusted with real chips.
 */
export interface SkillGame<TParams, TResult> {
  gameId: number
  /** settle one round from its VERIFIED result. `stake` is the chip wager. */
  settleRound(stake: bigint, params: TParams, result: TResult): SkillOutcome
  /**
   * The largest multiplier (×100) the house could owe for a round opened with `params`, BEFORE the
   * result is known — the escrow ceiling. A pure function of `params`. FUNDS-SAFETY: identical
   * contract to game.ts's `maxMultiplierX100` — `escrowHouse` is sized from this, so it MUST be
   * >= `settleRound(...).multiplierX100` for EVERY reachable result.
   */
  maxMultiplierX100(params: TParams): bigint
}

/** win payout (chip units) for a `stake` at `multiplierX100`; the signed delta is this minus stake. */
export function skillPayout(stake: bigint, multiplierX100: bigint): bigint {
  return (stake * multiplierX100) / HUNDREDTHS
}

/**
 * A `SkillOutcome` for `stake` at `multiplierX100` (0 == no payout). `win` means the player came out
 * strictly AHEAD (playerDelta > 0). A sub-1× payout is a partial refund on a weak solve — real chips
 * back, but a net loss — so it is NOT a win; `multiplierX100 == 100` is an exact push (break-even).
 */
export function skillOutcome(stake: bigint, multiplierX100: bigint): SkillOutcome {
  if (multiplierX100 <= 0n) return { win: false, playerDelta: -stake, multiplierX100: 0n }
  const playerDelta = skillPayout(stake, multiplierX100) - stake
  return { win: playerDelta > 0n, playerDelta, multiplierX100 }
}

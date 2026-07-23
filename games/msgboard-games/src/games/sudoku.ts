/**
 * ZK-Sudoku (gameId 31) — a TIMED LEADERBOARD, not a wagered game.
 *
 * Sudoku is deliberately NOT a `SkillGame` (skill.ts) and has NO stake, multiplier, RTP, or escrow.
 * A flat-multiplier bet on a PUBLIC, trivially-automatable solve is strictly -EV for the house, and
 * the proof cannot distinguish a fast human from a bot — so the one thing worth wagering on (skill
 * under time pressure) is exactly what an on-chain proof can't attest. Sudoku is a speedrun with a
 * cryptographic finish line: prove you solved the committed puzzle, and log HOW LONG it took.
 *
 * This module is the off-chain mirror of contracts/games/SudokuLog.sol (the Chips-free leaderboard):
 *   - the house publishes a puzzle, stamping `openedAt`;
 *   - a solver relays a PLONK solve proof (bound to their address via a nullifier, so a mempool
 *     watcher cannot re-bind someone else's solve), which the contract records as
 *     Solved(puzzleId, player, nullifier, solvedAt, elapsed = solvedAt - openedAt).
 * `elapsed` is the ranking key. The proving/verification glue lives in the @msgboard/zk-skill peer
 * package (circuits/sudoku_solve.circom + contracts/zk/SudokuRules.sol); this file only models the
 * leaderboard that the on-chain `Solved` events feed.
 *
 * (Wordle, by contrast, IS still a wagered SkillGame — see wordle.ts — because its payout curve by
 * guesses-used gives the house a defined edge against the reference player.)
 */

export const SUDOKU_GAME_ID = 31

/**
 * One on-chain leaderboard entry — a decoded `SudokuLog.Solved` event. `player` and `nullifier` are
 * field elements exactly as emitted (the player address is bound into the nullifier), kept as bigints
 * so this stays a faithful mirror of the contract's `uint256`s. All times are block timestamps in
 * seconds; `elapsed = solvedAt - openedAt`.
 */
export interface SudokuSolveEntry {
  puzzleId: bigint
  player: bigint
  nullifier: bigint
  solvedAt: bigint
  elapsed: bigint
}

/** A leaderboard entry with its 1-based finishing position (1 = fastest). */
export interface SudokuLeaderboardRow extends SudokuSolveEntry {
  rank: number
}

/**
 * Elapsed solve time (seconds) = `solvedAt - openedAt`, the value SudokuLog stamps into `Solved`.
 * Throws if `solvedAt` precedes `openedAt` (impossible on-chain — a solve can't be logged before the
 * puzzle is opened — so a negative here means the inputs are mismatched/corrupt, not a slow solve).
 */
export function sudokuElapsed(openedAt: bigint, solvedAt: bigint): bigint {
  if (solvedAt < openedAt) {
    throw new Error(`sudokuElapsed: solvedAt (${solvedAt}) precedes openedAt (${openedAt})`)
  }
  return solvedAt - openedAt
}

/**
 * Rank solve entries into a leaderboard: fastest `elapsed` first, ties broken by earlier `solvedAt`,
 * then by `player` (a total, deterministic order so the same events always rank identically).
 *
 * Entries are deduplicated per `player`, keeping that player's BEST (smallest-elapsed) solve — a
 * well-formed Sudoku has a unique solution, so a given player yields one nullifier per puzzle in
 * practice, but this stays correct if a player somehow logs more than once. Pass entries for a SINGLE
 * puzzle; mixing puzzleIds is a caller error (asserted).
 */
export function sudokuLeaderboard(entries: readonly SudokuSolveEntry[]): SudokuLeaderboardRow[] {
  if (entries.length === 0) return []

  const puzzleId = entries[0]!.puzzleId
  const best = new Map<bigint, SudokuSolveEntry>()
  for (const e of entries) {
    if (e.puzzleId !== puzzleId) {
      throw new Error(`sudokuLeaderboard: mixed puzzleIds (${puzzleId} vs ${e.puzzleId}) — rank one puzzle at a time`)
    }
    const prior = best.get(e.player)
    if (prior === undefined || e.elapsed < prior.elapsed) best.set(e.player, e)
  }

  return [...best.values()]
    .sort((a, b) => {
      if (a.elapsed !== b.elapsed) return a.elapsed < b.elapsed ? -1 : 1
      if (a.solvedAt !== b.solvedAt) return a.solvedAt < b.solvedAt ? -1 : 1
      if (a.player !== b.player) return a.player < b.player ? -1 : 1
      return 0
    })
    .map((entry, i) => ({ ...entry, rank: i + 1 }))
}

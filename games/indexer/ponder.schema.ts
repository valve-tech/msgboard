import { onchainTable } from 'ponder'

// One row per indexed CoinFlip/Raffle log. The frontend queries these and runs its EXISTING
// deriveCoinFlipLobby / deriveRaffleRounds over them, so the round logic stays in one place and
// doesn't diverge. Event args are stored as JSON with bigints serialised to strings (JSON/GraphQL
// has no bigint); the frontend re-hydrates the handful of bigint fields it reads.
export const gameEvent = onchainTable('game_event', (t) => ({
  id: t.text().primaryKey(), // `${chainId}-${txHash}-${logIndex}` — unique per log; re-indexing is idempotent
  chainId: t.integer().notNull(), // games are indexed on both chains now — the frontend filters by this
  game: t.text().notNull(), // 'coinflip' | 'raffle' | 'flipbook'
  name: t.text().notNull(), // event name: Entered, Paired, Settled, RoundOpened, Drawn, OfferPosted, …
  args: t.json().notNull(), // decoded args; bigints as decimal strings
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  logIndex: t.integer().notNull(),
}))

// One row per ZK-Sudoku `Solved` log — the on-chain leaderboard the frontend queries (rank by
// `elapsed` per puzzle). Indexed on both chains, so rows are keyed by chainId. `player` and
// `nullifier` are ZK identity/anti-replay commitments (uint256), stored as decimal strings.
export const sudokuSolve = onchainTable('sudoku_solve', (t) => ({
  id: t.text().primaryKey(), // `${chainId}-${txHash}-${logIndex}` — unique per log; idempotent
  chainId: t.integer().notNull(),
  puzzleId: t.bigint().notNull(),
  player: t.text().notNull(), // uint256 ZK player commitment, as a decimal string
  nullifier: t.text().notNull(), // uint256 anti-replay nullifier, as a decimal string
  solvedAt: t.bigint().notNull(),
  elapsed: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}))

// One row per ZK-Sudoku `PuzzleOpened` log — when each puzzle went live, per chain.
export const sudokuPuzzle = onchainTable('sudoku_puzzle', (t) => ({
  id: t.text().primaryKey(), // `${chainId}-${puzzleId}` — one puzzle per chain; idempotent
  chainId: t.integer().notNull(),
  puzzleId: t.bigint().notNull(),
  openedAt: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}))

import { onchainTable } from 'ponder'

// One row per indexed CoinFlip/Raffle log. The frontend queries these (grouped by game/name, ordered
// by blockNumber) and runs its existing deriveCoinFlipLobby/deriveRaffleRounds over them. Event args
// are stored as JSON with bigints serialised to strings (JSON/GraphQL has no bigint); the frontend
// re-hydrates the bigint fields it reads.
export const gameEvent = onchainTable('game_event', (t) => ({
  id: t.text().primaryKey(), // `${chainId}-${txHash}-${logIndex}` — unique per log; re-indexing is idempotent
  chainId: t.integer().notNull(), // games are indexed on 943 AND 369 now — the frontend filters by this
  game: t.text().notNull(), // 'coinflip' | 'raffle' | 'flipbook'
  name: t.text().notNull(), // event name: Entered, Paired, Settled, RoundOpened, Drawn, OfferPosted, …
  args: t.json().notNull(), // decoded args; bigints as decimal strings
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  logIndex: t.integer().notNull(),
}))

// One row per HouseChannel table session.  Opened inserts the row; Settled updates payout+net.
// id: the tableId bytes32 (one session per tableId — Opened is the canonical opener).
// escrowPlayer/payoutPlayer/net: bigint (wei); net = payoutPlayer - escrowPlayer (can be negative).
// payoutPlayer and net are null until Settled fires.
export const settlement = onchainTable('settlement', (t) => ({
  id:             t.hex().primaryKey(),    // tableId (bytes32 hex) — keyed per session
  tableId:        t.hex().notNull(),       // same as id, kept for explicit GraphQL field
  game:           t.text().notNull(),      // 'dice' | 'limbo' | String(gameId) for unknowns
  player:         t.hex().notNull(),       // player address
  escrowPlayer:   t.bigint().notNull(),    // wei locked by player at Opened
  payoutPlayer:   t.bigint(),              // wei returned to player at Settled (null until then)
  net:            t.bigint(),              // payoutPlayer - escrowPlayer (null until Settled)
  blockNumber:    t.bigint().notNull(),    // block of the Opened event
  blockTimestamp: t.bigint().notNull(),    // timestamp of the Opened event
  txHash:         t.hex().notNull(),       // tx of the Opened event
}))

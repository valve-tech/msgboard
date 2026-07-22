import { ponder } from 'ponder:registry'
import { gameEvent, settlement } from 'ponder:schema'
import { openedRow, settledUpdate } from './settlement'

/**
 * Store one game-contract log verbatim. We only read the fields common to every event, so a loose
 * handler arg is fine. Bigints in `args` → strings (JSON has no bigint); the frontend re-hydrates.
 * `id` is unique per log, so re-indexing is idempotent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = (game: 'coinflip' | 'raffle' | 'flipbook' | 'flipbookx', name: string) => async ({ event, context }: any) => {
  const args = JSON.parse(JSON.stringify(event.args ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  await context.db
    .insert(gameEvent)
    .values({
      id: `${context.chain.id}-${event.transaction.hash}-${event.log.logIndex}`,
      chainId: context.chain.id,
      game,
      name,
      args,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
    })
    .onConflictDoNothing()
}

// Register each event directly on `ponder` (same pattern as the box's random-indexer). Call it as a
// METHOD — `ponder.on(...)` — never via a detached alias: `ponder.on` does `this.fns.push(...)`, so
// `const on = ponder.on; on(...)` loses its receiver and throws "Cannot read ... 'fns'". The `as const`
// abis (./abis) give Ponder the event-name union, so these string literals type-check with no cast.
ponder.on('CoinFlip:Entered', store('coinflip', 'Entered'))
ponder.on('CoinFlip:Cancelled', store('coinflip', 'Cancelled'))
ponder.on('CoinFlip:Paired', store('coinflip', 'Paired'))
ponder.on('CoinFlip:Heated', store('coinflip', 'Heated'))
ponder.on('CoinFlip:Settled', store('coinflip', 'Settled'))

ponder.on('Raffle:RoundOpened', store('raffle', 'RoundOpened'))
ponder.on('Raffle:Committed', store('raffle', 'Committed'))
ponder.on('Raffle:TicketCancelled', store('raffle', 'TicketCancelled'))
ponder.on('Raffle:Armed', store('raffle', 'Armed'))
ponder.on('Raffle:Drawn', store('raffle', 'Drawn'))
ponder.on('Raffle:Revealed', store('raffle', 'Revealed'))
ponder.on('Raffle:Finalised', store('raffle', 'Finalised'))
ponder.on('Raffle:NoContest', store('raffle', 'NoContest'))
ponder.on('Raffle:TicketRefunded', store('raffle', 'TicketRefunded'))

// FlipBook (the P2P coin flip offer book): the full offer lifecycle, on both chains. Note the
// event-name overlap with Raffle ('Revealed') — the frontend filters by `game`, never name alone.
ponder.on('FlipBook:OfferPosted', store('flipbook', 'OfferPosted'))
ponder.on('FlipBook:OfferCancelled', store('flipbook', 'OfferCancelled'))
ponder.on('FlipBook:OfferTaken', store('flipbook', 'OfferTaken'))
ponder.on('FlipBook:Revealed', store('flipbook', 'Revealed'))
ponder.on('FlipBook:Forfeited', store('flipbook', 'Forfeited'))
ponder.on('FlipBook:Withdrawn', store('flipbook', 'Withdrawn'))

// FlipBookX (variant B): offers live off-chain, so the chain record STARTS at Taken.
ponder.on('FlipBookX:Taken', store('flipbookx', 'Taken'))
ponder.on('FlipBookX:ChoiceRevealed', store('flipbookx', 'ChoiceRevealed'))
ponder.on('FlipBookX:Settled', store('flipbookx', 'Settled'))
ponder.on('FlipBookX:MakerDefaulted', store('flipbookx', 'MakerDefaulted'))
ponder.on('FlipBookX:TakerDefaulted', store('flipbookx', 'TakerDefaulted'))

// HouseChannel: one settlement row per tableId session.
// Opened → INSERT the open row (game name from gameId, player, escrow).
// Settled → UPDATE the same row with payoutPlayer and net.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
ponder.on('HouseChannel:Opened', async ({ event, context }: any) => {
  const row = openedRow(event)
  await context.db.insert(settlement).values(row).onConflictDoNothing()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
ponder.on('HouseChannel:Settled', async ({ event, context }: any) => {
  const { tableId } = event.args
  const existing = await context.db.find(settlement, { id: tableId })
  if (!existing) return // no matching Opened — skip (e.g. pre-startBlock open)
  const update = settledUpdate(existing, event)
  await context.db.update(settlement, { id: tableId }).set(update)
})

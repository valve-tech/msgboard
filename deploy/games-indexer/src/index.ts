import { ponder } from 'ponder:registry'
import { gameEvent } from 'ponder:schema'

/**
 * Store one game-contract log verbatim. We only read the fields common to every event, so a loose
 * handler arg is fine. Bigints in `args` → strings (JSON has no bigint); the frontend re-hydrates.
 * `id` is unique per log, so re-indexing is idempotent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = (game: 'coinflip' | 'raffle', name: string) => async ({ event, context }: any) => {
  const args = JSON.parse(JSON.stringify(event.args ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  await context.db
    .insert(gameEvent)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
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

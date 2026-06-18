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

// The abis are imported as generic Abi, so Ponder can't derive the event-name union at the type level
// (the names are valid at RUNTIME — registration reads the abi value). Cast `on` to a loose signature.
// IMPORTANT: bind to `ponder` — `ponder.on` is a method that does `this.fns.push(...)`, so a detached
// `const on = ponder.on` loses its receiver and throws "Cannot read properties of undefined (reading 'fns')".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const on = ponder.on.bind(ponder) as unknown as (name: string, handler: (arg: any) => unknown) => void

on('CoinFlip:Entered', store('coinflip', 'Entered'))
on('CoinFlip:Cancelled', store('coinflip', 'Cancelled'))
on('CoinFlip:Paired', store('coinflip', 'Paired'))
on('CoinFlip:Heated', store('coinflip', 'Heated'))
on('CoinFlip:Settled', store('coinflip', 'Settled'))

on('Raffle:RoundOpened', store('raffle', 'RoundOpened'))
on('Raffle:Committed', store('raffle', 'Committed'))
on('Raffle:TicketCancelled', store('raffle', 'TicketCancelled'))
on('Raffle:Armed', store('raffle', 'Armed'))
on('Raffle:Drawn', store('raffle', 'Drawn'))
on('Raffle:Revealed', store('raffle', 'Revealed'))
on('Raffle:Finalised', store('raffle', 'Finalised'))
on('Raffle:NoContest', store('raffle', 'NoContest'))
on('Raffle:TicketRefunded', store('raffle', 'TicketRefunded'))

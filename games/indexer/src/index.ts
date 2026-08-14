import { ponder } from 'ponder:registry'
import { gameEvent } from 'ponder:schema'

/**
 * Store one game-contract log verbatim into `gameEvent`. We only read the fields common to every
 * event (block, tx, log, args), so a loose handler arg is fine — Ponder types each handler per
 * event, but this is intentionally generic. Bigints in `args` are serialised to strings (JSON has no
 * bigint); the frontend re-hydrates. The `id` is unique per log, so re-indexing is idempotent.
 */
const store =
  (game: 'coinflip' | 'raffle' | 'flipbook' | 'operator', name: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, context }: any) => {
    const args = JSON.parse(JSON.stringify(event.args ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    await context.db
      .insert(gameEvent)
      .values({
        id: `${context.network.chainId}-${event.transaction.hash}-${event.log.logIndex}`,
        chainId: context.network.chainId,
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

// games-core exports the ABIs as the generic `viem.Abi`, so Ponder can't derive the event-name
// literal union at the type level (the names are still valid at RUNTIME — registration reads the abi
// value, which carries the events). Cast `on` to a loose signature so the literals typecheck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const on = ponder.on as unknown as (name: string, handler: (arg: any) => unknown) => void

// CoinFlip (the lobby): Entered / Cancelled / Paired / Heated / Settled.
on('CoinFlip:Entered', store('coinflip', 'Entered'))
on('CoinFlip:Cancelled', store('coinflip', 'Cancelled'))
on('CoinFlip:Paired', store('coinflip', 'Paired'))
on('CoinFlip:Heated', store('coinflip', 'Heated'))
on('CoinFlip:Settled', store('coinflip', 'Settled'))

// Raffle (the numbers): the full round lifecycle.
on('Raffle:RoundOpened', store('raffle', 'RoundOpened'))
on('Raffle:Committed', store('raffle', 'Committed'))
on('Raffle:TicketCancelled', store('raffle', 'TicketCancelled'))
on('Raffle:Armed', store('raffle', 'Armed'))
on('Raffle:Drawn', store('raffle', 'Drawn'))
on('Raffle:Revealed', store('raffle', 'Revealed'))
on('Raffle:Finalised', store('raffle', 'Finalised'))
on('Raffle:NoContest', store('raffle', 'NoContest'))
on('Raffle:TicketRefunded', store('raffle', 'TicketRefunded'))

// FlipBook (the P2P coin flip offer book): the full offer lifecycle. Note the name overlap with
// Raffle ('Revealed') — the frontend filters by the `game` column, never by name alone.
on('FlipBook:OfferPosted', store('flipbook', 'OfferPosted'))
on('FlipBook:OfferCancelled', store('flipbook', 'OfferCancelled'))
on('FlipBook:OfferTaken', store('flipbook', 'OfferTaken'))
on('FlipBook:Revealed', store('flipbook', 'Revealed'))
on('FlipBook:Forfeited', store('flipbook', 'Forfeited'))
on('FlipBook:Withdrawn', store('flipbook', 'Withdrawn'))

// Operator substrate (943 only): the game, the shared escrow, the registry, the validator policy.
// LEAK BOUNDARY (spec §5 rule 2): this indexes ONLY the game/escrow/registry/policy events below.
// Do NOT register a Random reveal/cast handler and do NOT store per-round reveal progress here —
// what the backend never materializes, a UI regression cannot leak.
for (const c of ['OperatorCoinFlip', 'OperatorCoinFlipRetired']) {
  on(`${c}:TableCreated`, store('operator', 'TableCreated'))
  on(`${c}:OpenSet`, store('operator', 'OpenSet'))
  on(`${c}:ValidatorPolicySet`, store('operator', 'ValidatorPolicySet'))
  on(`${c}:TableCapSet`, store('operator', 'TableCapSet'))
  on(`${c}:FeesDeposited`, store('operator', 'FeesDeposited'))
  on(`${c}:FeesWithdrawn`, store('operator', 'FeesWithdrawn'))
  on(`${c}:RoundOpened`, store('operator', 'RoundOpened'))
  on(`${c}:RoundSettled`, store('operator', 'RoundSettled'))
  on(`${c}:RoundRefunded`, store('operator', 'RoundRefunded'))
  on(`${c}:ForfeitRouted`, store('operator', 'ForfeitRouted'))
}
on('GameEscrow:BankrollDeposited', store('operator', 'BankrollDeposited'))
on('GameEscrow:BankrollWithdrawn', store('operator', 'BankrollWithdrawn'))
on('GameEscrow:ExposureLocked', store('operator', 'ExposureLocked'))
on('GameEscrow:Settled', store('operator', 'Settled'))
on('GameEscrow:Refunded', store('operator', 'Refunded'))
on('GameEscrow:RakeWithdrawn', store('operator', 'RakeWithdrawn'))
on('OperatorRegistry:Registered', store('operator', 'Registered'))
on('OperatorRegistry:RakeSet', store('operator', 'RakeSet'))
on('OperatorRegistry:RakeRecipientSet', store('operator', 'RakeRecipientSet'))
on('OperatorRegistry:MetadataSet', store('operator', 'MetadataSet'))
on('DefaultValidatorPolicy:ConfigSet', store('operator', 'ConfigSet'))

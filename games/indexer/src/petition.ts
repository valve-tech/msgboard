import { ponder } from 'ponder:registry'
import { petitionSignature } from 'ponder:schema'

// PetitionSignatures' ABI is sourced as a generic `viem.Abi` (the `as const satisfies Abi` in
// @msgboard/petition still widens through Ponder's own Abi type here), so Ponder can't derive the
// event-name literal union or arg types at the type level — the events are still valid at RUNTIME.
// Cast `on` to a loose signature so the `PetitionSignatures:*` literal typechecks, mirroring sudoku.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const on = ponder.on as unknown as (name: string, handler: (arg: any) => unknown) => void

// This handler only fires once PetitionSignatures is actually registered in ponder.config.ts (i.e.
// once PETITION_ADDR_{943,369} is set post-deploy) — see the comment there.

// Signed(bytes32 indexed petitionId, address indexed signer): one settled signer counted once per
// petition, per chain. Keyed by `${chainId}-${petitionId}-${signer}` (NOT by txHash/logIndex) so
// re-indexing is idempotent and the row count directly answers "how many distinct signers".
on('PetitionSignatures:Signed', async ({ event, context }: any) => {
  const chainId = context.network.chainId
  await context.db
    .insert(petitionSignature)
    .values({
      id: `${chainId}-${event.args.petitionId}-${event.args.signer}`,
      chainId,
      petitionId: event.args.petitionId,
      signer: event.args.signer,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

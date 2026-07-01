import { ponder } from 'ponder:registry'
import { safe, safeOwner } from 'ponder:schema'
import { addedOwnerRow, ownerRowId, safeRowId, setupOwnerRows } from './safes'

/**
 * Upsert the `safe` row. SafeSetup carries the initial threshold; other events (Added/Removed/Changed)
 * touch the safe row too so it always exists for the edges that reference it. The FIRST writer sets
 * createdBlock/createdAt; later writers only update the mutable `threshold`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertSafe(context: any, event: any, version: string, threshold: bigint | null) {
  const chainId: number = context.chain.id
  const address: string = event.log.address
  await context.db
    .insert(safe)
    .values({
      id: safeRowId(chainId, address),
      address: address.toLowerCase(),
      chainId,
      threshold,
      version,
      createdBlock: event.block.number,
      createdAt: event.block.timestamp,
    })
    // Keep the earliest createdBlock/createdAt; only refresh threshold when we actually have one.
    .onConflictDoUpdate(() => (threshold === null ? {} : { threshold }))
}

/** SafeSetup → create the safe (with threshold) and insert its initial owner set. */
const onSafeSetup = (version: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, context }: any) => {
    const chainId: number = context.chain.id
    const address: string = event.log.address
    const { owners, threshold } = event.args
    await upsertSafe(context, event, version, threshold as bigint)
    const rows = setupOwnerRows({ chainId, safe: address, owners, block: event.block.number })
    for (const row of rows) {
      await context.db.insert(safeOwner).values(row).onConflictDoNothing()
    }
  }

/** AddedOwner → add one owner edge (and make sure the safe row exists). */
const onAddedOwner = (version: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, context }: any) => {
    const chainId: number = context.chain.id
    const address: string = event.log.address
    await upsertSafe(context, event, version, null)
    const row = addedOwnerRow({ chainId, safe: address, owner: event.args.owner, block: event.block.number })
    await context.db.insert(safeOwner).values(row).onConflictDoNothing()
  }

/** RemovedOwner → delete the owner edge. */
const onRemovedOwner = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, context }: any) => {
    const chainId: number = context.chain.id
    const address: string = event.log.address
    await context.db.delete(safeOwner, { id: ownerRowId(chainId, address, event.args.owner) })
  }

/** ChangedThreshold → update the safe's threshold. */
const onChangedThreshold = (version: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, context }: any) => {
    await upsertSafe(context, event, version, event.args.threshold as bigint)
  }

// Register per Safe generation. Call `ponder.on` as a METHOD with literal event names (never via a
// detached alias) — same rule as games-indexer: `ponder.on` does `this.fns.push(...)`, so a detached
// `const on = ponder.on` loses its receiver. The `as const` abis give the event-name union.
ponder.on('SafeV130:SafeSetup', onSafeSetup('1.3.0'))
ponder.on('SafeV130:AddedOwner', onAddedOwner('1.3.0'))
ponder.on('SafeV130:RemovedOwner', onRemovedOwner())
ponder.on('SafeV130:ChangedThreshold', onChangedThreshold('1.3.0'))

ponder.on('SafeV141:SafeSetup', onSafeSetup('1.4.1'))
ponder.on('SafeV141:AddedOwner', onAddedOwner('1.4.1'))
ponder.on('SafeV141:RemovedOwner', onRemovedOwner())
ponder.on('SafeV141:ChangedThreshold', onChangedThreshold('1.4.1'))

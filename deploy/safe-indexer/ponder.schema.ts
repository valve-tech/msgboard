import { onchainTable, index } from 'ponder'

// One row per discovered Safe (per chain). Because Safe addresses are deterministic CREATE2, the SAME
// address can exist on both 369 and 943, so the primary key is `${chainId}:${safeAddress}` — never the
// bare address. `threshold` is null until SafeSetup (or a later ChangedThreshold) is seen.
export const safe = onchainTable(
  'safe',
  (t) => ({
    id: t.text().primaryKey(), // `${chainId}:${safeAddress}` (lowercased)
    address: t.hex().notNull(), // proxy (safe) address
    chainId: t.integer().notNull(), // 369 | 943
    threshold: t.bigint(), // current signatures-required threshold (null until SafeSetup)
    version: t.text().notNull(), // '1.3.0' | '1.4.1' (which factory minted it)
    createdBlock: t.bigint().notNull(), // block of the first event seen for this safe (SafeSetup)
    createdAt: t.bigint().notNull(), // timestamp of that block
  }),
  (t) => ({
    chainIdx: index().on(t.chainId),
  }),
)

// The owner↔safe many-to-many edge: one row per CURRENT owner of a safe. AddedOwner/SafeSetup insert
// rows; RemovedOwner deletes them, so at any time the live rows are the safe's current owner set. The
// (chainId, owner) index makes the core query — "safes owned by address X on chain C" — a fast lookup.
export const safeOwner = onchainTable(
  'safe_owner',
  (t) => ({
    id: t.text().primaryKey(), // `${chainId}:${safeAddress}:${ownerAddress}` (lowercased)
    chainId: t.integer().notNull(), // 369 | 943
    safe: t.hex().notNull(), // safe (proxy) address
    owner: t.hex().notNull(), // owner address (an EOA or another contract)
    addedBlock: t.bigint().notNull(), // block the owner was added / set up
  }),
  (t) => ({
    ownerIdx: index().on(t.chainId, t.owner), // owner → safes (the Safe Tx Service query)
    safeIdx: index().on(t.chainId, t.safe), // safe → owners
  }),
)

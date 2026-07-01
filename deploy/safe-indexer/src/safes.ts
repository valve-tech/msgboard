/**
 * Pure functions for the Safe ownership indexer.
 *
 * Extracted from the Ponder handlers (src/index.ts) so the row-key derivation and the owner→safes
 * resolver shape can be unit-tested with no live DB or RPC. The handlers are thin wrappers that call
 * these and forward the result to context.db.
 */
import { getAddress } from 'viem'

type Hex = `0x${string}`

/** Lowercase an address for use in composite string keys (hex bytea equality is case-insensitive,
 * but we normalise so the derived text primary keys are stable/idempotent). */
export function norm(addr: string): Hex {
  return addr.toLowerCase() as Hex
}

/** Primary key for a `safe` row: `${chainId}:${safe}` (safe lowercased). CREATE2 makes safe addresses
 * collide across chains, so the chainId MUST be part of the key. */
export function safeRowId(chainId: number, safe: string): string {
  return `${chainId}:${norm(safe)}`
}

/** Primary key for a `safe_owner` edge: `${chainId}:${safe}:${owner}` (both lowercased). */
export function ownerRowId(chainId: number, safe: string, owner: string): string {
  return `${chainId}:${norm(safe)}:${norm(owner)}`
}

/** A `safe_owner` row (matches the onchainTable columns). */
export interface SafeOwnerRow {
  id: string
  chainId: number
  safe: Hex
  owner: Hex
  addedBlock: bigint
}

/**
 * Build the owner rows for a Safe's initial owner set from a decoded SafeSetup event.
 * One row per owner; ids are deterministic so re-indexing is idempotent (onConflictDoNothing).
 */
export function setupOwnerRows(p: {
  chainId: number
  safe: string
  owners: readonly string[]
  block: bigint
}): SafeOwnerRow[] {
  return p.owners.map((owner) => ({
    id: ownerRowId(p.chainId, p.safe, owner),
    chainId: p.chainId,
    safe: norm(p.safe),
    owner: norm(owner),
    addedBlock: p.block,
  }))
}

/** Build a single owner row for an AddedOwner event. */
export function addedOwnerRow(p: {
  chainId: number
  safe: string
  owner: string
  block: bigint
}): SafeOwnerRow {
  return {
    id: ownerRowId(p.chainId, p.safe, p.owner),
    chainId: p.chainId,
    safe: norm(p.safe),
    owner: norm(p.owner),
    addedBlock: p.block,
  }
}

/**
 * The Safe Transaction Service contract: `{ "safes": ["0x…", …] }` with CHECKSUMMED addresses and no
 * duplicates. This is what the cosign app consumes, so it MUST match the Safe Tx Service shape exactly.
 * Input is whatever safe_owner rows the DB returned for a given (owner[, chainId]).
 */
export function ownerSafesResponse(rows: readonly { safe: string }[]): { safes: Hex[] } {
  const seen = new Set<string>()
  const safes: Hex[] = []
  for (const r of rows) {
    const checksummed = getAddress(r.safe as Hex)
    if (seen.has(checksummed)) continue
    seen.add(checksummed)
    safes.push(checksummed)
  }
  return { safes }
}

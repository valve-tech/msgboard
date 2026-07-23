/**
 * Pure row-builder for EAS solve attestations, extracted (like ./settlement) so the schema-UID →
 * game mapping and row shape can be unit-tested without a live DB or RPC.
 */

import { SOLVE_SCHEMAS } from '../schemas'

/** Shape of a row in the `solveAttestation` onchainTable. */
export interface SolveRow {
  id:             string
  chainId:        number
  uid:            `0x${string}`
  game:           string
  schemaUid:      `0x${string}`
  solver:         `0x${string}`
  attester:       `0x${string}`
  blockNumber:    bigint
  blockTimestamp: bigint
  txHash:         `0x${string}`
}

/**
 * Build the solveAttestation row from a decoded EAS:Attested event, or null when the schema UID is
 * not one of ours (the config's log filter already narrows to SOLVE_SCHEMAS keys; this lookup is
 * belt-and-braces, and names the game).
 */
export function solveRow(chainId: number, event: {
  args: {
    recipient: `0x${string}`
    attester:  `0x${string}`
    uid:       `0x${string}`
    schemaUID: `0x${string}`
  }
  block: { number: bigint; timestamp: bigint }
  transaction: { hash: `0x${string}` }
}): SolveRow | null {
  const game = SOLVE_SCHEMAS[event.args.schemaUID]
  if (!game) return null
  return {
    id:             `${chainId}-${event.args.uid}`, // uids are per-EAS-instance; chain disambiguates
    chainId,
    uid:            event.args.uid,
    game,
    schemaUid:      event.args.schemaUID,
    solver:         event.args.recipient,
    attester:       event.args.attester,
    blockNumber:    event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash:         event.transaction.hash,
  }
}

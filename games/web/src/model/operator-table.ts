import type { Address, Hex } from 'viem'
import type { Info } from '@msgboard/games-core'
import type { GameDeployment } from '../config'

/** A round is refundable once its seed is missing AND STALE_BLOCKS have passed since it opened
 *  (GameBase.STALE_BLOCKS). We gate the Refund button on the block gap; the seed-missing half is enforced
 *  on-chain (refundStale reverts TooEarly if a seed finalized). */
export const STALE_BLOCKS = 200n

/** A table's live state — the tables() struct fields plus the cap/locked mappings. */
export type OperatorTable = {
  tableId: Hex; operator: Address; token: Address
  maxMultiplierX100: number; minStake: bigint; maxStake: bigint
  open: boolean; validatorPolicy: Address
  cap: bigint; locked: bigint
}

/** The smallest power-of-two ladder tier >= stake, in [minStake, maxStake]; undefined out of range.
 *  Mirrors OperatorCoinFlip._tierPrice exactly (the contract enforces it on open). */
export const tierPrice = (minStake: bigint, maxStake: bigint, stake: bigint): bigint | undefined => {
  if (stake < minStake || stake > maxStake) return undefined
  let price = minStake
  while (price < stake) price <<= 1n
  return price
}

/** payout = stake * maxMultiplierX100 / 100 (integer division, as on-chain). */
export const payoutFor = (stake: bigint, maxMultiplierX100: number): bigint =>
  (stake * BigInt(maxMultiplierX100)) / 100n

/** Whether a bet of `stake` fits `table` right now: table open, stake in tier range, non-dust payout, and
 *  within the exposure cap (0 = unlimited). Returns a player-readable reason when it does not. */
export const betFits = (table: OperatorTable, stake: bigint): { ok: boolean; reason?: string } => {
  if (!table.open) return { ok: false, reason: 'paused by operator' }
  const price = tierPrice(table.minStake, table.maxStake, stake)
  if (price === undefined) return { ok: false, reason: 'stake is outside the table range' }
  const payout = payoutFor(stake, table.maxMultiplierX100)
  if (payout === stake) return { ok: false, reason: 'stake too small for this edge — a win would pay nothing' }
  const exposure = payout - stake
  if (table.cap !== 0n && table.locked + exposure > table.cap) return { ok: false, reason: 'table is at its exposure cap' }
  return { ok: true }
}

/** Decode the readContract result for one table. `tableTuple` is the 7-field tables() struct
 *  (operator, token, maxMultiplierX100, minStake, maxStake, open, validatorPolicy). */
export const decodeOperatorTable = (
  tableId: Hex,
  tableTuple: readonly unknown[],
  cap: bigint,
  locked: bigint,
): OperatorTable => ({
  tableId,
  operator: tableTuple[0] as Address,
  token: tableTuple[1] as Address,
  maxMultiplierX100: Number(tableTuple[2] as number),
  minStake: tableTuple[3] as bigint,
  maxStake: tableTuple[4] as bigint,
  open: tableTuple[5] as boolean,
  validatorPolicy: tableTuple[6] as Address,
  cap,
  locked,
})

/** The two-step bet plan: the ERC-20 approve targets the ESCROW (it pulls the stake on open), and the
 *  open targets the game with the auto-picked canonical validator subset (spec §5 — the player never
 *  chooses validators). The token to approve is the table's own token, supplied by the caller. */
export const operatorBetPlan = (
  opCfg: NonNullable<GameDeployment['operator']>,
  canonicalSubset: Hex[],
  tableId: Hex,
  side: number,
  stake: bigint,
  locations: Info[],
): { approveTo: Address; openTo: Address; openArgs: readonly [Hex, number, bigint, Hex[], Info[]] } => ({
  approveTo: opCfg.escrow as Address,
  openTo: opCfg.coinFlip as Address,
  openArgs: [tableId, side, stake, canonicalSubset, locations],
})

/** True once STALE_BLOCKS have passed since the round opened (the block-gap half of refundability). */
export const isStale = (openedAtBlock: bigint, head: bigint): boolean =>
  head > 0n && openedAtBlock > 0n && head >= openedAtBlock + STALE_BLOCKS

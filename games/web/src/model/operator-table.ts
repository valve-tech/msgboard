import type { Address, Hex } from 'viem'
import { poolLocationFor, type Info } from '@msgboard/games-core'
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

/** The operator staked validator pool has 64 preimages per section; it rotates from offset 0. */
export const OPERATOR_POOL_SIZE = 64n

/**
 * The heat locations for an operator round. Operator tables heat a SEPARATE, STAKED validator pool that
 * starts at offset 0 — all three canonical validators in lockstep — NOT the free price-0 pools the regular
 * coin-flip/raffle games use. Every round STAKES the tier price in the table's own token, so each Info must
 * carry `token` = the table token and `price` = the tier price (GameBase._heatBoundStaked rejects a
 * mismatch), plus the offset/index from the offset-0 pool rotation. `heatCount` is the number of operator
 * heats already consumed from that pool (== operator rounds opened), so the next round heats slot
 * `heatCount`. Mirrors a live successful open() calldata (token=Chips, price=tierPrice, offset=0, index=N).
 *
 * NOTE: this is why the regular `nextHeatLocations` (free pools, base 7970/…, token=0, price=0) MUST NOT be
 * used for operator tables — those locations revert TokenMismatch/Misconfigured on open().
 */
export const operatorHeatLocations = (
  canonicalSubset: Hex[],
  heatCount: bigint,
  token: Address,
  tierPriceValue: bigint,
): Info[] => {
  const { offset, index } = poolLocationFor(heatCount, 0n, OPERATOR_POOL_SIZE)
  return canonicalSubset.map((provider) => ({
    provider,
    callAtChange: false,
    durationIsTimestamp: false,
    duration: 12n,
    token,
    price: tierPriceValue,
    offset,
    index,
  }))
}

/**
 * The next unconsumed operator heat slot, found by binary-searching the on-chain `consumed()` flag rather
 * than by counting events — so it is independent of indexer coverage and of any retired-contract history
 * the current ABI cannot decode. `isConsumed(k)` reads Random.consumed for the offset-0 pool slot k; it is
 * monotone (true for used slots, false once past them, and callers treat a revert as false). Mirrors the
 * fork rehearsal's findNextHeat. `ceiling` bounds the probe (the pool is small).
 */
export const nextOperatorHeatIndex = async (
  isConsumed: (k: bigint) => Promise<boolean>,
  ceiling = 4096n,
): Promise<bigint> => {
  if (!(await isConsumed(0n))) return 0n
  let lo = 0n // consumed here
  let hi = 1n
  while (hi < ceiling && (await isConsumed(hi))) hi *= 2n
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n
    if (await isConsumed(mid)) lo = mid
    else hi = mid
  }
  return hi
}

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

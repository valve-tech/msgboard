import * as viem from 'viem'
import type { GameDeployment } from '../../config'
import type { PitRound } from '../../lib/backroomIndex'
import { nativeSymbol } from '../Meta'

/** Round age becomes irreversible at `STALE_BLOCKS` (GameBase.STALE_BLOCKS, spec §2.1) — the pit's
 *  countdown and the "stale, no seed" alert both key off this. */
export const STALE_BLOCKS = 200n

/**
 * Headroom formula (Global Constraints, spec §2.2): `bankrollOf` is already net of locked — never
 * subtract `locked` again. `tableCap == 0` means uncapped, so headroom is just the idle bankroll.
 */
export const available = (tableCap: bigint, tableLocked: bigint, bankrollOf: bigint): bigint =>
  tableCap === 0n ? bankrollOf : (tableCap - tableLocked < bankrollOf ? tableCap - tableLocked : bankrollOf)

/** This app only ever wagers two kinds of token today: the chain's native currency, or the Chips
 *  ERC-20 (deployment.chips) — the same "Chips" label CoinFlipTablesScreen uses. An unrecognised
 *  token address is shown by its short form rather than guessing at a symbol. */
export const tokenLabel = (deployment: GameDeployment, token: viem.Address): string => {
  if (deployment.chips && token.toLowerCase() === deployment.chips.toLowerCase()) return 'Chips'
  if (token === viem.zeroAddress) return nativeSymbol(deployment)
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}

/** A wei amount with its token label attached (mirrors Meta.tsx's `fmtAmount`, token-aware). */
export const fmtToken = (deployment: GameDeployment, token: viem.Address, wei: bigint): string =>
  `${viem.formatEther(wei)} ${tokenLabel(deployment, token)}`

/** `x1.80` from a `maxMultiplierX100` (contract fixed-point, ×100). */
export const fmtMult = (multiplierX100: number): string => `x${(multiplierX100 / 100).toFixed(2)}`

/** Non-negative block age; `lastBlock` can lag `atBlock` by a poll's worth of RPC latency. */
export const blocksSince = (lastBlock: bigint, atBlock: bigint): bigint => (lastBlock > atBlock ? lastBlock - atBlock : 0n)

/**
 * The top tierPrice currently visible for a set of tables, estimated from in-flight rounds — the only
 * place a settled tierPrice survives (`TapeEntry` doesn't carry it, and no view exposes "the biggest
 * tier this operator has ever charged"). Returns `null` when the pit is empty for those tables, rather
 * than guessing: fee-runway math only fires when there's a real number behind it.
 */
export const topTierPrice = (pit: PitRound[], tableIds: Set<viem.Hex>): bigint | null => {
  let top: bigint | null = null
  for (const r of pit) {
    if (!tableIds.has(r.tableId)) continue
    if (top === null || r.tierPrice > top) top = r.tierPrice
  }
  return top
}

/** A table's worst-case single-round exposure: the payout at `maxStake` and `maxMultiplierX100`, minus
 *  the stake itself (`EscrowLib.lock` semantics — exposure is what the OPERATOR risks, not the stake,
 *  which is the player's own money passing through). Real numbers from `TableCreated`/the `tables`
 *  view, not an estimate. */
export const maxTableExposure = (maxStake: bigint, maxMultiplierX100: number): bigint =>
  (maxStake * BigInt(maxMultiplierX100 - 100)) / 100n

/** A small coloured status lamp — pending (amber, pulsing live), settling (brass), off (dim). Mirrors
 *  the house's `.cf-lamp` dot but scoped `.brm-lamp` so it can carry its own state colours. */
export const Lamp = ({ state }: { state: 'pending' | 'settling' | 'off' }) => (
  <span className={`brm-lamp brm-lamp-${state}`} aria-hidden />
)

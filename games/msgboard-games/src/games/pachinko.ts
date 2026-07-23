import { encodeAbiParameters, type Hex } from 'viem'
import { HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { plinkoBucket, plinkoEdgedX100, type PlinkoRisk } from './plinko'
import { symmetricBinomialFairTableX100 } from '../rtp'

/**
 * Pachinko — a ball drops through `rows` of pegs, deflecting left/right at each, and lands in one of
 * `rows+1` slots. Mechanically identical to Plinko (binomial bucket); it is a separate catalog entry
 * with its own slot paytable. The bucket math (one seed bit per row) and the edge are reused VERBATIM
 * from the plinko module — only the paytable and gameId differ. Pure single-draw (P2), recompute-settle.
 */
export type PachinkoRisk = PlinkoRisk

export interface PachinkoParams {
  /** number of peg rows; the ball makes `rows` binary deflections and lands in a slot [0, rows]. */
  rows: number
  /** risk profile selecting the multiplier table. */
  risk: PachinkoRisk
}

export const PACHINKO_DEFAULT_ROWS = 12
const MIN_ROWS = 1
const MAX_ROWS = 16

/**
 * Fair (pre-edge) slot multipliers in HUNDREDTHS, symmetric, length rows+1, one table per risk.
 * RTP-CALIBRATED like plinko: a relative shape normalized by `scaledFairTableX100` to a fair mean of
 * exactly 1.00x, so the single per-slot edge gives a verified ~1% house edge (test/rtp.test.ts).
 * Shipped for rows=12 (the pachinko default).
 */
const ROWS = 12
/** relative half-shapes (slots 0..rows/2; the builder mirrors + normalizes the mean to 1.00x). */
const HALF_SHAPES: Record<PachinkoRisk, bigint[]> = {
  low: [100n, 30n, 16n, 12n, 11n, 10n, 9n],
  medium: [2400n, 600n, 200n, 100n, 40n, 20n, 15n],
  high: [42000n, 1800n, 500n, 200n, 60n, 20n, 20n],
}
const FAIR_TABLES_X100: Record<PachinkoRisk, Record<number, readonly bigint[]>> = {
  low: { [ROWS]: symmetricBinomialFairTableX100(ROWS, HALF_SHAPES.low) },
  medium: { [ROWS]: symmetricBinomialFairTableX100(ROWS, HALF_SHAPES.medium) },
  high: { [ROWS]: symmetricBinomialFairTableX100(ROWS, HALF_SHAPES.high) },
}

/** the fair (pre-edge) slot table for a (risk, rows) pair, or throw if unsupported. */
export function pachinkoFairTableX100(risk: PachinkoRisk, rows: number): readonly bigint[] {
  const table = FAIR_TABLES_X100[risk]?.[rows]
  if (!table) throw new Error(`pachinko: no paytable for risk=${risk} rows=${rows}`)
  if (table.length !== rows + 1) throw new Error(`pachinko: paytable length ${table.length} != rows+1 (${rows + 1})`)
  return table
}

/** the edged multiplier (hundredths) for a settled slot. */
export function pachinkoMultiplierX100(risk: PachinkoRisk, rows: number, slot: number): bigint {
  const fair = pachinkoFairTableX100(risk, rows)[slot]
  if (fair === undefined) throw new Error(`pachinko: slot ${slot} out of range`)
  return plinkoEdgedX100(fair)
}

export const pachinko: Game<PachinkoParams> = {
  gameId: 7,
  maxMultiplierX100(params): bigint {
    // The slot is random over [0, rows]; the house must cover the highest-paying slot.
    const table = pachinkoFairTableX100(params.risk, params.rows) // validates risk + rows
    let maxFair = 0n
    for (const fair of table) if (fair > maxFair) maxFair = fair
    return plinkoEdgedX100(maxFair)
  },
  settleRound(stake, params, raw): RoundOutcome {
    if (params.rows < MIN_ROWS || params.rows > MAX_ROWS) throw new Error('pachinko: rows out of range')
    const table = pachinkoFairTableX100(params.risk, params.rows) // validates risk + rows + length
    const slot = plinkoBucket(raw, params.rows) // SAME binomial bucket as plinko
    const fair = table[slot]
    if (fair === undefined) throw new Error(`pachinko: slot ${slot} out of range`)
    const multiplierX100 = plinkoEdgedX100(fair)
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    const win = multiplierX100 >= HUNDREDTHS
    return { win, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint16' }, { type: 'string' }, { type: 'uint256' }] as const,
      [this.gameId, stake, params.rows, params.risk, raw],
    ) as Hex
  },
}

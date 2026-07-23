import { encodeAbiParameters, type Hex } from 'viem'
import { HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { subRandom } from '../rng'

/**
 * Cascade — a tumbling-grid ("Gates of Olympus"-style) slot. A COLS×ROWS grid is filled with symbols,
 * any symbol present at least MIN_MATCH times anywhere on the grid (scatter pays) is paid and removed,
 * the survivors fall down, fresh symbols drop in from the top, and the tumble repeats until a fill
 * produces no win. The TOTAL multiplier is the sum of every tumble's pay.
 *
 * PROVABLY FAIR: the whole tumble is a pure, deterministic function of the round random `raw` — the
 * initial grid AND every refill symbol come from `subRandom(raw, index)`, so anyone can recompute the
 * exact outcome from the revealed seed (there is no per-step house input, hence no co-sign needed; it
 * settles as a single P1 round). The on-chain mirror runs the same tumble loop.
 *
 * BOUNDED: the total is hard-capped at MAX_MULT_X100 (the escrow ceiling — the house escrows to exactly
 * this) and the tumble count at MAX_TUMBLES, so the round always terminates and the payout is bounded
 * for every possible `raw`.
 *
 * RTP: a tumbling slot's edge is not closed-form (it's a branching refill process), so — exactly as
 * real slots are certified — the pay table is calibrated and the realized RTP is verified by a large
 * Monte-Carlo simulation (test/cascade.test.ts), held in a safe band strictly below 100%.
 */
export type CascadeParams = Record<string, never>

export const COLS = 6
export const ROWS = 5
export const CELLS = COLS * ROWS // 30
export const SYMBOLS = 8
/** a symbol pays (scatter) when it appears at least this many times on the grid. */
export const MIN_MATCH = 8
/** hard safety bound on tumbles per round — guarantees termination (natural stop is usually 1–4). */
export const MAX_TUMBLES = 200
/** hard cap on the total round multiplier (×100) — also the escrow ceiling. */
export const MAX_MULT_X100 = 5_000n // 50.00x

/**
 * Per-symbol base pay (×100 of the bet) for the smallest winning cluster. Higher-index symbols are
 * rarer-feeling premiums that pay more; all 8 are equally likely on the grid, so these values (with the
 * cluster-size factor below) are the only economics knob. Calibrated so the simulated RTP sits in the
 * documented band (~0.95) — see test/cascade.test.ts.
 */
export const SYMBOL_BASE_X100: readonly bigint[] = [66n, 82n, 99n, 132n, 181n, 264n, 429n, 742n]

/** cluster-size pays steeply: 8–9 → ×1, 10–11 → ×3, 12+ → ×12 (of the symbol's base). */
export function clusterFactor(count: number): bigint {
  if (count >= 12) return 12n
  if (count >= 10) return 3n
  return 1n
}

/** the pay (×100 of the bet) for a winning cluster of `count` cells of `symbol`. */
export function cascadePayX100(symbol: number, count: number): bigint {
  if (count < MIN_MATCH) return 0n
  const base = SYMBOL_BASE_X100[symbol]
  if (base === undefined) throw new Error(`cascade: symbol ${symbol} out of range`)
  return base * clusterFactor(count)
}

/** the symbol (0..SYMBOLS-1) drawn for the cell filled at stream position `index`. */
export function cascadeSymbol(raw: bigint, index: number): number {
  return Number(subRandom(raw, BigInt(index)) % BigInt(SYMBOLS))
}

export interface CascadeStep {
  /** the grid (length CELLS, index = row*COLS + col, row 0 = top) BEFORE this tumble's removals. */
  grid: number[]
  /** the symbols that paid this tumble. */
  winners: number[]
  /** the cells removed this tumble (true = cleared), aligned to `grid`. */
  removed: boolean[]
  /** the pay (×100 of bet) awarded this tumble. */
  payX100: bigint
}

export interface CascadeResult {
  /** total multiplier (×100), capped at MAX_MULT_X100. */
  totalX100: bigint
  /** each tumble that paid, in order (for the UI animation / dispute replay). */
  steps: CascadeStep[]
  /** the grid left standing after the final (non-paying) fill. */
  finalGrid: number[]
}

/** count occurrences of each symbol on the grid. */
function symbolCounts(grid: number[]): number[] {
  const counts = new Array<number>(SYMBOLS).fill(0)
  for (const s of grid) counts[s]!++
  return counts
}

/**
 * Resolve the full tumble sequence for a round random. Pure and deterministic: identical `raw` always
 * yields the identical result, on or off chain. Drives both the settlement and the UI animation.
 */
export function resolveCascade(raw: bigint): CascadeResult {
  const grid = Array.from({ length: CELLS }, (_, i) => cascadeSymbol(raw, i))
  let nextIndex = CELLS
  let totalX100 = 0n
  const steps: CascadeStep[] = []

  for (let tumble = 0; tumble < MAX_TUMBLES; tumble++) {
    const counts = symbolCounts(grid)
    const winners = counts.map((c, s) => ({ c, s })).filter(({ c }) => c >= MIN_MATCH).map(({ s }) => s)
    if (winners.length === 0) break

    const winSet = new Set(winners)
    const removed = grid.map((s) => winSet.has(s))
    let payX100 = 0n
    for (const s of winners) payX100 += cascadePayX100(s, counts[s]!)

    steps.push({ grid: [...grid], winners, removed, payX100 })
    totalX100 += payX100
    if (totalX100 >= MAX_MULT_X100) { totalX100 = MAX_MULT_X100; break }

    // tumble: within each column, survivors fall to the bottom (keeping order); empty cells at the top
    // are refilled from the seed stream, top-down, so the refill is as deterministic as the first fill.
    for (let col = 0; col < COLS; col++) {
      const survivors: number[] = []
      for (let row = ROWS - 1; row >= 0; row--) {
        const i = row * COLS + col
        if (!removed[i]) survivors.push(grid[i]!) // bottom-up
      }
      for (let row = ROWS - 1; row >= 0; row--) {
        const i = row * COLS + col
        const fromBottom = ROWS - 1 - row
        grid[i] = fromBottom < survivors.length ? survivors[fromBottom]! : cascadeSymbol(raw, nextIndex++)
      }
    }
  }

  return { totalX100, steps, finalGrid: grid }
}

export const cascade: Game<CascadeParams> = {
  gameId: 24,
  maxMultiplierX100(): bigint {
    // The payout is hard-capped, so the ceiling is a constant the house escrows to for every round.
    return MAX_MULT_X100
  },
  settleRound(stake, _params, raw): RoundOutcome {
    const { totalX100 } = resolveCascade(raw)
    const multiplierX100 = totalX100
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    return { win: multiplierX100 >= HUNDREDTHS, playerDelta, multiplierX100 }
  },
  encodeRound(stake, _params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }] as const,
      [this.gameId, stake, raw],
    ) as Hex
  },
}

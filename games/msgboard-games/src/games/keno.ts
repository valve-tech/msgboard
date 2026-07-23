import { encodeAbiParameters, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { binomialWeights, scaledFairTableX100 } from '../rtp'

export interface KenoParams {
  /** the player's chosen numbers: distinct integers in [1, 40], typically 1..10 picks. */
  picks: number[]
  /** how many numbers the round draws of 40, without replacement. Standard keno draws 10. */
  drawn?: number
}

export const POOL = 40 // numbers are 1..40
export const MAX_PICKS = 10
export const DEFAULT_DRAWN = 10 // standard keno draws 10 of 40

// (1 - edge) expressed in hundredths: (10000 - 100)/100 == 99  (i.e. 0.99x == 99).
const ONE_MINUS_EDGE_X100 = (10_000n - EDGE_BPS) / HUNDREDTHS // 99n

/**
 * RTP-CALIBRATED PAYTABLE. Keyed by [number of picks][number of hits] -> "fair" multiplier in
 * hundredths BEFORE the house edge. Each pick-row is built from the true HYPERGEOMETRIC hit
 * probabilities (drawing DEFAULT_DRAWN of POOL) and a rising winner SHAPE, then normalized by
 * `scaledFairTableX100` so the row's probability-weighted fair mean is ~1.00x — after the single edge
 * that is a verified ~1% house edge (test/rtp.test.ts). Losing hit counts (below the pay threshold)
 * stay 0. Index convention: BASE_PAYTABLE_X100[picks][hits], picks in [1,10], hits in [0,picks].
 *
 * The engine (deterministic draw-without-replacement, hit counting, table lookup, edge, payout) is
 * unchanged; only the numbers are now derived from probabilities rather than eyeballed.
 */
const choose = (n: number, k: number): bigint => (k < 0 || k > n ? 0n : binomialWeights(n)[k]!)

/** Build one pick-row: hypergeometric weights × a rising winner shape, normalized to fair mean ~1.0. */
function kenoFairRow(picks: number): bigint[] {
  const payFrom = Math.max(1, Math.floor(picks / 2)) // start paying around half your picks
  const weights: bigint[] = []
  const shape: bigint[] = []
  for (let h = 0; h <= picks; h++) {
    weights.push(choose(picks, h) * choose(POOL - picks, DEFAULT_DRAWN - h)) // C(p,h)·C(40-p,10-h)
    const rank = h - payFrom + 1
    shape.push(rank > 0 ? BigInt(rank * rank * rank) : 0n) // rising jackpot toward all-hits
  }
  return scaledFairTableX100(weights, shape)
}

export const BASE_PAYTABLE_X100: readonly (readonly bigint[])[] = [
  [0n], // picks 0 (unused)
  ...Array.from({ length: MAX_PICKS }, (_, i) => kenoFairRow(i + 1)),
]

/** Apply the 1% house edge to a "fair" multiplier in hundredths. */
export function applyEdgeX100(fairX100: bigint): bigint {
  return (fairX100 * ONE_MINUS_EDGE_X100) / HUNDREDTHS
}

/**
 * Deterministically draw `drawn` distinct numbers of POOL (1..40) WITHOUT replacement, derived
 * from `raw` via a Fisher-Yates partial shuffle. Reproducible / parity-testable: the same `raw`
 * always yields the same set. The pool is consumed back-to-front (positions n-1, n-2, ...), and
 * at each step the swap index is drawn from the remaining [0, i] window using successive base-i
 * digits of `raw`. Returns the drawn values as a set of numbers in [1, 40].
 */
export function kenoDraw(raw: bigint, drawn: number = DEFAULT_DRAWN): Set<number> {
  if (drawn < 0 || drawn > POOL) throw new Error('keno: drawn out of range')
  const pool: number[] = new Array(POOL)
  for (let k = 0; k < POOL; k++) pool[k] = k + 1 // 1..40
  let r = raw
  const result = new Set<number>()
  for (let i = POOL - 1; i >= POOL - drawn; i--) {
    const window = BigInt(i + 1) // pick j in [0, i]
    const j = Number(r % window)
    r = r / window
    // swap pool[i] and pool[j], take pool[i] as a drawn number
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
    result.add(pool[i]!)
  }
  return result
}

/** Count hits: |picks ∩ drawn|. */
export function kenoHits(picks: number[], drawn: Set<number>): number {
  let hits = 0
  for (const p of picks) if (drawn.has(p)) hits++
  return hits
}

function validatePicks(picks: number[]): void {
  if (picks.length < 1 || picks.length > MAX_PICKS) throw new Error('keno: picks count out of range [1,10]')
  const seen = new Set<number>()
  for (const p of picks) {
    if (!Number.isInteger(p) || p < 1 || p > POOL) throw new Error('keno: pick out of range [1,40]')
    if (seen.has(p)) throw new Error('keno: duplicate pick')
    seen.add(p)
  }
}

export const keno: Game<KenoParams> = {
  // NOTE: gameId 4 chosen to avoid colliding with Plinko, which is expected to take 3
  // (dice=1, limbo=2). Reconcile with the Plinko module's id before release.
  gameId: 4,
  maxMultiplierX100(params): bigint {
    // Payout depends on how many picks hit (random); the house must cover the best row entry, edged.
    validatePicks(params.picks)
    const row = BASE_PAYTABLE_X100[params.picks.length] ?? []
    let maxFair = 0n
    for (const fair of row) if (fair > maxFair) maxFair = fair
    return applyEdgeX100(maxFair)
  },
  settleRound(stake, params, raw): RoundOutcome {
    validatePicks(params.picks)
    const drawn = params.drawn ?? DEFAULT_DRAWN
    if (drawn < 1 || drawn > POOL) throw new Error('keno: drawn out of range [1,40]')
    const draw = kenoDraw(raw, drawn)
    const hits = kenoHits(params.picks, draw)
    const fairX100 = BASE_PAYTABLE_X100[params.picks.length]?.[hits] ?? 0n
    const multiplierX100 = applyEdgeX100(fairX100)
    // win if the payout exceeds the stake (multiplier > 1.00x == 100).
    const win = multiplierX100 > HUNDREDTHS
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: multiplierX100 > 0n ? multiplierX100 : 0n }
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    const picks = params.picks.map((p) => BigInt(p))
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256[]' }, { type: 'uint256' }] as const,
      [this.gameId, stake, picks, raw],
    ) as Hex
  },
}

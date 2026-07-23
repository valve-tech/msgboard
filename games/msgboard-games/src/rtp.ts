import { EDGE_BPS, HUNDREDTHS } from './game'

/**
 * RTP (return-to-player) toolkit — turns the games' paytables from "eyeballed, edge unknown" into
 * "computed, verified, bounded." A table's REALIZED house edge is a pure function of its outcome
 * probabilities and its edged multipliers; these helpers compute it exactly so a test can assert every
 * table is (a) never player-favorable (RTP ≤ 100%) and (b) within its documented band.
 *
 * For the symmetric-binomial games (Plinko, Pachinko) the FAIR table is built here with an exact
 * weighted mean of 1.00x, so after the per-bucket edge the realized RTP is 99% minus only the tiny
 * per-bucket flooring loss — a provable ~1% house edge by construction (never player-favorable).
 */

const BPS = 10_000n

/** RTP in basis points (10000 == 100%) for a discrete distribution: Σ wᵢ·multX100ᵢ / Σ wᵢ, ·100. */
export function rtpBps(outcomes: { weight: bigint; multX100: bigint }[]): bigint {
  let num = 0n
  let totalWeight = 0n
  for (const { weight, multX100 } of outcomes) {
    num += weight * multX100
    totalWeight += weight
  }
  if (totalWeight === 0n) throw new Error('rtp: zero total weight')
  return (num * HUNDREDTHS) / totalWeight // (multX100/100) is the return ratio; ·10000 bps == ·100·multX100
}

/** Binomial outcome weights C(n,0..n) (the un-normalized P for a fair left/right peg drop). */
export function binomialWeights(n: number): bigint[] {
  const row: bigint[] = [1n]
  for (let k = 1; k <= n; k++) row.push((row[k - 1]! * BigInt(n - k + 1)) / BigInt(k))
  return row
}

/**
 * Build a fair-multiplier table (hundredths) from a relative `shape` and the outcomes' integer
 * `weights`, normalized so the weighted mean is EXACTLY 1.00x (Σ wᵢ·fairᵢ = (Σ wᵢ)·100). The shape
 * sets the look (volatility); the normalization sets the economics. This is how all the table games get
 * a provable ~1% edge: a fair-mean-1.0 table, then the single per-outcome edge → ~99% RTP.
 *
 * Method: scale the shape to the target, FLOOR each bucket, then cover the small leftover deficit using
 * the largest weights first (each +1 there is a negligible visual shift); a weight-1 outcome finishes
 * it exactly. If no weight-1 outcome exists, the smallest-weight bucket absorbs the last bit (mean then
 * within one smallest-weight of exact — still provably bounded by the RTP test).
 */
export function scaledFairTableX100(weights: bigint[], shape: bigint[]): bigint[] {
  if (weights.length !== shape.length) throw new Error('rtp: weights and shape length mismatch')
  const W = weights.reduce((a, b) => a + b, 0n)
  const target = W * HUNDREDTHS
  const S = weights.reduce((a, w, i) => a + w * shape[i]!, 0n)
  if (S === 0n) throw new Error('rtp: zero-weighted shape')
  const fair = shape.map((s) => (s * target) / S) // floor
  const weighted = () => weights.reduce((a, w, i) => a + w * fair[i]!, 0n)
  let deficit = target - weighted()
  // distribute the leftover ONLY across buckets the shape marked as winners (shape > 0), largest weight
  // first (tiny visual shift); this keeps zero-shape outcomes — e.g. keno's losing hit counts — at 0.
  const winners = fair
    .map((_, i) => i)
    .filter((i) => shape[i]! > 0n)
    .sort((a, b) => (weights[b]! > weights[a]! ? 1 : weights[b]! < weights[a]! ? -1 : 0))
  for (const i of winners) {
    if (deficit <= 0n) break
    const q = deficit / weights[i]!
    if (q > 0n) { fair[i]! += q; deficit -= q * weights[i]! }
  }
  if (deficit > 0n && winners.length > 0) {
    // last bit not divisible by any winner weight — add to the smallest-weight winner (tiny overshoot).
    fair[winners[winners.length - 1]!]! += 1n
  }
  return fair
}

/**
 * Symmetric binomial fair table (length rows+1) from a `halfShape` of length rows/2+1 (buckets
 * 0..rows/2), normalized to a fair mean of ~1.00x and MIRRORED so left/right are identical. Mirror
 * pairs are folded into single outcomes (weight 2·C(rows,k); the centre keeps weight C) before
 * normalization, so the deficit coverage can never break symmetry. For plinko/pachinko.
 */
export function symmetricBinomialFairTableX100(rows: number, halfShape: bigint[]): bigint[] {
  if (rows % 2 !== 0) throw new Error('rtp: rows must be even')
  const half = rows / 2
  if (halfShape.length !== half + 1) throw new Error(`rtp: halfShape must have length rows/2+1 (${half + 1})`)
  const C = binomialWeights(rows)
  const foldedWeights = halfShape.map((_, k) => (k === half ? C[half]! : 2n * C[k]!))
  const halfFair = scaledFairTableX100(foldedWeights, halfShape)
  const full: bigint[] = new Array(rows + 1)
  for (let k = 0; k <= half; k++) {
    full[k] = halfFair[k]!
    full[rows - k] = halfFair[k]!
  }
  return full
}

/** Apply the standard 1% edge to a fair multiplier (hundredths), flooring — mirrors the game helpers. */
export function edgedX100(fairX100: bigint): bigint {
  return (fairX100 * (BPS - EDGE_BPS)) / BPS
}

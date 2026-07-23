import { encodeAbiParameters, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS, type Game, type RoundOutcome } from '../game'
import { scaledFairTableX100 } from '../rtp'

export type WheelRisk = 'low' | 'medium' | 'high'

export interface WheelParams {
  /** number of equal segments on the wheel; the pointer lands on `raw % segments`. */
  segments: number
  /** risk profile selecting the multiplier table. */
  risk: WheelRisk
}

const BPS = 10_000n
export const SUPPORTED_SEGMENTS = [10, 20, 30, 40, 50] as const

/**
 * Relative segment SHAPE per risk (volatility profile). The economics come from normalization, not
 * these numbers: `scaledFairTableX100` rescales the shape so the uniform-weighted fair mean is exactly
 * 1.00x, and the single per-segment edge then yields a verified ~1% house edge (test/rtp.test.ts).
 *   - low: most segments win a little, ~20% lose (a near-flat wheel);
 *   - medium: half lose, the rest pay moderate, one big spike;
 *   - high: a single jackpot segment carries the whole wheel (segments× before edge), the rest lose.
 */
function wheelShape(risk: WheelRisk, segments: number): bigint[] {
  const s = new Array<bigint>(segments).fill(0n)
  if (risk === 'low') {
    for (let i = 0; i < segments; i++) s[i] = i % 5 === 0 ? 0n : 13n
  } else if (risk === 'medium') {
    for (let i = 0; i < segments; i++) s[i] = i % 2 === 0 ? 0n : 20n
    s[segments - 1] = 90n // one big spike
  } else {
    s[segments - 1] = 1n // single jackpot segment
  }
  return s
}

const UNIFORM = (segments: number): bigint[] => new Array<bigint>(segments).fill(1n)

const TABLE_CACHE = new Map<string, readonly bigint[]>()

/** the fair (pre-edge) segment table for a (risk, segments) pair — RTP-normalized, memoized. */
export function wheelFairTableX100(risk: WheelRisk, segments: number): readonly bigint[] {
  if (!(SUPPORTED_SEGMENTS as readonly number[]).includes(segments)) {
    throw new Error(`wheel: no paytable for segments=${segments}`)
  }
  const key = `${risk}:${segments}`
  let table = TABLE_CACHE.get(key)
  if (!table) {
    table = scaledFairTableX100(UNIFORM(segments), wheelShape(risk, segments))
    TABLE_CACHE.set(key, table)
  }
  return table
}

/** apply the house edge to a fair multiplier (hundredths in, hundredths out): floor(fair*(1-edge)). */
export function wheelEdgedX100(fairX100: bigint): bigint {
  return (fairX100 * (BPS - EDGE_BPS)) / BPS
}

/** the segment the pointer lands on, in [0, segments-1]. */
export function wheelSegment(raw: bigint, segments: number): number {
  return Number(raw % BigInt(segments))
}

/** the edged multiplier (hundredths) for a settled segment. */
export function wheelMultiplierX100(risk: WheelRisk, segments: number, segment: number): bigint {
  const fair = wheelFairTableX100(risk, segments)[segment]
  if (fair === undefined) throw new Error(`wheel: segment ${segment} out of range`)
  return wheelEdgedX100(fair)
}

export const wheel: Game<WheelParams> = {
  gameId: 8,
  maxMultiplierX100(params): bigint {
    // The segment is random over [0, segments-1]; the house must cover the highest-paying segment.
    const table = wheelFairTableX100(params.risk, params.segments) // validates risk + segments
    let maxFair = 0n
    for (const fair of table) if (fair > maxFair) maxFair = fair
    return wheelEdgedX100(maxFair)
  },
  settleRound(stake, params, raw): RoundOutcome {
    const table = wheelFairTableX100(params.risk, params.segments) // validates risk + segments
    const segment = wheelSegment(raw, params.segments)
    const fair = table[segment]
    if (fair === undefined) throw new Error(`wheel: segment ${segment} out of range`)
    const multiplierX100 = wheelEdgedX100(fair)
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    const win = multiplierX100 >= HUNDREDTHS
    return { win, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint16' }, { type: 'string' }, { type: 'uint256' }] as const,
      [this.gameId, stake, params.segments, params.risk, raw],
    ) as Hex
  },
}

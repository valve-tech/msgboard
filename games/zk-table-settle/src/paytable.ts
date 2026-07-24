import { encodeAbiParameters, keccak256, type Hex } from 'viem'

/**
 * The GENERIC piecewise-constant paytable that drives the table-settle circuit.
 *
 * A pure-RNG round produces a single reduced draw `bucket = r % outcomeSpace`.
 * The payout multiplier is a STEP FUNCTION of that bucket, encoded as an ordered
 * list of half-open segments [prevHi, hi) each carrying a `multX100`. The segments
 * MUST be strictly ascending in `hi` and contiguous from 0, and the last `hi` MUST
 * equal `outcomeSpace` (the circuit asserts exactly this). Every pure-RNG game is
 * an instance:
 *   dice@target -> [(target, winMult), (10000, 0)]                (outcomeSpace 10000)
 *   limbo@target-> [(uWin, 0), (1e6, targetMult)]                 (outcomeSpace 1e6)
 *   roulette    -> 37 unit segments, one multX100 per wheel slot  (outcomeSpace 37)
 */
export interface Segment {
  /** exclusive upper bound of this segment (ascending across the table). */
  hi: bigint
  /** payout multiplier in hundredths (1.00x == 100) for a bucket in this segment. */
  multX100: bigint
}

export interface RangeTable {
  /** the bucket modulus: bucket = r % outcomeSpace. */
  outcomeSpace: bigint
  /** ascending, contiguous segments covering [0, outcomeSpace). */
  segments: Segment[]
}

/** Compile-time paytable capacity of the circuit (test-circuits/tableSettleOnchain, MAX_SEG). */
export const MAX_SEG = 64

const HUNDREDTHS = 100n
const EDGE_BPS = 100n // 1% house edge — mirrors @msgboard/games game.ts
const BPS = 10_000n

/** Assert a table is well-formed exactly as the circuit requires; throws otherwise. */
export function assertWellFormed(table: RangeTable): void {
  const { outcomeSpace, segments } = table
  if (outcomeSpace <= 0n) throw new Error('paytable: outcomeSpace must be positive')
  if (outcomeSpace > 1_000_000n) throw new Error('paytable: outcomeSpace exceeds MAX_OUTCOME_SPACE (1e6)')
  if (segments.length === 0) throw new Error('paytable: at least one segment required')
  if (segments.length > MAX_SEG) throw new Error(`paytable: more than MAX_SEG (${MAX_SEG}) segments`)
  let prev = 0n
  for (const s of segments) {
    if (s.hi <= prev) throw new Error('paytable: segment bounds not strictly ascending')
    if (s.multX100 < 0n) throw new Error('paytable: negative multiplier')
    prev = s.hi
  }
  if (prev !== outcomeSpace) throw new Error('paytable: segments do not cover outcomeSpace')
}

/** The multX100 the table pays for a given bucket (the circuit's lookup, in TS). */
export function lookupMultX100(table: RangeTable, bucket: bigint): bigint {
  let prev = 0n
  for (const s of table.segments) {
    if (bucket >= prev && bucket < s.hi) return s.multX100
    prev = s.hi
  }
  throw new Error('paytable: bucket outside outcomeSpace')
}

// ------------------------------------------------------------------ game tables

/**
 * dice roll-under target (gameId 1). Mirrors GamePayouts._dice / dice.ts:
 *   multX100 = (10000 - EDGE_BPS) * 10000 / targetX100 / 100 ; win iff roll < target.
 * Two segments: [0, target) pays the win multiplier, [target, 10000) pays 0.
 */
export function diceTable(targetX100: bigint): RangeTable {
  if (targetX100 < 1n || targetX100 > 9899n) throw new Error('dice: target out of range')
  const ROLL_SPACE = 10_000n
  const winMult = (ROLL_SPACE - EDGE_BPS) * ROLL_SPACE / targetX100 / HUNDREDTHS
  return {
    outcomeSpace: ROLL_SPACE,
    segments: [
      { hi: targetX100, multX100: winMult },
      { hi: ROLL_SPACE, multX100: 0n },
    ],
  }
}

/**
 * European roulette (37 slots, 0..36). One UNIT segment per slot, so an arbitrary
 * per-slot payout (interleaved red/black etc.) is expressible. `slotMult[k]` is the
 * multX100 paid when bucket == k. A straight-up win pays 35:1 => 36x return => 3600;
 * an even-money color/parity win pays 1:1 => 2x return => 200; 0 loses those.
 */
const ROULETTE_SLOTS = 37n
export const ROULETTE_RED = new Set<number>([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
])

function rouletteTable(slotMult: (k: number) => bigint): RangeTable {
  const segments: Segment[] = []
  for (let k = 0; k < 37; k++) segments.push({ hi: BigInt(k) + 1n, multX100: slotMult(k) })
  return { outcomeSpace: ROULETTE_SLOTS, segments }
}

/** Straight-up bet on a single number (0..36): 35:1, i.e. 3600 on a hit, 0 otherwise. */
export function rouletteStraightUpTable(pick: number): RangeTable {
  if (pick < 0 || pick > 36) throw new Error('roulette: number out of range')
  return rouletteTable((k) => (k === pick ? 3600n : 0n))
}

/** Even-money color bet: 200 on a matching-color slot, 0 on the other color and on 0 (green). */
export function rouletteColorTable(color: 'red' | 'black'): RangeTable {
  return rouletteTable((k) => {
    if (k === 0) return 0n // green: color bets lose
    const isRed = ROULETTE_RED.has(k)
    const win = color === 'red' ? isRed : !isRed
    return win ? 200n : 0n
  })
}

// ------------------------------------------------------- params encoding / hash

/**
 * The canonical on-chain params encoding for a table round. This is the `params`
 * bytes that HouseChannel.settleWithProof binds to the house-signed paramsHash
 * (`keccak256(params) == t.paramsHash`) and DECODES into the verifier's public
 * inputs — the table analog of `abi.encode(uint256 targetX100)` for dice.
 *
 * Layout: abi.encode(uint256 outcomeSpace, uint256[] hi, uint256[] multX100).
 * (Integration into HouseChannel is deferred; this pins the encoding the circuit's
 * public inputs and a future settleWithProof-for-tables must agree on.)
 */
export function encodeTableParams(table: RangeTable): Hex {
  assertWellFormed(table)
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256[]' }, { type: 'uint256[]' }],
    [table.outcomeSpace, table.segments.map((s) => s.hi), table.segments.map((s) => s.multX100)],
  ) as Hex
}

/** paramsHash for a table round: keccak256 of the canonical params encoding above. */
export function paramsHashOfTable(table: RangeTable): Hex {
  return keccak256(encodeTableParams(table))
}

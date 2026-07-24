import type { InputMap } from '@noir-lang/noir_js'
import { keccak256, type Hex } from 'viem'
import { roundRandom } from '@msgboard/games'
import { assertWellFormed, lookupMultX100, MAX_SEG, type RangeTable } from './paytable'

/**
 * The GENERIC table-settle witness builder — the TS twin of
 * test-circuits/tableSettleOnchain/src/main.nr. It mirrors zk-settle's
 * diceSettleOnchain.ts API shape (round -> publics -> InputMap), but the payout is
 * a piecewise-constant paytable lookup instead of per-game arithmetic, so ONE
 * builder + ONE circuit serve every pure-RNG game.
 *
 * Seeds are PRIVATE witnesses (never in calldata); the paytable + escrows + payout
 * are PUBLIC. Public-input order MUST match the circuit's `pub` parameter order:
 *   rngCommit[32] | clientSeedCommit[32] | outcomeSpace | segCount |
 *   hi[MAX_SEG] | mult[MAX_SEG] | escrowPlayer | escrowHouse | payoutPlayer
 */

export interface TableRound {
  serverSeed: Hex
  clientSeed: Hex
  table: RangeTable
  escrowPlayer: bigint // == stake
  escrowHouse: bigint
}

export interface TablePublics {
  rngCommit: Hex
  clientSeedCommit: Hex
  outcomeSpace: bigint
  segCount: bigint
  hi: bigint[] // padded to MAX_SEG
  mult: bigint[] // padded to MAX_SEG
  escrowPlayer: bigint
  escrowHouse: bigint
  payoutPlayer: bigint
}

const u64 = (v: bigint) => '0x' + v.toString(16)

/** A 32-byte hex -> array of 32 byte-hex strings, the [u8; 32] noir shape. */
function bytes32ToByteArray(h: Hex): string[] {
  const hex = h.slice(2).padStart(64, '0')
  const out: string[] = []
  for (let i = 0; i < 32; i++) out.push('0x' + hex.slice(i * 2, i * 2 + 2))
  return out
}

/** The reduced round bucket: bucket = uint256(keccak256(abi.encode(seeds,1))) % outcomeSpace. */
export function tableBucket(round: TableRound): bigint {
  const r = roundRandom(round.serverSeed, round.clientSeed, 1n)
  return r % round.table.outcomeSpace
}

/**
 * The conserved player payout for a table round: stake * multX100 / 100, where
 * multX100 is the matching paytable segment for this round's bucket. Computed from
 * the REAL roundRandom (never re-derived), matching the circuit exactly.
 */
export function tablePayout(round: TableRound): bigint {
  assertWellFormed(round.table)
  const multX100 = lookupMultX100(round.table, tableBucket(round))
  return (round.escrowPlayer * multX100) / 100n
}

/** Pad an array of bigints to MAX_SEG with zeros (the inactive tail the circuit ignores). */
function padSeg(xs: bigint[]): bigint[] {
  const out = xs.slice()
  while (out.length < MAX_SEG) out.push(0n)
  return out
}

/** Build the public-input view of a table round (what prover and contract agree on). */
export function tablePublics(round: TableRound): TablePublics {
  assertWellFormed(round.table)
  const { segments, outcomeSpace } = round.table
  return {
    rngCommit: keccak256(round.serverSeed),
    clientSeedCommit: keccak256(round.clientSeed),
    outcomeSpace,
    segCount: BigInt(segments.length),
    hi: padSeg(segments.map((s) => s.hi)),
    mult: padSeg(segments.map((s) => s.multX100)),
    escrowPlayer: round.escrowPlayer,
    escrowHouse: round.escrowHouse,
    payoutPlayer: tablePayout(round),
  }
}

/** Build the full Noir InputMap for the tableSettleOnchain circuit. */
export function tableSettleInputs(round: TableRound): InputMap {
  const p = tablePublics(round)
  return {
    rngCommit: bytes32ToByteArray(p.rngCommit),
    clientSeedCommit: bytes32ToByteArray(p.clientSeedCommit),
    outcomeSpace: u64(p.outcomeSpace),
    segCount: u64(p.segCount),
    hi: p.hi.map(u64),
    mult: p.mult.map(u64),
    escrowPlayer: u64(p.escrowPlayer),
    escrowHouse: u64(p.escrowHouse),
    payoutPlayer: u64(p.payoutPlayer),
    serverSeed: bytes32ToByteArray(round.serverSeed),
    clientSeed: bytes32ToByteArray(round.clientSeed),
  }
}

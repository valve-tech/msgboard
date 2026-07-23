import type { InputMap } from '@noir-lang/noir_js'
import { keccak256, type Hex } from 'viem'
import { dice, roundRandom } from '@msgboard/games'

/**
 * M2 (Track-2, Milestone 2) — the ON-CHAIN dice settle witness builder.
 *
 * Mirrors `test-circuits/diceSettleOnchain/src/main.nr`. Unlike the off-chain M1
 * `diceSettle` (hidden amounts via Pedersen), the on-chain variant exposes the
 * escrows + the player payout as PUBLIC inputs — the contract must learn the
 * real chip split to transfer it — while keeping serverSeed/clientSeed PRIVATE.
 * The seeds therefore NEVER appear in calldata (the win over mode-1
 * `settleWithSeeds`, which publishes both seeds); the proof attests, in zero
 * knowledge, that they hash to the house-signed commits and produce this payout.
 *
 * Public-input order (must match the circuit's `pub` parameter order — this is
 * the order the on-chain verifier's `publicInputs[]` array expects):
 *   rngCommit[0..31], clientSeedCommit[0..31], targetX100, escrowPlayer,
 *   escrowHouse, payoutPlayer  => 32 + 32 + 4 = 68 field elements.
 */

export interface DiceOnchainRound {
  serverSeed: Hex
  clientSeed: Hex
  targetX100: bigint
  escrowPlayer: bigint // == stake
  escrowHouse: bigint
}

export interface DiceOnchainPublics {
  rngCommit: Hex
  clientSeedCommit: Hex
  targetX100: bigint
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

/**
 * The conserved player payout for a round, from the REAL `roundRandom` +
 * `dice.settleRound` (never re-derived). `payoutPlayer` is what the contract
 * transfers to the player; `escrowHouse + stake - payoutPlayer` returns to the
 * house pool. balancePlayer in dice.settleRound == the payout (escrowPlayer is
 * the stake), so this is the same value `GamePayouts.settle` returns.
 */
export function diceOnchainPayout(round: DiceOnchainRound): bigint {
  const r = roundRandom(round.serverSeed, round.clientSeed, 1n)
  const o = dice.settleRound(round.escrowPlayer, { targetX100: round.targetX100 }, r)
  // playerDelta is signed; payout = stake + delta (win: stake+profit, loss: 0).
  return round.escrowPlayer + o.playerDelta
}

/** Build the public-input view of a round (what both the prover and the
 *  contract agree on). */
export function diceOnchainPublics(round: DiceOnchainRound): DiceOnchainPublics {
  return {
    rngCommit: keccak256(round.serverSeed),
    clientSeedCommit: keccak256(round.clientSeed),
    targetX100: round.targetX100,
    escrowPlayer: round.escrowPlayer,
    escrowHouse: round.escrowHouse,
    payoutPlayer: diceOnchainPayout(round),
  }
}

/** Build the full Noir InputMap for the diceSettleOnchain circuit. */
export function diceOnchainInputs(round: DiceOnchainRound): InputMap {
  const p = diceOnchainPublics(round)
  return {
    rngCommit: bytes32ToByteArray(p.rngCommit),
    clientSeedCommit: bytes32ToByteArray(p.clientSeedCommit),
    targetX100: u64(p.targetX100),
    escrowPlayer: u64(p.escrowPlayer),
    escrowHouse: u64(p.escrowHouse),
    payoutPlayer: u64(p.payoutPlayer),
    serverSeed: bytes32ToByteArray(round.serverSeed),
    clientSeed: bytes32ToByteArray(round.clientSeed),
  }
}

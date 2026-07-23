import type { InputMap } from '@noir-lang/noir_js'
import { keccak256, type Hex } from 'viem'
import { dice, roundRandom } from '@msgboard/games'
import { pedersenCommit, type PedersenPoint } from './pedersen'

/**
 * Task 4 — the dice PRIVACY settle statement (hidden amounts + conservation).
 *
 * This is the privacy version of Track-1's recompute statement. The dice payout
 * math is reproduced in-circuit in the EXACT GamePayouts / dice.ts operation
 * order; the bet `stake` and the open/final balances are HIDDEN (private
 * witnesses), and only their Pedersen commitments are public. An independent
 * verifier checks conservation between the committed values without learning the
 * amounts.
 *
 * Hidden vs public (mirrors the plan's table):
 *   PUBLIC  : rngCommit = keccak256(serverSeed)
 *             clientSeedCommit = keccak256(clientSeed)
 *             targetX100 (the bet odds — public)
 *             commitments to stake, openBalancePlayer, openBalanceHouse,
 *                            finalBalancePlayer, finalBalanceHouse
 *   PRIVATE : serverSeed, clientSeed,
 *             stake, openBalancePlayer, openBalanceHouse,
 *             finalBalancePlayer, finalBalanceHouse, and their blindings
 *
 * nonce is hardcoded 1 (never a witness — same soundness rule as settleWithSeeds).
 */

export interface DiceSettleAmounts {
  stake: bigint
  openBalancePlayer: bigint
  openBalanceHouse: bigint
  finalBalancePlayer: bigint
  finalBalanceHouse: bigint
}

export interface DiceSettleBlindings {
  stake: bigint
  openBalancePlayer: bigint
  openBalanceHouse: bigint
  finalBalancePlayer: bigint
  finalBalanceHouse: bigint
}

export interface DiceSettleWitness {
  serverSeed: Hex
  clientSeed: Hex
  targetX100: bigint
  amounts: DiceSettleAmounts
  blindings: DiceSettleBlindings
}

/** The five public Pedersen commitments, one per hidden amount. */
export interface DiceSettleCommitments {
  stake: PedersenPoint
  openBalancePlayer: PedersenPoint
  openBalanceHouse: PedersenPoint
  finalBalancePlayer: PedersenPoint
  finalBalanceHouse: PedersenPoint
}

/** A 32-byte hex string -> array of 32 byte-hex strings, the [u8; 32] noir shape. */
function bytes32ToByteArray(h: Hex): string[] {
  const hex = h.slice(2).padStart(64, '0')
  const out: string[] = []
  for (let i = 0; i < 32; i++) out.push('0x' + hex.slice(i * 2, i * 2 + 2))
  return out
}

const u64 = (v: bigint) => '0x' + v.toString(16)
const field = (v: bigint) => '0x' + v.toString(16)

/**
 * Compute the canonical dice outcome for these seeds/target/stake using the REAL
 * `roundRandom` + `dice.settleRound` from @msgboard/games (never re-derived).
 * Returns the signed playerDelta and the win flag.
 */
export function diceOutcome(
  serverSeed: Hex,
  clientSeed: Hex,
  targetX100: bigint,
  stake: bigint,
): { win: boolean; playerDelta: bigint } {
  const r = roundRandom(serverSeed, clientSeed, 1n)
  const o = dice.settleRound(stake, { targetX100 }, r)
  return { win: o.win, playerDelta: o.playerDelta }
}

/** Build the five public Pedersen commitments from the hidden amounts + blindings. */
export async function diceSettleCommitments(
  amounts: DiceSettleAmounts,
  blindings: DiceSettleBlindings,
): Promise<DiceSettleCommitments> {
  return {
    stake: await pedersenCommit(amounts.stake, blindings.stake),
    openBalancePlayer: await pedersenCommit(amounts.openBalancePlayer, blindings.openBalancePlayer),
    openBalanceHouse: await pedersenCommit(amounts.openBalanceHouse, blindings.openBalanceHouse),
    finalBalancePlayer: await pedersenCommit(amounts.finalBalancePlayer, blindings.finalBalancePlayer),
    finalBalanceHouse: await pedersenCommit(amounts.finalBalanceHouse, blindings.finalBalanceHouse),
  }
}

/** Flatten the five commitment points into the 10 public-input field strings, in
 *  the order the circuit declares its `-> pub` outputs (x,y per commitment). */
export function commitmentsToPublicInputs(c: DiceSettleCommitments): string[] {
  const f = (p: PedersenPoint) => [field(p.x), field(p.y)]
  return [
    ...f(c.stake),
    ...f(c.openBalancePlayer),
    ...f(c.openBalanceHouse),
    ...f(c.finalBalancePlayer),
    ...f(c.finalBalanceHouse),
  ]
}

/** Build the full Noir InputMap for the diceSettle circuit. `rngCommit` and
 *  `clientSeedCommit` are PUBLIC inputs = keccak256 of the respective seed
 *  (single bytes32, no abi wrapper — mirrors commitSeed / settleWithSeeds). The
 *  circuit asserts they equal keccak256(witnessSeed), binding both seeds. */
export function diceSettleInputs(w: DiceSettleWitness): InputMap {
  return {
    rngCommit: bytes32ToByteArray(keccak256(w.serverSeed)),
    clientSeedCommit: bytes32ToByteArray(keccak256(w.clientSeed)),
    targetX100: u64(w.targetX100),
    serverSeed: bytes32ToByteArray(w.serverSeed),
    clientSeed: bytes32ToByteArray(w.clientSeed),
    stake: u64(w.amounts.stake),
    openBalancePlayer: u64(w.amounts.openBalancePlayer),
    openBalanceHouse: u64(w.amounts.openBalanceHouse),
    finalBalancePlayer: u64(w.amounts.finalBalancePlayer),
    finalBalanceHouse: u64(w.amounts.finalBalanceHouse),
    stakeBlinding: field(w.blindings.stake),
    openBalancePlayerBlinding: field(w.blindings.openBalancePlayer),
    openBalanceHouseBlinding: field(w.blindings.openBalanceHouse),
    finalBalancePlayerBlinding: field(w.blindings.finalBalancePlayer),
    finalBalanceHouseBlinding: field(w.blindings.finalBalanceHouse),
  }
}

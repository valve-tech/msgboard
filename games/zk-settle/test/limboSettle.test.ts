import { describe, it, expect, beforeAll } from 'vitest'
import { compileCircuit, type Compiled } from '../src/compile'
import { prove } from '../src/prove'
import { verify } from '../src/verify'
import {
  limboOutcome,
  limboSettleCommitments,
  commitmentsToPublicInputs,
  limboSettleInputs,
  type LimboSettleAmounts,
  type LimboSettleBlindings,
  type LimboSettleWitness,
} from '../src/limboSettle'

// ---------------------------------------------------------------------------
// Fixed limbo vectors (targetX100 = 500 == 5.00x), found by deterministic
// search over the REAL roundRandom + limbo.settleRound (see report). nonce
// hardcoded 1. Each vector's actual outcome at nonce 1 was VERIFIED before use
// (Track-1 once swapped win/loss seed labels):
//   WIN : serverSeed 0x..01, clientSeed 0x..02 -> u 984557, resultX100 6410
//         (>= 500) -> win, payout 5000, delta +4000
//   LOSS: serverSeed 0x..01, clientSeed 0x..01 -> u 218468, resultX100 126
//         (<  500) -> loss, payout 0, delta -1000
// ---------------------------------------------------------------------------
const TARGET = 500n
const b32 = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`

const WIN = { serverSeed: b32(1n), clientSeed: b32(2n) }
const LOSS = { serverSeed: b32(1n), clientSeed: b32(1n) }

const STAKE = 1000n
// Open balances chosen so the house can cover the +4000 win payout and so no
// hidden amount coincidentally equals the PUBLIC targetX100 (500) — otherwise
// the "amounts stay hidden" check would flag a collision with a legitimately-
// public input rather than a real leak.
const OPEN_PLAYER = 8000n
const OPEN_HOUSE = 6000n

// Distinct blindings per amount (a real caller draws these randomly; reusing one
// across two amounts would leak their difference — see Task 3 carry-forward).
const BLINDINGS: LimboSettleBlindings = {
  stake: 111n,
  openBalancePlayer: 222n,
  openBalanceHouse: 333n,
  finalBalancePlayer: 444n,
  finalBalanceHouse: 555n,
}

/** Build the conserved amounts from the REAL outcome: final = open +/- delta. */
function conservedAmounts(serverSeed: `0x${string}`, clientSeed: `0x${string}`): LimboSettleAmounts {
  const { playerDelta } = limboOutcome(serverSeed, clientSeed, TARGET, STAKE)
  return {
    stake: STAKE,
    openBalancePlayer: OPEN_PLAYER,
    openBalanceHouse: OPEN_HOUSE,
    finalBalancePlayer: OPEN_PLAYER + playerDelta,
    finalBalanceHouse: OPEN_HOUSE - playerDelta,
  }
}

describe('limbo PRIVACY settle (Task 5): hidden amounts + conservation', () => {
  let c: Compiled
  beforeAll(async () => {
    c = await compileCircuit('test-circuits/limboSettle')
  }, 120_000)

  it('a real WIN proves+verifies; public commitments match the TS ones; amounts stay hidden', async () => {
    // VERIFY the vector's actual outcome at nonce 1 (labels-once-swapped guard).
    const outcome = limboOutcome(WIN.serverSeed, WIN.clientSeed, TARGET, STAKE)
    expect(outcome.win).toBe(true)
    expect(outcome.playerDelta).toBe(4000n)

    const amounts = conservedAmounts(WIN.serverSeed, WIN.clientSeed)
    // win delta +4000 -> finalP 12000, finalH 2000 (pot conserved)
    expect(amounts.finalBalancePlayer).toBe(12000n)
    expect(amounts.finalBalanceHouse).toBe(2000n)
    expect(amounts.finalBalancePlayer + amounts.finalBalanceHouse).toBe(
      amounts.openBalancePlayer + amounts.openBalanceHouse,
    )

    const witness: LimboSettleWitness = {
      serverSeed: WIN.serverSeed,
      clientSeed: WIN.clientSeed,
      targetX100: TARGET,
      amounts,
      blindings: BLINDINGS,
    }
    const { proof, publicInputs } = await prove(c, limboSettleInputs(witness))

    // Public inputs = rngCommit(32) + clientSeedCommit(32) + targetX100(1) +
    // 5 commitment points (x,y each = 10). The verifier sees ONLY these — never
    // an amount. The commitment fields must equal the TS-built commitments.
    const commits = await limboSettleCommitments(amounts, BLINDINGS)
    const expectedCommitInputs = commitmentsToPublicInputs(commits)
    const tail = publicInputs.slice(publicInputs.length - 10)
    expect(tail.map((h) => BigInt(h))).toEqual(expectedCommitInputs.map((h) => BigInt(h)))

    // No hidden amount appears among the public inputs.
    const pubAsBig = publicInputs.map((h) => BigInt(h))
    for (const v of [amounts.stake, amounts.openBalancePlayer, amounts.openBalanceHouse, amounts.finalBalancePlayer, amounts.finalBalanceHouse]) {
      expect(pubAsBig).not.toContain(v)
    }

    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 180_000)

  it('a real LOSS proves+verifies; payout 0; conservation holds', async () => {
    // VERIFY the vector's actual outcome at nonce 1.
    const outcome = limboOutcome(LOSS.serverSeed, LOSS.clientSeed, TARGET, STAKE)
    expect(outcome.win).toBe(false)
    expect(outcome.playerDelta).toBe(-1000n)

    const amounts = conservedAmounts(LOSS.serverSeed, LOSS.clientSeed)
    // loss delta -1000 -> finalP 7000, finalH 7000
    expect(amounts.finalBalancePlayer).toBe(7000n)
    expect(amounts.finalBalanceHouse).toBe(7000n)

    const witness: LimboSettleWitness = {
      serverSeed: LOSS.serverSeed,
      clientSeed: LOSS.clientSeed,
      targetX100: TARGET,
      amounts,
      blindings: BLINDINGS,
    }
    const { proof, publicInputs } = await prove(c, limboSettleInputs(witness))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 180_000)

  // -------------------------------------------------------------------------
  // Task-5 review fix: limbo win-payout overflow.
  //
  // The win payout is `stake * targetX100 / 100`. In u64 the intermediate
  // `stake * targetX100` can reach 1e15 * 99_000_000 == 9.9e22, exceeding u64
  // max (1.844e19). The canonical bigint `limbo.settleRound` computes this at
  // arbitrary precision, so for an IN-RANGE witness (stake <= MAX_AMOUNT,
  // targetX100 <= LIMBO_MAX_TARGET) the OLD circuit aborted the proof with an
  // opaque "attempt to multiply with overflow" instead of computing the payout
  // and letting the conservation/cap asserts decide. The fix widens the multiply
  // to u128 (overflow-proof) and narrows back under an explicit guard.
  //
  // Vectors (target 9900 == 99.00x): WIN at server 0x..01, client 0x..09.
  // -------------------------------------------------------------------------
  describe('Task-5 review fix: high-stake win payout (u128-wide multiply, parity with limbo.settleRound)', () => {
    const HIGH_TARGET = 9900n // 99.00x
    const HIGH_WIN = { serverSeed: b32(1n), clientSeed: b32(9n) }
    const MAX_AMOUNT = 1_000_000_000_000_000n // mirror the circuit cap

    it('a legitimate HIGH-STAKE win (wide product 9.9e16) proves+verifies; payout == limbo.settleRound', async () => {
      // stake 1e13 at 99x => payout 9.9e14 (<= MAX_AMOUNT), product stake*target
      // == 9.9e16 exercises the WIDE multiply path (well past dice's small range).
      const stake = 10_000_000_000_000n // 1e13
      const outcome = limboOutcome(HIGH_WIN.serverSeed, HIGH_WIN.clientSeed, HIGH_TARGET, stake)
      expect(outcome.win).toBe(true)
      // PARITY: the canonical bigint payout the circuit must reproduce exactly.
      const canonicalPayout = (stake * HIGH_TARGET) / 100n
      expect(outcome.playerDelta).toBe(canonicalPayout - stake)
      expect(canonicalPayout).toBe(990_000_000_000_000n)
      expect(canonicalPayout).toBeLessThanOrEqual(MAX_AMOUNT)

      // Conserving balances: house must cover the +delta; all amounts <= MAX_AMOUNT.
      const openHouse = MAX_AMOUNT
      const openPlayer = 0n
      const amounts: LimboSettleAmounts = {
        stake,
        openBalancePlayer: openPlayer,
        openBalanceHouse: openHouse,
        finalBalancePlayer: openPlayer + outcome.playerDelta,
        finalBalanceHouse: openHouse - outcome.playerDelta,
      }
      // pot conserved + all in range
      expect(amounts.finalBalancePlayer + amounts.finalBalanceHouse).toBe(
        amounts.openBalancePlayer + amounts.openBalanceHouse,
      )
      for (const v of Object.values(amounts)) expect(v).toBeLessThanOrEqual(MAX_AMOUNT)

      const witness: LimboSettleWitness = {
        serverSeed: HIGH_WIN.serverSeed,
        clientSeed: HIGH_WIN.clientSeed,
        targetX100: HIGH_TARGET,
        amounts,
        blindings: BLINDINGS,
      }
      const { proof, publicInputs } = await prove(c, limboSettleInputs(witness))

      // commitments match the TS-built ones (the proven payout is consistent with
      // the committed final balances == the canonical limbo.settleRound result).
      const commits = await limboSettleCommitments(amounts, BLINDINGS)
      const expectedCommitInputs = commitmentsToPublicInputs(commits)
      const tail = publicInputs.slice(publicInputs.length - 10)
      expect(tail.map((h) => BigInt(h))).toEqual(expectedCommitInputs.map((h) => BigInt(h)))

      expect(await verify(c, proof, publicInputs)).toBe(true)
    }, 180_000)

    it('an in-range win whose stake*target overflows u64 is rejected by a MEANINGFUL assert (not a u64-multiply abort)', async () => {
      // stake == MAX_AMOUNT at target 19000 (190.00x): product 1.9e19 > u64 max.
      // The OLD arithmetic aborted with "attempt to multiply with overflow"; with
      // the u128-wide multiply the payout (1.9e17) is computed and then rejected
      // because it cannot be conserved (it exceeds u64 / the MAX_AMOUNT-bounded
      // balances). Whichever assert bites, the message must NOT be the opaque
      // arithmetic overflow.
      const OVF_WIN = { serverSeed: b32(1n), clientSeed: b32(59n) }
      const stake = MAX_AMOUNT
      const outcome = limboOutcome(OVF_WIN.serverSeed, OVF_WIN.clientSeed, 19_000n, stake)
      expect(outcome.win).toBe(true)
      expect(stake * 19_000n).toBeGreaterThan((1n << 64n) - 1n) // overflows u64

      // valid u64 balances (each <= MAX_AMOUNT); they cannot conserve a 1.9e17 payout.
      const amounts: LimboSettleAmounts = {
        stake,
        openBalancePlayer: MAX_AMOUNT,
        openBalanceHouse: MAX_AMOUNT,
        finalBalancePlayer: MAX_AMOUNT,
        finalBalanceHouse: MAX_AMOUNT,
      }
      const witness: LimboSettleWitness = {
        serverSeed: OVF_WIN.serverSeed,
        clientSeed: OVF_WIN.clientSeed,
        targetX100: 19_000n,
        amounts,
        blindings: BLINDINGS,
      }
      await expect(prove(c, limboSettleInputs(witness))).rejects.toThrow(
        /payout exceeds u64|conservation/,
      )
      // and specifically NOT the opaque arithmetic overflow the old circuit hit:
      await prove(c, limboSettleInputs(witness)).catch((e: unknown) => {
        expect(String((e as Error)?.message)).not.toMatch(/multiply with overflow/)
      })
    }, 180_000)
  })

  describe('soundness: forged witnesses FAIL to prove', () => {
    it('wrong finalBalancePlayer (not openP + delta) fails — conservation bites', async () => {
      const amounts = conservedAmounts(WIN.serverSeed, WIN.clientSeed)
      const forged: LimboSettleAmounts = { ...amounts, finalBalancePlayer: amounts.finalBalancePlayer + 1n }
      const witness: LimboSettleWitness = {
        serverSeed: WIN.serverSeed,
        clientSeed: WIN.clientSeed,
        targetX100: TARGET,
        amounts: forged,
        blindings: BLINDINGS,
      }
      await expect(prove(c, limboSettleInputs(witness))).rejects.toThrow()
    }, 180_000)

    it('wrong finalBalanceHouse (not openH - delta) fails — conservation bites', async () => {
      const amounts = conservedAmounts(LOSS.serverSeed, LOSS.clientSeed)
      const forged: LimboSettleAmounts = { ...amounts, finalBalanceHouse: amounts.finalBalanceHouse - 1n }
      const witness: LimboSettleWitness = {
        serverSeed: LOSS.serverSeed,
        clientSeed: LOSS.clientSeed,
        targetX100: TARGET,
        amounts: forged,
        blindings: BLINDINGS,
      }
      await expect(prove(c, limboSettleInputs(witness))).rejects.toThrow()
    }, 180_000)

    it('wrong serverSeed (does not match rngCommit) fails — seed bind bites', async () => {
      // WIN amounts but a different serverSeed: the circuit recomputes r from the
      // witness seeds and the conserved final balances no longer match the
      // outcome of THOSE seeds (b32(999) at nonce 1 is a LOSS, delta -1000, not
      // the WIN delta +4000 the amounts were conserved against). Conservation
      // against the new r breaks; witness generation throws.
      const amounts = conservedAmounts(WIN.serverSeed, WIN.clientSeed)
      const witness: LimboSettleWitness = {
        serverSeed: b32(999n),
        clientSeed: WIN.clientSeed,
        targetX100: TARGET,
        amounts,
        blindings: BLINDINGS,
      }
      await expect(prove(c, limboSettleInputs(witness))).rejects.toThrow()
    }, 180_000)
  })
})

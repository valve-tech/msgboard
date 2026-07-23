import { describe, it, expect, beforeAll } from 'vitest'
import { compileCircuit, type Compiled } from '../src/compile'
import { prove } from '../src/prove'
import { verify } from '../src/verify'
import {
  diceOutcome,
  diceSettleCommitments,
  commitmentsToPublicInputs,
  diceSettleInputs,
  type DiceSettleAmounts,
  type DiceSettleBlindings,
  type DiceSettleWitness,
} from '../src/diceSettle'

// ---------------------------------------------------------------------------
// Fixed dice vectors (target = 5000 == 50.00%), found by deterministic search
// over the REAL roundRandom + dice.settleRound (see report). nonce hardcoded 1.
//   WIN : serverSeed 0x..01, clientSeed 0x..08 -> roll 485  (<5000) -> payout 1980, delta +980
//   LOSS: serverSeed 0x..02, clientSeed 0x..0f -> roll 7423 (>=5000)-> payout 0,    delta -1000
// ---------------------------------------------------------------------------
const TARGET = 5000n
const b32 = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`

const WIN = { serverSeed: b32(1n), clientSeed: b32(8n) }
const LOSS = { serverSeed: b32(2n), clientSeed: b32(15n) }

const STAKE = 1000n
// Open balances chosen so no hidden amount coincidentally equals the PUBLIC
// targetX100 (5000) — otherwise the "amounts stay hidden" check would flag a
// value collision with a legitimately-public input rather than a real leak.
const OPEN_PLAYER = 8000n
const OPEN_HOUSE = 2000n

// Distinct blindings per amount (a real caller draws these randomly; reusing one
// across two amounts would leak their difference — see Task 3 carry-forward).
const BLINDINGS: DiceSettleBlindings = {
  stake: 111n,
  openBalancePlayer: 222n,
  openBalanceHouse: 333n,
  finalBalancePlayer: 444n,
  finalBalanceHouse: 555n,
}

/** Build the conserved amounts from the REAL outcome: final = open +/- delta. */
function conservedAmounts(serverSeed: `0x${string}`, clientSeed: `0x${string}`): DiceSettleAmounts {
  const { playerDelta } = diceOutcome(serverSeed, clientSeed, TARGET, STAKE)
  return {
    stake: STAKE,
    openBalancePlayer: OPEN_PLAYER,
    openBalanceHouse: OPEN_HOUSE,
    finalBalancePlayer: OPEN_PLAYER + playerDelta,
    finalBalanceHouse: OPEN_HOUSE - playerDelta,
  }
}

describe('dice PRIVACY settle (Task 4): hidden amounts + conservation', () => {
  let c: Compiled
  beforeAll(async () => {
    c = await compileCircuit('test-circuits/diceSettle')
  }, 120_000)

  it('a real WIN proves+verifies; public commitments match the TS ones; amounts stay hidden', async () => {
    const amounts = conservedAmounts(WIN.serverSeed, WIN.clientSeed)
    // sanity: the real win delta is +980 -> finalP 8980, finalH 1020 (pot conserved)
    expect(amounts.finalBalancePlayer).toBe(8980n)
    expect(amounts.finalBalanceHouse).toBe(1020n)
    expect(amounts.finalBalancePlayer + amounts.finalBalanceHouse).toBe(
      amounts.openBalancePlayer + amounts.openBalanceHouse,
    )

    const witness: DiceSettleWitness = {
      serverSeed: WIN.serverSeed,
      clientSeed: WIN.clientSeed,
      targetX100: TARGET,
      amounts,
      blindings: BLINDINGS,
    }
    const { proof, publicInputs } = await prove(c, diceSettleInputs(witness))

    // Public inputs = rngCommit(32) + clientSeedCommit(32) + targetX100(1) +
    // 5 commitment points (x,y each = 10). The verifier sees ONLY these — never
    // an amount. The commitment fields must equal the TS-built commitments.
    const commits = await diceSettleCommitments(amounts, BLINDINGS)
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
    const amounts = conservedAmounts(LOSS.serverSeed, LOSS.clientSeed)
    // loss delta -1000 -> finalP 7000, finalH 3000
    expect(amounts.finalBalancePlayer).toBe(7000n)
    expect(amounts.finalBalanceHouse).toBe(3000n)

    const witness: DiceSettleWitness = {
      serverSeed: LOSS.serverSeed,
      clientSeed: LOSS.clientSeed,
      targetX100: TARGET,
      amounts,
      blindings: BLINDINGS,
    }
    const { proof, publicInputs } = await prove(c, diceSettleInputs(witness))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 180_000)

  describe('soundness: forged witnesses FAIL to prove', () => {
    it('wrong finalBalancePlayer (not openP + delta) fails — conservation bites', async () => {
      const amounts = conservedAmounts(WIN.serverSeed, WIN.clientSeed)
      const forged: DiceSettleAmounts = { ...amounts, finalBalancePlayer: amounts.finalBalancePlayer + 1n }
      const witness: DiceSettleWitness = {
        serverSeed: WIN.serverSeed,
        clientSeed: WIN.clientSeed,
        targetX100: TARGET,
        amounts: forged,
        blindings: BLINDINGS,
      }
      await expect(prove(c, diceSettleInputs(witness))).rejects.toThrow()
    }, 180_000)

    it('wrong finalBalanceHouse (not openH - delta) fails — conservation bites', async () => {
      const amounts = conservedAmounts(LOSS.serverSeed, LOSS.clientSeed)
      const forged: DiceSettleAmounts = { ...amounts, finalBalanceHouse: amounts.finalBalanceHouse - 1n }
      const witness: DiceSettleWitness = {
        serverSeed: LOSS.serverSeed,
        clientSeed: LOSS.clientSeed,
        targetX100: TARGET,
        amounts: forged,
        blindings: BLINDINGS,
      }
      await expect(prove(c, diceSettleInputs(witness))).rejects.toThrow()
    }, 180_000)

    it('wrong serverSeed (does not match rngCommit) fails — seed bind bites', async () => {
      // Use the WIN amounts but feed a different serverSeed: the circuit recomputes
      // r from the witness seeds and the (conserved) final balances no longer match
      // the outcome of THOSE seeds. The conserved amounts were built for WIN seeds;
      // proving with a different serverSeed breaks conservation against the new r.
      const amounts = conservedAmounts(WIN.serverSeed, WIN.clientSeed)
      const witness: DiceSettleWitness = {
        serverSeed: b32(999n), // not the seed the amounts were conserved against
        clientSeed: WIN.clientSeed,
        targetX100: TARGET,
        amounts,
        blindings: BLINDINGS,
      }
      await expect(prove(c, diceSettleInputs(witness))).rejects.toThrow()
    }, 180_000)
  })
})

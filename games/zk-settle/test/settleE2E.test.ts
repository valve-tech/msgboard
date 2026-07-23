import { describe, it, expect } from 'vitest'
import {
  proveSettle,
  verifySettle,
  trackOneSettle,
  settleAmounts,
  type SettleRound,
  type SettleBlindings,
} from '../src/settle'

// ===========================================================================
// Task 6 — the off-chain M1 E2E integration test (the M1 deliverable).
//
// For BOTH games: take a REAL round (real seeds/stake/balances/params), build
// the witness, PROVE, then have an INDEPENDENT verifier check the proof +
// validate the public commitments WITHOUT learning the hidden amounts. Plus the
// Track-1 equivalence cross-check: the proven settlement's conserved balances
// must equal what the Track-1 (recompute) settle would produce for the SAME
// round — privacy doesn't change the math, only hides it.
//
// Vectors reuse the Task-4 (dice) and Task-5 (limbo) fixed seeds, whose nonce-1
// outcomes were verified there. Each test re-asserts the outcome up front so a
// future seed/label drift fails loudly.
// ===========================================================================
const b32 = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`

const BLINDINGS: SettleBlindings = {
  stake: 111n,
  openBalancePlayer: 222n,
  openBalanceHouse: 333n,
  finalBalancePlayer: 444n,
  finalBalanceHouse: 555n,
}

// Dice (Task 4): target 5000 (50.00%). WIN seeds -> delta +980; LOSS -> -1000.
const DICE_WIN: SettleRound = {
  game: 'dice',
  serverSeed: b32(1n),
  clientSeed: b32(8n),
  targetX100: 5000n,
  stake: 1000n,
  openBalancePlayer: 8000n,
  openBalanceHouse: 2000n,
  blindings: BLINDINGS,
}
const DICE_LOSS: SettleRound = {
  ...DICE_WIN,
  serverSeed: b32(2n),
  clientSeed: b32(15n),
}

// Limbo (Task 5): targetX100 500 (5.00x). WIN seeds -> delta +4000; LOSS -> -1000.
const LIMBO_WIN: SettleRound = {
  game: 'limbo',
  serverSeed: b32(1n),
  clientSeed: b32(2n),
  targetX100: 500n,
  stake: 1000n,
  openBalancePlayer: 8000n,
  openBalanceHouse: 6000n,
  blindings: BLINDINGS,
}
const LIMBO_LOSS: SettleRound = {
  ...LIMBO_WIN,
  serverSeed: b32(1n),
  clientSeed: b32(1n),
}

/** Assert no hidden amount appears anywhere in the public inputs. */
function assertAmountsHidden(publicInputs: string[], round: SettleRound) {
  const a = settleAmounts(round)
  const pub = publicInputs.map((h) => BigInt(h))
  for (const v of [
    a.stake,
    a.openBalancePlayer,
    a.openBalanceHouse,
    a.finalBalancePlayer,
    a.finalBalanceHouse,
  ]) {
    expect(pub).not.toContain(v)
  }
}

describe('Task 6 — off-chain M1 E2E: prove -> independent verify -> Track-1 equivalence (dice + limbo)', () => {
  it('DICE WIN: real round -> prove -> independent verify; conserved balances == Track-1; amounts hidden', async () => {
    // Track-1 (recompute) baseline.
    const t1 = trackOneSettle(DICE_WIN)
    expect(t1.win).toBe(true)
    expect(t1.playerDelta).toBe(980n)
    expect(t1.finalBalancePlayer).toBe(8980n)
    expect(t1.finalBalanceHouse).toBe(1020n)

    // Prove (hidden amounts) and verify independently.
    const sp = await proveSettle(DICE_WIN)
    expect(await verifySettle(sp.proof, sp.publicInputs, 'dice')).toBe(true)

    // EQUIVALENCE: the proven settlement's conserved balances equal Track-1's.
    expect(sp.amounts.finalBalancePlayer).toBe(t1.finalBalancePlayer)
    expect(sp.amounts.finalBalanceHouse).toBe(t1.finalBalanceHouse)
    // pot conserved
    expect(sp.amounts.finalBalancePlayer + sp.amounts.finalBalanceHouse).toBe(
      sp.amounts.openBalancePlayer + sp.amounts.openBalanceHouse,
    )

    // HIDING: no amount in the public inputs; the proof binds the commitments.
    assertAmountsHidden(sp.publicInputs, DICE_WIN)
    expect(await verifySettle(sp.proof, sp.publicInputs, 'dice', sp.commitments)).toBe(true)
  }, 180_000)

  it('DICE LOSS: real round -> prove -> independent verify; conserved == Track-1', async () => {
    const t1 = trackOneSettle(DICE_LOSS)
    expect(t1.win).toBe(false)
    expect(t1.playerDelta).toBe(-1000n)

    const sp = await proveSettle(DICE_LOSS)
    expect(await verifySettle(sp.proof, sp.publicInputs, 'dice')).toBe(true)
    expect(sp.amounts.finalBalancePlayer).toBe(t1.finalBalancePlayer)
    expect(sp.amounts.finalBalanceHouse).toBe(t1.finalBalanceHouse)
    assertAmountsHidden(sp.publicInputs, DICE_LOSS)
  }, 180_000)

  it('LIMBO WIN: real round -> prove -> independent verify; conserved == Track-1; amounts hidden', async () => {
    const t1 = trackOneSettle(LIMBO_WIN)
    expect(t1.win).toBe(true)
    expect(t1.playerDelta).toBe(4000n)
    expect(t1.finalBalancePlayer).toBe(12000n)
    expect(t1.finalBalanceHouse).toBe(2000n)

    const sp = await proveSettle(LIMBO_WIN)
    expect(await verifySettle(sp.proof, sp.publicInputs, 'limbo')).toBe(true)
    expect(sp.amounts.finalBalancePlayer).toBe(t1.finalBalancePlayer)
    expect(sp.amounts.finalBalanceHouse).toBe(t1.finalBalanceHouse)
    expect(sp.amounts.finalBalancePlayer + sp.amounts.finalBalanceHouse).toBe(
      sp.amounts.openBalancePlayer + sp.amounts.openBalanceHouse,
    )
    assertAmountsHidden(sp.publicInputs, LIMBO_WIN)
    expect(await verifySettle(sp.proof, sp.publicInputs, 'limbo', sp.commitments)).toBe(true)
  }, 180_000)

  it('LIMBO LOSS: real round -> prove -> independent verify; conserved == Track-1', async () => {
    const t1 = trackOneSettle(LIMBO_LOSS)
    expect(t1.win).toBe(false)
    expect(t1.playerDelta).toBe(-1000n)

    const sp = await proveSettle(LIMBO_LOSS)
    expect(await verifySettle(sp.proof, sp.publicInputs, 'limbo')).toBe(true)
    expect(sp.amounts.finalBalancePlayer).toBe(t1.finalBalancePlayer)
    expect(sp.amounts.finalBalanceHouse).toBe(t1.finalBalanceHouse)
    assertAmountsHidden(sp.publicInputs, LIMBO_LOSS)
  }, 180_000)

  describe('the verifier REJECTS bad proofs / bad public inputs', () => {
    it('rejects a proof whose claimed commitments do not validate (tampered public input)', async () => {
      const sp = await proveSettle(DICE_WIN)
      // Tamper one commitment field: a verifier checking THIS proof against the
      // tampered public inputs must reject (the proof is bound to the originals).
      const tampered = [...sp.publicInputs]
      const idx = tampered.length - 1
      const orig = BigInt(tampered[idx]!)
      tampered[idx] = '0x' + ((orig + 1n) & ((1n << 254n) - 1n)).toString(16)
      expect(await verifySettle(sp.proof, tampered, 'dice')).toBe(false)
    }, 180_000)

    it('rejects when the claimed conservation is wrong (a forged witness cannot produce a valid proof)', async () => {
      // A witness whose final balances violate conservation cannot be proven at
      // all — the in-circuit conservation asserts bite at witness generation.
      const forged = { ...DICE_WIN }
      // override settleAmounts by proving a round whose final balances we corrupt
      // via a wrapper: build inputs that break conservation by +1 on finalP.
      // proveSettle always conserves, so we forge at the witness layer here.
      const { diceSettleInputs } = await import('../src/diceSettle')
      const { compileCircuit } = await import('../src/compile')
      const { prove } = await import('../src/prove')
      const a = settleAmounts(forged)
      const badInputs = diceSettleInputs({
        serverSeed: forged.serverSeed,
        clientSeed: forged.clientSeed,
        targetX100: forged.targetX100,
        amounts: { ...a, finalBalancePlayer: a.finalBalancePlayer + 1n },
        blindings: forged.blindings,
      })
      const c = await compileCircuit('test-circuits/diceSettle')
      await expect(prove(c, badInputs)).rejects.toThrow()
    }, 180_000)

    it('rejects when verified under the WRONG game circuit (dice proof vs limbo verifier)', async () => {
      const sp = await proveSettle(DICE_WIN)
      // A dice proof checked against the limbo circuit must not verify.
      expect(await verifySettle(sp.proof, sp.publicInputs, 'limbo')).toBe(false)
    }, 180_000)
  })
})

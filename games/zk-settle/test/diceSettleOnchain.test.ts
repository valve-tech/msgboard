import { describe, it, expect, beforeAll } from 'vitest'
import { compileCircuit, type Compiled } from '../src/compile'
import { prove } from '../src/prove'
import { verify } from '../src/verify'
import {
  diceOnchainInputs,
  diceOnchainPublics,
  diceOnchainPayout,
  type DiceOnchainRound,
} from '../src/diceSettleOnchain'

// M2 (Track-2, Milestone 2) — the ON-CHAIN dice settle circuit, proven/verified OFF-CHAIN here. The
// same circuit + proof feed the generated Solidity verifier (mode-2 settle); this test pins that the
// circuit (a) accepts an honest win and an honest loss, (b) exposes the right public inputs, and
// (c) REJECTS a witness whose claimed payoutPlayer disagrees with the canonical dice math.
//
// Vectors reuse diceSettle.test.ts (target 5000): WIN = seeds 0x..01 / 0x..08, LOSS = 0x..02 / 0x..0f.
const TARGET = 5000n
const b32 = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`
const WIN: DiceOnchainRound = {
  serverSeed: b32(1n),
  clientSeed: b32(8n),
  targetX100: TARGET,
  escrowPlayer: 1000n,
  escrowHouse: 980n, // pot 1980 == win payout (escrow ceiling met)
}
const LOSS: DiceOnchainRound = {
  serverSeed: b32(2n),
  clientSeed: b32(15n),
  targetX100: TARGET,
  escrowPlayer: 1000n,
  escrowHouse: 980n,
}

describe('dice ON-CHAIN settle circuit (M2): public balances + seed binding', () => {
  let c: Compiled
  beforeAll(async () => {
    c = await compileCircuit('test-circuits/diceSettleOnchain')
  }, 120_000)

  it('proves + verifies an honest WIN; payoutPlayer == canonical dice payout', async () => {
    const payout = diceOnchainPayout(WIN)
    expect(payout).toBe(1980n) // dice@5000 win: stake 1000 * mult 198 / 100
    const { proof, publicInputs } = await prove(c, diceOnchainInputs(WIN))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 120_000)

  it('proves + verifies an honest LOSS; payoutPlayer == 0', async () => {
    expect(diceOnchainPayout(LOSS)).toBe(0n)
    const { proof, publicInputs } = await prove(c, diceOnchainInputs(LOSS))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 120_000)

  it('public inputs are rngCommit[32] ‖ clientSeedCommit[32] ‖ target ‖ escrowP ‖ escrowH ‖ payout', () => {
    const p = diceOnchainPublics(WIN)
    expect(p.targetX100).toBe(5000n)
    expect(p.escrowPlayer).toBe(1000n)
    expect(p.escrowHouse).toBe(980n)
    expect(p.payoutPlayer).toBe(1980n)
  })

  it('REJECTS a witness whose payoutPlayer disagrees with the dice math (soundness)', async () => {
    // Force a wrong public payout: the circuit asserts payoutPlayer == computed payout, so executing
    // the witness must throw (the proof can never be produced for a lying payout).
    const inputs = diceOnchainInputs(WIN)
    inputs.payoutPlayer = '0x' + (1980n + 1n).toString(16) // claim one chip too many
    await expect(prove(c, inputs)).rejects.toThrow()
  }, 120_000)
})

import { describe, it, expect, beforeAll } from 'vitest'
import { roundRandom, diceMultiplierX100 } from '@msgboard/games'
import { compileCircuit, type Compiled } from '../src/compile'
import { prove } from '../src/prove'
import { verify } from '../src/verify'
import {
  diceTable,
  rouletteStraightUpTable,
  rouletteColorTable,
  ROULETTE_RED,
  encodeTableParams,
  paramsHashOfTable,
  assertWellFormed,
  lookupMultX100,
} from '../src/paytable'
import {
  tableBucket,
  tablePayout,
  tablePublics,
  tableSettleInputs,
  type TableRound,
} from '../src/tableSettle'

// The GENERIC table-settle circuit, proven/verified OFF-CHAIN here. ONE circuit
// settles dice AND roulette (and every other pure-RNG game) via a paytable lookup.
// Vectors reuse the zk-settle dice targets so the two circuits agree on the same
// rounds; roulette bets are chosen from the observed bucket so win/loss is
// deterministic without hunting for seeds.
const b32 = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`
const SS = b32(1n)
const CS = b32(8n) // dice@5000 with these seeds -> roll 485 (< 5000) -> WIN (reused from zk-settle)
const SS2 = b32(2n)
const CS2 = b32(15n) // dice@5000 -> LOSS

describe('paytable model (pure — no proving)', () => {
  it('dice table mirrors GamePayouts/dice.ts multiplier and shape', () => {
    const t = diceTable(5000n)
    assertWellFormed(t)
    expect(t.outcomeSpace).toBe(10_000n)
    expect(t.segments).toHaveLength(2)
    // win multiplier equals the canonical dice math
    expect(t.segments[0]!.multX100).toBe(diceMultiplierX100(5000n))
    expect(t.segments[0]!.multX100).toBe(198n)
    expect(t.segments[1]!.multX100).toBe(0n) // roll-over-target loses
    expect(lookupMultX100(t, 485n)).toBe(198n) // a winning roll
    expect(lookupMultX100(t, 5000n)).toBe(0n) // exactly the target loses (roll-UNDER)
    expect(lookupMultX100(t, 9999n)).toBe(0n)
  })

  it('roulette straight-up = 37 unit slots, 3600 on the picked number', () => {
    const t = rouletteStraightUpTable(17)
    assertWellFormed(t)
    expect(t.outcomeSpace).toBe(37n)
    expect(t.segments).toHaveLength(37)
    expect(lookupMultX100(t, 17n)).toBe(3600n)
    expect(lookupMultX100(t, 18n)).toBe(0n)
    expect(lookupMultX100(t, 0n)).toBe(0n)
  })

  it('roulette color bet pays 200 on-color, 0 on 0 (green) and off-color', () => {
    const t = rouletteColorTable('red')
    assertWellFormed(t)
    expect(lookupMultX100(t, 1n)).toBe(200n) // 1 is red
    expect(lookupMultX100(t, 2n)).toBe(0n) // 2 is black
    expect(lookupMultX100(t, 0n)).toBe(0n) // green loses even-money bets
    for (const k of ROULETTE_RED) expect(lookupMultX100(t, BigInt(k))).toBe(200n)
  })

  it('paramsHash is a stable keccak of the canonical abi.encode(outcomeSpace, hi[], mult[])', () => {
    const t = diceTable(5000n)
    const enc = encodeTableParams(t)
    expect(enc.startsWith('0x')).toBe(true)
    // deterministic
    expect(paramsHashOfTable(t)).toBe(paramsHashOfTable(diceTable(5000n)))
    // sensitive to the table (a different target => a different hash)
    expect(paramsHashOfTable(t)).not.toBe(paramsHashOfTable(diceTable(2500n)))
  })

  it('rejects malformed tables (non-ascending / non-covering)', () => {
    expect(() => assertWellFormed({ outcomeSpace: 37n, segments: [{ hi: 10n, multX100: 0n }] })).toThrow()
    expect(() =>
      assertWellFormed({ outcomeSpace: 37n, segments: [{ hi: 20n, multX100: 0n }, { hi: 20n, multX100: 0n }] }),
    ).toThrow()
  })
})

describe('generic table-settle circuit (dice + roulette on ONE circuit)', () => {
  let c: Compiled
  beforeAll(async () => {
    c = await compileCircuit('test-circuits/tableSettleOnchain')
  }, 180_000)

  it('DICE win@5000 proves + verifies; payout == canonical dice payout (1980)', async () => {
    const round: TableRound = { serverSeed: SS, clientSeed: CS, table: diceTable(5000n), escrowPlayer: 1000n, escrowHouse: 980n }
    expect(tablePayout(round)).toBe(1980n) // matches diceSettleOnchain's 1980
    const { proof, publicInputs } = await prove(c, tableSettleInputs(round))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 180_000)

  it('DICE loss@5000 proves + verifies; payout == 0', async () => {
    const round: TableRound = { serverSeed: SS2, clientSeed: CS2, table: diceTable(5000n), escrowPlayer: 1000n, escrowHouse: 980n }
    expect(tablePayout(round)).toBe(0n)
    const { proof, publicInputs } = await prove(c, tableSettleInputs(round))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 180_000)

  it('ROULETTE straight-up WIN proves + verifies; payout == 36x stake', async () => {
    const bucket = Number(roundRandom(SS, CS, 1n) % 37n) // the slot this round lands on
    const round: TableRound = {
      serverSeed: SS,
      clientSeed: CS,
      table: rouletteStraightUpTable(bucket), // bet the winning number
      escrowPlayer: 1000n,
      escrowHouse: 35_000n, // pot 36000 covers the 36x payout
    }
    expect(tableBucket(round)).toBe(BigInt(bucket))
    expect(tablePayout(round)).toBe(36_000n) // 1000 * 3600 / 100
    const { proof, publicInputs } = await prove(c, tableSettleInputs(round))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 180_000)

  it('ROULETTE straight-up LOSS (bet a different number) proves + verifies; payout == 0', async () => {
    const bucket = Number(roundRandom(SS, CS, 1n) % 37n)
    const round: TableRound = {
      serverSeed: SS,
      clientSeed: CS,
      table: rouletteStraightUpTable((bucket + 1) % 37), // bet the wrong number
      escrowPlayer: 1000n,
      escrowHouse: 35_000n,
    }
    expect(tablePayout(round)).toBe(0n)
    const { proof, publicInputs } = await prove(c, tableSettleInputs(round))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 180_000)

  it('ROULETTE color WIN proves + verifies; payout == 2x stake', async () => {
    const bucket = Number(roundRandom(SS, CS, 1n) % 37n)
    // choose the color that this bucket actually is (0/green would make both colors lose)
    const color: 'red' | 'black' = bucket !== 0 && ROULETTE_RED.has(bucket) ? 'red' : 'black'
    // guard: if the bucket is green (0) this vector is not a color win — assert we didn't hit it
    expect(bucket).not.toBe(0)
    const round: TableRound = {
      serverSeed: SS,
      clientSeed: CS,
      table: rouletteColorTable(color),
      escrowPlayer: 1000n,
      escrowHouse: 1000n, // pot 2000 covers the 2x payout
    }
    expect(tablePayout(round)).toBe(2000n)
    const { proof, publicInputs } = await prove(c, tableSettleInputs(round))
    expect(await verify(c, proof, publicInputs)).toBe(true)
  }, 180_000)

  it('public-input shape: 32 + 32 + outcomeSpace + segCount + hi[64] + mult[64] + 3 scalars', () => {
    const round: TableRound = { serverSeed: SS, clientSeed: CS, table: diceTable(5000n), escrowPlayer: 1000n, escrowHouse: 980n }
    const p = tablePublics(round)
    expect(p.hi).toHaveLength(64)
    expect(p.mult).toHaveLength(64)
    expect(p.segCount).toBe(2n)
    expect(p.outcomeSpace).toBe(10_000n)
    expect(p.payoutPlayer).toBe(1980n)
  })

  it('REJECTS a witness whose payoutPlayer disagrees with the paytable (soundness)', async () => {
    const round: TableRound = { serverSeed: SS, clientSeed: CS, table: diceTable(5000n), escrowPlayer: 1000n, escrowHouse: 980n }
    const inputs = tableSettleInputs(round)
    inputs.payoutPlayer = '0x' + (1980n + 1n).toString(16) // claim one chip too many
    await expect(prove(c, inputs)).rejects.toThrow()
  }, 180_000)
})

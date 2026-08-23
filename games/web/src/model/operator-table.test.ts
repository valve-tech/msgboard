import { describe, it, expect } from 'vitest'
import {
  tierPrice,
  payoutFor,
  betFits,
  decodeOperatorTable,
  operatorBetPlan,
  isStale,
  STALE_BLOCKS,
  operatorHeatLocations,
  nextOperatorHeatIndex,
  OPERATOR_POOL_SIZE,
  type OperatorTable,
} from './operator-table'

const TABLE = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const OP = '0x00000000000000000000000000000000000000E0' as const
const TOKEN = '0x00000000000000000000000000000000000000F0' as const
const ESCROW = '0x00000000000000000000000000000000000000e5' as const
const GAME = '0x00000000000000000000000000000000000000c0' as const
const V1 = '0x00000000000000000000000000000000000000A1' as const

const table = (over: Partial<OperatorTable> = {}): OperatorTable => ({
  tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 200,
  minStake: 1n, maxStake: 8n, open: true, validatorPolicy: '0x0000000000000000000000000000000000000000',
  cap: 0n, locked: 0n, ...over,
})

describe('tierPrice', () => {
  it('rounds up to the smallest power-of-two tier >= stake', () => {
    expect(tierPrice(1n, 8n, 1n)).toBe(1n)
    expect(tierPrice(1n, 8n, 2n)).toBe(2n)
    expect(tierPrice(1n, 8n, 3n)).toBe(4n)
    expect(tierPrice(1n, 8n, 5n)).toBe(8n)
  })
  it('returns undefined out of range', () => {
    expect(tierPrice(1n, 8n, 0n)).toBeUndefined()
    expect(tierPrice(1n, 8n, 9n)).toBeUndefined()
  })
})

describe('payoutFor', () => {
  it('is stake * maxMultiplierX100 / 100 (integer division)', () => {
    expect(payoutFor(1_000000000000000000n, 196)).toBe(1_960000000000000000n)
    expect(payoutFor(1n, 150)).toBe(1n) // truncates to break-even at dust
  })
})

describe('betFits', () => {
  it('accepts an in-range stake with room under the cap', () => {
    expect(betFits(table({ cap: 100n, locked: 0n }), 4n).ok).toBe(true)
  })
  it('rejects a paused table', () => {
    expect(betFits(table({ open: false }), 1n).reason).toMatch(/paused/i)
  })
  it('rejects an out-of-range stake', () => {
    expect(betFits(table(), 9n).reason).toMatch(/range/i)
  })
  it('rejects a dust stake whose payout truncates to break-even', () => {
    expect(betFits(table({ maxMultiplierX100: 150 }), 1n).reason).toMatch(/pay nothing/i)
  })
  it('rejects a bet that would exceed the exposure cap', () => {
    // stake 4 (payout 8, exposure 4) with cap 5 and locked 2 → 2 + 4 > 5
    expect(betFits(table({ cap: 5n, locked: 2n }), 4n).reason).toMatch(/cap/i)
  })
})

describe('decodeOperatorTable', () => {
  it('reads the tables() struct tuple in field order', () => {
    const tuple = [OP, TOKEN, 196, 1n, 8n, true, '0x0000000000000000000000000000000000000000'] as const
    expect(decodeOperatorTable(TABLE, tuple, 50n, 10n)).toEqual({
      tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 196,
      minStake: 1n, maxStake: 8n, open: true, validatorPolicy: '0x0000000000000000000000000000000000000000',
      cap: 50n, locked: 10n,
    })
  })
})

describe('operatorBetPlan', () => {
  it('approves the escrow and opens on the game with the canonical subset', () => {
    const opCfg = { coinFlip: GAME, escrow: ESCROW, registry: '0x0' as const, policy: '0x0' as const, deployBlock: '0', retired: [] }
    const plan = operatorBetPlan(opCfg, [V1], TABLE, 1, 5n, [])
    expect(plan.approveTo).toBe(ESCROW)
    expect(plan.openTo).toBe(GAME)
    expect(plan.openArgs[0]).toBe(TABLE)
    expect(plan.openArgs[1]).toBe(1)
    expect(plan.openArgs[2]).toBe(5n)
    expect(plan.openArgs[3]).toEqual([V1])
  })
})

describe('isStale', () => {
  it('is true only once STALE_BLOCKS have passed since open', () => {
    expect(isStale(100n, 100n + STALE_BLOCKS - 1n)).toBe(false)
    expect(isStale(100n, 100n + STALE_BLOCKS)).toBe(true)
    expect(isStale(0n, 999n)).toBe(false) // no open block yet
  })
})

describe('operatorHeatLocations', () => {
  const SUBSET = [V1, '0x00000000000000000000000000000000000000A2', '0x00000000000000000000000000000000000000A3'] as const

  it('stakes each Info with the table token + tier price at offset 0 (NOT the free pools)', () => {
    const locs = operatorHeatLocations([...SUBSET], 5n, TOKEN, 8n)
    expect(locs).toHaveLength(3)
    for (const [i, l] of locs.entries()) {
      expect(l.provider).toBe(SUBSET[i])
      expect(l.token).toBe(TOKEN) // table token, never zero — else open() reverts TokenMismatch
      expect(l.price).toBe(8n) // tier price, never 0 — else PriceMismatch
      expect(l.offset).toBe(0n) // offset-0 operator pool, in lockstep across validators
      expect(l.index).toBe(5n)
    }
  })

  it('rotates offset/index once the pool fills (poolLocationFor semantics)', () => {
    const [l] = operatorHeatLocations([V1], OPERATOR_POOL_SIZE + 3n, TOKEN, 1n)
    expect(l!.offset).toBe(OPERATOR_POOL_SIZE) // second pool starts at offset == poolSize
    expect(l!.index).toBe(3n)
  })
})

describe('nextOperatorHeatIndex', () => {
  // consumed()==true for k < boundary, false at/after — the monotone shape the probe relies on.
  const probe = (boundary: bigint) => (k: bigint) => Promise.resolve(k < boundary)

  it('finds the first unconsumed slot by binary search', async () => {
    expect(await nextOperatorHeatIndex(probe(0n))).toBe(0n) // nothing consumed yet
    expect(await nextOperatorHeatIndex(probe(13n))).toBe(13n) // matches the live 943 pool (0..12 used)
    expect(await nextOperatorHeatIndex(probe(1n))).toBe(1n)
    expect(await nextOperatorHeatIndex(probe(64n))).toBe(64n)
  })

  it('stops at the boundary when the caller maps a revert (past the inked region) to false', async () => {
    // The caller (the screen) wraps the on-chain read in try/catch and returns false on revert; the search
    // then treats the uninked region like the unconsumed region and returns the boundary.
    const isConsumed = (k: bigint) => Promise.resolve(k < 5n) // >=5 would revert on-chain → caller yields false
    await expect(nextOperatorHeatIndex(isConsumed)).resolves.toBe(5n)
  })
})

import { describe, it, expect } from 'vitest'
import { reduceBackroom } from './backroomIndex'

const R = '0xround1' as const
const T = '0xtable1' as const
const P = '0xplayer1' as const

const opened = { name: 'RoundOpened', blockNumber: 100n, args: {
  roundId: R, tableId: T, player: P, side: 1, stake: 10n, payout: 18n, tierPrice: 10n, key: '0xkey', openedAtBlock: 100n } }
const created = { name: 'TableCreated', blockNumber: 90n, args: {
  tableId: T, operator: '0xop', token: '0xtok', maxMultiplierX100: 180, minStake: 1n, maxStake: 100n } }
const capSet = { name: 'TableCapSet', blockNumber: 91n, args: { tableId: T, cap: 1000n } }
const exposed = { name: 'ExposureLocked', blockNumber: 100n, args: { betId: R, operator: '0xop', token: '0xtok', player: P, stake: 10n, payout: 18n } }
const settled = { name: 'RoundSettled', blockNumber: 112n, args: { roundId: R, tableId: T, player: P, won: true, payout: 18n, seed: '0xseed' } }
const forfeit = { name: 'ForfeitRouted', blockNumber: 112n, args: { roundId: R, operator: '0xop', token: '0xtok', forfeit: 10n } }
const refunded = { name: 'RoundRefunded', blockNumber: 112n, args: { roundId: R, tableId: T, player: P, stake: 10n } }

const noSeed = () => false
const seeded = () => true

describe('reduceBackroom', () => {
  it('surfaces an open round in the pit with positions only', () => {
    const { pit } = reduceBackroom([created, capSet, opened, exposed], { seedFinalized: noSeed })
    expect(pit).toHaveLength(1)
    const r = pit[0]!
    expect(r.roundId).toBe(R)
    expect(r.stake).toBe(10n)
    expect(r.payout).toBe(18n)
  })

  it('LEAK BOUNDARY: a pit round carries no outcome, seed, or validator field', () => {
    const { pit } = reduceBackroom([created, opened, exposed], { seedFinalized: noSeed })
    const keys = Object.keys(pit[0] as Record<string, unknown>)
    for (const forbidden of ['seed', 'won', 'validators', 'validatorSubset', 'reveal', 'reveals', 'revealCount', 'outcome', 'result'])
      expect(keys).not.toContain(forbidden)
  })

  it('removes a round from the pit once its seed finalizes', () => {
    const { pit } = reduceBackroom([created, opened, exposed], { seedFinalized: seeded })
    expect(pit).toHaveLength(0)
  })

  it('moves a settled round to the tape and drops it from the pit', () => {
    const { pit, tape } = reduceBackroom([created, opened, exposed, settled], { seedFinalized: seeded })
    expect(pit).toHaveLength(0)
    expect(tape.some((e) => e.kind === 'settled' && e.roundId === R && e.won === true)).toBe(true)
  })

  it('tracks a forfeit on the tape', () => {
    const { tape } = reduceBackroom([created, opened, exposed, refunded, forfeit], { seedFinalized: seeded })
    expect(tape.some((e) => e.kind === 'forfeit' && e.forfeit === 10n)).toBe(true)
  })

  it('counts in-flight rounds per table and clears on terminal', () => {
    const before = reduceBackroom([created, capSet, opened, exposed], { seedFinalized: noSeed })
    expect(before.tables[0]!.inFlight).toBe(1)
    const after = reduceBackroom([created, capSet, opened, exposed, settled], { seedFinalized: seeded })
    expect(after.tables[0]!.inFlight).toBe(0)
  })

  it('carries table cap and open flag', () => {
    const { tables } = reduceBackroom([created, capSet], { seedFinalized: noSeed })
    expect(tables[0]!.cap).toBe(1000n)
    expect(tables[0]!.open).toBe(true)
  })

  it('RED TEAM: the full serialized pit projection leaks no outcome material', () => {
    const events = [
      { name: 'TableCreated', blockNumber: 90n, args: { tableId: T, operator: '0xop', token: '0xtok', maxMultiplierX100: 180, minStake: 1n, maxStake: 100n } },
      { name: 'RoundOpened', blockNumber: 100n, args: { roundId: R, tableId: T, player: P, side: 1, stake: 10n, payout: 18n, tierPrice: 10n, key: '0xkey', openedAtBlock: 100n } },
      { name: 'ExposureLocked', blockNumber: 100n, args: { betId: R, operator: '0xop', token: '0xtok', player: P, stake: 10n, payout: 18n } },
    ]
    const { pit } = reduceBackroom(events, { seedFinalized: () => false })
    const blob = JSON.stringify(pit, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase()
    for (const forbidden of ['seed', 'won', 'validator', 'reveal', 'preimage', 'outcome', 'result', 'winner'])
      expect(blob.includes(forbidden)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { reduceTables } from './tablesIndex'

const T = '0x01' as any
const T2 = '0x02' as any
const OP = '0x00000000000000000000000000000000000000a1' as any

describe('reduceTables', () => {
  it('folds funding + rounds and sorts armed, busy, staked tables first', () => {
    const events = [
      { type: 'TableCreated', tableId: T, operator: OP, maxMultiplierX100: 196, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'HotFunded', tableId: T, amount: 50n, blockNumber: 2n },
      { type: 'Staked', tableId: T, amount: 5n, blockNumber: 3n },
      { type: 'RoundOpened', tableId: T, roundId: '0xr1', payout: 2n, blockNumber: 9n },
      { type: 'TableCreated', tableId: T2, operator: OP, maxMultiplierX100: 150, maxStake: 10n, hotTarget: 100n, blockNumber: 4n },
      // T2 has no hot -> should sort below T
    ] as any
    const views = reduceTables(events, 10n, 100n)
    expect(views[0]!.tableId).to.equal(T)
    expect(views[0]!.hot).to.equal(50n)
    expect(views[0]!.stake).to.equal(5n)
    expect(views[0]!.roundsRecent).to.equal(1)
    expect(views[1]!.tableId).to.equal(T2)
    expect(views[1]!.hot).to.equal(0n)
  })

  it('applies ParamsSet, OpenSet, and RoundSettled (activity keeps counting)', () => {
    const events = [
      { type: 'TableCreated', tableId: T, operator: OP, maxMultiplierX100: 196, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'ParamsSet', tableId: T, maxMultiplierX100: 150, maxStake: 3n, hotTarget: 20n, blockNumber: 2n },
      { type: 'OpenSet', tableId: T, open: false, blockNumber: 3n },
    ] as any
    const v = reduceTables(events, 10n, 100n)[0]!
    expect(v.maxMultiplierX100).to.equal(150)
    expect(v.maxStake).to.equal(3n)
    expect(v.open).to.equal(false)
  })
})

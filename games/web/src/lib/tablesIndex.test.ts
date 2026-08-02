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

  it('debits hot by (payout - stake) on RoundOpened with a real nonzero stake', () => {
    const events = [
      { type: 'TableCreated', tableId: T, operator: OP, maxMultiplierX100: 196, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'HotFunded', tableId: T, amount: 50n, blockNumber: 2n },
      { type: 'RoundOpened', tableId: T, roundId: '0xr1', payout: 2n, stake: 1n, blockNumber: 9n },
    ] as any
    const v = reduceTables(events, 10n, 100n)[0]!
    expect(v.hot).to.equal(49n) // 50 - (payout 2 - stake 1)
    expect(v.escrowed).to.equal(2n)
  })

  it('RoundSettled loss: releases escrow and returns the full payout to hot', () => {
    const events = [
      { type: 'TableCreated', tableId: T, operator: OP, maxMultiplierX100: 196, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'HotFunded', tableId: T, amount: 50n, blockNumber: 2n },
      { type: 'RoundOpened', tableId: T, roundId: '0xr1', payout: 2n, stake: 1n, blockNumber: 9n },
      { type: 'RoundSettled', tableId: T, roundId: '0xr1', payout: 2n, won: false, blockNumber: 10n },
    ] as any
    const v = reduceTables(events, 10n, 100n)[0]!
    expect(v.escrowed).to.equal(0n)
    expect(v.hot).to.equal(51n) // 49 + full payout 2 back to hot on a loss
  })

  it('RoundSettled win: releases escrow but leaves hot unchanged', () => {
    const events = [
      { type: 'TableCreated', tableId: T2, operator: OP, maxMultiplierX100: 196, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'HotFunded', tableId: T2, amount: 50n, blockNumber: 2n },
      { type: 'RoundOpened', tableId: T2, roundId: '0xr2', payout: 2n, stake: 1n, blockNumber: 9n },
      { type: 'RoundSettled', tableId: T2, roundId: '0xr2', payout: 2n, won: true, blockNumber: 10n },
    ] as any
    const v = reduceTables(events, 10n, 100n)[0]!
    expect(v.escrowed).to.equal(0n)
    expect(v.hot).to.equal(49n) // unchanged by the settle; win payout does not return to hot
  })

  it('sorts armed tables by roundsRecent then stake', () => {
    const A = '0x0a' as any
    const B = '0x0b' as any
    const events = [
      { type: 'TableCreated', tableId: A, operator: OP, maxMultiplierX100: 100, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'HotFunded', tableId: A, amount: 10n, blockNumber: 2n },
      { type: 'Staked', tableId: A, amount: 3n, blockNumber: 3n },
      { type: 'TableCreated', tableId: B, operator: OP, maxMultiplierX100: 100, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'HotFunded', tableId: B, amount: 10n, blockNumber: 2n },
      { type: 'Staked', tableId: B, amount: 8n, blockNumber: 3n },
      // both armed + zero rounds -> tiebreak on stake: B (8) before A (3)
    ] as any
    const views = reduceTables(events, 10n, 100n)
    expect(views[0]!.tableId).to.equal(B)
    expect(views[1]!.tableId).to.equal(A)
  })

  it('excludes RoundOpened events older than windowBlocks from roundsRecent', () => {
    const events = [
      { type: 'TableCreated', tableId: T, operator: OP, maxMultiplierX100: 100, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'HotFunded', tableId: T, amount: 50n, blockNumber: 2n },
      { type: 'RoundOpened', tableId: T, roundId: '0xr1', payout: 1n, stake: 1n, blockNumber: 3n },
    ] as any
    // now=200, windowBlocks=100 -> round at block 3 is 197 blocks old, outside the window
    const v = reduceTables(events, 200n, 100n)[0]!
    expect(v.roundsRecent).to.equal(0)
  })
})

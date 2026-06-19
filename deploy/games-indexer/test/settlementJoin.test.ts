import { describe, it, expect } from 'vitest'
import { openedRow, settledUpdate, gameIdToName } from '../src/settlement'

// Fixtures — one complete Opened→Settled lifecycle for tableId 0xabc…
const TABLE_ID = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as const
const PLAYER   = '0x1111111111111111111111111111111111111111' as const
const TX_HASH  = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const

const openedEvent = {
  args: {
    tableId:      TABLE_ID,
    player:       PLAYER,
    playerKey:    '0x2222222222222222222222222222222222222222' as const,
    gameId:       1,           // → 'dice'
    escrowPlayer: 500_000_000_000_000_000n, // 0.5 ETH
    escrowHouse:  500_000_000_000_000_000n,
  },
  block: { number: 1000n, timestamp: 1_700_000_000n },
  transaction: { hash: TX_HASH },
}

const settledEvent = {
  args: {
    tableId:      TABLE_ID,
    payoutPlayer: 900_000_000_000_000_000n, // 0.9 ETH (player won)
    payoutHouse:  100_000_000_000_000_000n,
  },
}

describe('gameIdToName', () => {
  it('maps 1 → dice', () => expect(gameIdToName(1)).toBe('dice'))
  it('maps 2 → limbo', () => expect(gameIdToName(2)).toBe('limbo'))
  it('falls back to string for unknown ids', () => expect(gameIdToName(99)).toBe('99'))
})

describe('openedRow', () => {
  const row = openedRow(openedEvent)

  it('sets id = tableId', () => expect(row.id).toBe(TABLE_ID))
  it('sets tableId', () => expect(row.tableId).toBe(TABLE_ID))
  it('maps gameId 1 to game="dice"', () => expect(row.game).toBe('dice'))
  it('sets player', () => expect(row.player).toBe(PLAYER))
  it('sets escrowPlayer', () => expect(row.escrowPlayer).toBe(500_000_000_000_000_000n))
  it('leaves payoutPlayer null', () => expect(row.payoutPlayer).toBeNull())
  it('leaves net null', () => expect(row.net).toBeNull())
  it('sets blockNumber', () => expect(row.blockNumber).toBe(1000n))
  it('sets blockTimestamp', () => expect(row.blockTimestamp).toBe(1_700_000_000n))
  it('sets txHash', () => expect(row.txHash).toBe(TX_HASH))
})

describe('settledUpdate + join', () => {
  const openRow  = openedRow(openedEvent)
  const update   = settledUpdate(openRow, settledEvent)

  // Simulate the DB join: apply the update to the open row.
  const joined = { ...openRow, ...update }

  it('sets payoutPlayer', () => expect(update.payoutPlayer).toBe(900_000_000_000_000_000n))
  it('net = payoutPlayer - escrowPlayer', () =>
    expect(update.net).toBe(900_000_000_000_000_000n - 500_000_000_000_000_000n))
  it('net is positive when player wins', () => expect(update.net > 0n).toBe(true))

  // Full joined-row assertions (proves the Opened→Settled lifecycle)
  it('joined row has game="dice"', () => expect(joined.game).toBe('dice'))
  it('joined row has correct player', () => expect(joined.player).toBe(PLAYER))
  it('joined row has correct payoutPlayer', () =>
    expect(joined.payoutPlayer).toBe(900_000_000_000_000_000n))
  it('joined row net = payoutPlayer - escrowPlayer', () =>
    expect(joined.net).toBe(900_000_000_000_000_000n - 500_000_000_000_000_000n))
})

describe('settledUpdate — player loses', () => {
  const losingSettled = {
    args: {
      tableId:      TABLE_ID,
      payoutPlayer: 100_000_000_000_000_000n, // 0.1 ETH back (player lost most)
      payoutHouse:  900_000_000_000_000_000n,
    },
  }
  const openRow = openedRow(openedEvent)
  const update  = settledUpdate(openRow, losingSettled)

  it('net is negative when player loses', () => expect(update.net < 0n).toBe(true))
  it('net value is correct', () =>
    expect(update.net).toBe(100_000_000_000_000_000n - 500_000_000_000_000_000n))
})

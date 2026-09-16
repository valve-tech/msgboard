import { describe, it, expect } from 'vitest'
import { decodeTableLog } from './table-rounds'

const tableId = '0x1111111111111111111111111111111111111111111111111111111111111a' as const

describe('decodeTableLog', () => {
  it('maps a named-args log into the TableEvent shape reduceTables expects', () => {
    const e = decodeTableLog({
      eventName: 'HotFunded',
      args: { tableId, amount: 500n },
      blockNumber: 42n,
    })
    expect(e).toEqual({ tableId, amount: 500n, type: 'HotFunded', blockNumber: 42n })
  })

  it('carries every field through for a many-arg event (RoundOpened)', () => {
    const e = decodeTableLog({
      eventName: 'RoundOpened',
      args: {
        roundId: '0xaaaa',
        tableId,
        player: '0xbbbb',
        side: 0,
        stake: 10n,
        payout: 20n,
        subsetHash: '0xcccc',
        key: '0xdddd',
        openedAtBlock: 41n,
      },
      blockNumber: 41n,
    })
    expect(e?.type).toBe('RoundOpened')
    expect(e?.tableId).toBe(tableId)
    expect(e?.payout).toBe(20n)
    expect(e?.stake).toBe(10n)
    expect(e?.blockNumber).toBe(41n)
  })

  it('drops a log with no eventName', () => {
    expect(decodeTableLog({ args: { tableId }, blockNumber: 1n })).toBeUndefined()
  })

  it('drops a log with no tableId (foreign/malformed row)', () => {
    expect(decodeTableLog({ eventName: 'HotFunded', args: { amount: 1n }, blockNumber: 1n })).toBeUndefined()
  })

  it('drops a positionally-decoded (array) args log', () => {
    expect(decodeTableLog({ eventName: 'HotFunded', args: [tableId, 1n] as unknown as Record<string, unknown>, blockNumber: 1n })).toBeUndefined()
  })
})

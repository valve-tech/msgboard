import { describe, it, expect } from 'vitest'
import {
  foldOperatorTables,
  foldOperatorRounds,
  latestMetadataUri,
  verifyOperatorRound,
  type OperatorEvent,
  type OperatorOpenedLog,
} from './operatorIndex'

const TABLE = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const R1 = '0x00000000000000000000000000000000000000000000000000000000000000a1' as const
const R2 = '0x00000000000000000000000000000000000000000000000000000000000000a2' as const
const ME = '0x00000000000000000000000000000000000000Ab' as const
const OTHER = '0x00000000000000000000000000000000000000cD' as const
const OP = '0x00000000000000000000000000000000000000E0' as const
const TOKEN = '0x00000000000000000000000000000000000000F0' as const

const opened = (roundId: string, player: string, block: bigint): OperatorEvent => ({
  name: 'RoundOpened',
  args: { roundId, tableId: TABLE, player, side: 0, stake: 1n, payout: 2n, tierPrice: 1n, key: roundId, openedAtBlock: block },
  blockNumber: block,
})

describe('foldOperatorTables', () => {
  it('folds TableCreated then applies the last OpenSet', () => {
    const events: OperatorEvent[] = [
      { name: 'TableCreated', args: { tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 196, minStake: 1n, maxStake: 8n }, blockNumber: 1n },
      { name: 'OpenSet', args: { tableId: TABLE, open: false }, blockNumber: 2n },
      { name: 'OpenSet', args: { tableId: TABLE, open: true }, blockNumber: 3n },
    ]
    const [t] = foldOperatorTables(events)
    expect(t).toEqual({ tableId: TABLE, operator: OP, token: TOKEN, maxMultiplierX100: 196, minStake: 1n, maxStake: 8n, open: true })
  })

  it('ignores an OpenSet for an unknown table', () => {
    expect(foldOperatorTables([{ name: 'OpenSet', args: { tableId: TABLE, open: false }, blockNumber: 1n }])).toEqual([])
  })
})

describe('foldOperatorRounds', () => {
  it('keeps only my rounds, newest first, and indexes terminals', () => {
    const events: OperatorEvent[] = [
      opened(R1, ME, 10n),
      opened(R2, OTHER, 11n),
      { name: 'RoundSettled', args: { roundId: R1, tableId: TABLE, player: ME, won: true, payout: 2n, seed: '0x02' }, blockNumber: 12n },
    ]
    const { myRounds, settledByRound, refundedByRound } = foldOperatorRounds(events, [], ME)
    expect(myRounds.map((r) => r.roundId)).toEqual([R1])
    expect(settledByRound.get(R1)?.won).toBe(true)
    expect(refundedByRound.has(R1)).toBe(false)
  })

  it('merges a session round that is not yet indexed', () => {
    const session: OperatorOpenedLog = {
      roundId: R2, tableId: TABLE, player: ME, side: 1, stake: 1n, payout: 2n, tierPrice: 1n, key: R2, openedAtBlock: 20n,
    }
    const { myRounds } = foldOperatorRounds([opened(R1, ME, 10n)], [session], ME)
    expect(myRounds.map((r) => r.roundId)).toEqual([R2, R1]) // block 20 before block 10
  })

  it('marks a refunded round', () => {
    const events: OperatorEvent[] = [
      opened(R1, ME, 10n),
      { name: 'RoundRefunded', args: { roundId: R1, tableId: TABLE, player: ME, stake: 1n }, blockNumber: 13n },
    ]
    expect(foldOperatorRounds(events, [], ME).refundedByRound.has(R1)).toBe(true)
  })
})

describe('latestMetadataUri', () => {
  it('returns the last MetadataSet for the operator (case-insensitive)', () => {
    const events: OperatorEvent[] = [
      { name: 'MetadataSet', args: { operator: OP, uri: 'ipfs://one' }, blockNumber: 1n },
      { name: 'MetadataSet', args: { operator: OP.toLowerCase(), uri: 'ipfs://two' }, blockNumber: 2n },
    ]
    expect(latestMetadataUri(events, OP)).toBe('ipfs://two')
  })

  it('returns undefined when no operator or no match', () => {
    expect(latestMetadataUri([], OP)).toBeUndefined()
    expect(latestMetadataUri([{ name: 'MetadataSet', args: { operator: OTHER, uri: 'x' }, blockNumber: 1n }], OP)).toBeUndefined()
  })
})

describe('verifyOperatorRound', () => {
  it('accepts a consistent win (even seed, side 0)', () => {
    const o: OperatorOpenedLog = { roundId: R1, tableId: TABLE, player: ME, side: 0, stake: 1n, payout: 2n, tierPrice: 1n, key: R1, openedAtBlock: 10n }
    const s = { roundId: R1, tableId: TABLE, player: ME, won: true, payout: 2n, seed: ('0x' + '00'.repeat(31) + '02') as `0x${string}`, settledAtBlock: 12n }
    expect(verifyOperatorRound(o, s).ok).toBe(true)
  })

  it('rejects a win the seed parity contradicts', () => {
    const o: OperatorOpenedLog = { roundId: R1, tableId: TABLE, player: ME, side: 0, stake: 1n, payout: 2n, tierPrice: 1n, key: R1, openedAtBlock: 10n }
    const s = { roundId: R1, tableId: TABLE, player: ME, won: true, payout: 2n, seed: ('0x' + '00'.repeat(31) + '01') as `0x${string}`, settledAtBlock: 12n }
    const res = verifyOperatorRound(o, s)
    expect(res.ok).toBe(false)
    expect(res.reasons.join(' ')).toMatch(/parity/i)
  })
})

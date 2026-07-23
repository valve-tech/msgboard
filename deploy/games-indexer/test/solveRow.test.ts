import { describe, it, expect } from 'vitest'
import { SOLVE_SCHEMAS } from '../schemas'
import { solveRow } from '../src/solves'

const UID      = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const SOLVER   = '0x3333333333333333333333333333333333333333' as const
const ATTESTER = '0x4444444444444444444444444444444444444444' as const
const TX_HASH  = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const

const attestedEvent = (schemaUID: `0x${string}`) => ({
  args: { recipient: SOLVER, attester: ATTESTER, uid: UID, schemaUID },
  block: { number: 24_932_300n, timestamp: 1_752_000_000n },
  transaction: { hash: TX_HASH },
})

const SUDOKU_943 = Object.keys(SOLVE_SCHEMAS)[0] as `0x${string}`

describe('SOLVE_SCHEMAS', () => {
  it('pins exactly four schema UIDs (sudoku+wordle × 943+369)', () => {
    expect(Object.keys(SOLVE_SCHEMAS)).toHaveLength(4)
    expect(Object.values(SOLVE_SCHEMAS).sort()).toEqual(['sudoku', 'sudoku', 'wordle', 'wordle'])
  })
  it('every UID is a bytes32 hex string', () => {
    for (const uid of Object.keys(SOLVE_SCHEMAS)) expect(uid).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('solveRow', () => {
  it('maps every pinned schema UID to its game', () => {
    for (const [schemaUid, game] of Object.entries(SOLVE_SCHEMAS)) {
      const row = solveRow(943, attestedEvent(schemaUid as `0x${string}`))
      expect(row?.game).toBe(game)
      expect(row?.schemaUid).toBe(schemaUid)
    }
  })

  it('returns null for a schema UID that is not ours', () => {
    expect(solveRow(943, attestedEvent(`0x${'ff'.repeat(32)}`))).toBeNull()
  })

  const row = solveRow(943, attestedEvent(SUDOKU_943))!

  it('disambiguates the id by chain (same uid on both chains → distinct rows)', () => {
    expect(row.id).toBe(`943-${UID}`)
    expect(solveRow(369, attestedEvent(SUDOKU_943))!.id).toBe(`369-${UID}`)
  })
  it('sets solver = attestation recipient', () => expect(row.solver).toBe(SOLVER))
  it('sets attester', () => expect(row.attester).toBe(ATTESTER))
  it('sets uid', () => expect(row.uid).toBe(UID))
  it('sets chainId', () => expect(row.chainId).toBe(943))
  it('sets blockNumber', () => expect(row.blockNumber).toBe(24_932_300n))
  it('sets blockTimestamp', () => expect(row.blockTimestamp).toBe(1_752_000_000n))
  it('sets txHash', () => expect(row.txHash).toBe(TX_HASH))
})

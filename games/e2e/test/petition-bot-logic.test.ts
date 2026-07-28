import { describe, expect, it } from 'vitest'
import { keccak256, toBytes, type Hex } from 'viem'
import { derivePetitionId, type Petition } from '@msgboard/petition'
import { petitionsNeedingCreation, outstandingToSettle } from '../scripts/petition-bot-logic'

const CREATOR = '0x1111111111111111111111111111111111111111' as Hex
const saltFor = (statement: string): Hex => keccak256(toBytes(`petition-bot:${statement}`))

const makePetition = (statement: string, overrides: Partial<Petition> = {}): Petition => {
  const salt = saltFor(statement)
  return {
    id: derivePetitionId(statement, CREATOR, salt),
    statement,
    creator: CREATOR,
    createdAt: 1000,
    chainId: 943,
    salt,
    ...overrides,
  }
}

describe('petitionsNeedingCreation', () => {
  it('returns nothing when every wanted statement already exists', () => {
    const existing = [makePetition('Free the whales')]
    expect(petitionsNeedingCreation(existing, ['Free the whales'], CREATOR, saltFor)).toEqual([])
  })

  it('returns an entry for each missing statement, with its derived id + salt', () => {
    const existing = [makePetition('Free the whales')]
    const result = petitionsNeedingCreation(
      existing,
      ['Free the whales', 'Save the bees'],
      CREATOR,
      saltFor,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.statement).toBe('Save the bees')
    expect(result[0]!.salt).toBe(saltFor('Save the bees'))
    expect(result[0]!.id).toBe(derivePetitionId('Save the bees', CREATOR, saltFor('Save the bees')))
  })

  it('is idempotent across restarts: same statement + creator + saltFor always derives the same id', () => {
    const first = petitionsNeedingCreation([], ['Save the bees'], CREATOR, saltFor)
    const second = petitionsNeedingCreation([], ['Save the bees'], CREATOR, saltFor)
    expect(first[0]!.id).toBe(second[0]!.id)
  })

  it('handles an empty wanted list', () => {
    expect(petitionsNeedingCreation([makePetition('x')], [], CREATOR, saltFor)).toEqual([])
  })
})

describe('outstandingToSettle', () => {
  const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex
  const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex
  const C = '0xcccccccccccccccccccccccccccccccccccccccc' as Hex

  it('returns captured signers not yet settled', () => {
    expect(outstandingToSettle([A, B, C], [B])).toEqual([A, C])
  })

  it('returns nothing when everyone captured is already settled', () => {
    expect(outstandingToSettle([A, B], [A, B])).toEqual([])
  })

  it('returns everyone when nothing is settled yet', () => {
    expect(outstandingToSettle([A, B], [])).toEqual([A, B])
  })

  it('is case-insensitive on both sides', () => {
    expect(outstandingToSettle([A], [A.toUpperCase() as Hex])).toEqual([])
    expect(outstandingToSettle([A.toUpperCase() as Hex], [A])).toEqual([])
  })

  it('dedupes a repeated captured signer, keeping first-seen casing', () => {
    expect(outstandingToSettle([A, A.toUpperCase() as Hex], [])).toEqual([A])
  })

  it('handles an empty captured list', () => {
    expect(outstandingToSettle([], [A])).toEqual([])
  })
})

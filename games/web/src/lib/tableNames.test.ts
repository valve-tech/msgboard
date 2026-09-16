import { describe, it, expect } from 'vitest'
import { cleanTableName, MAX_NAME } from './tableNames'

describe('cleanTableName', () => {
  it('trims and collapses interior whitespace to single spaces', () => {
    expect(cleanTableName('  Mike\'s   \n table  ')).to.equal("Mike's table")
  })
  it('caps length at MAX_NAME', () => {
    const long = 'x'.repeat(MAX_NAME + 20)
    expect(cleanTableName(long)).to.have.lengthOf(MAX_NAME)
  })
  it('returns empty string for whitespace-only input', () => {
    expect(cleanTableName('   \t  ')).to.equal('')
  })
})

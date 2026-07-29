import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { parseStake } from '../src/components/StakeInput'

describe('parseStake', () => {
  it('accepts arbitrary in-range decimals — no forced step/denomination rounding', () => {
    // None of these sit on the old 0.1/1/10 preset ladder or any other fixed step.
    expect(parseStake('2.37')).to.equal(viem.parseEther('2.37'))
    expect(parseStake('0.000000000000000001')).to.equal(1n) // 1 wei — full 18-decimal precision
    expect(parseStake('3.141592653589793238')).to.equal(viem.parseEther('3.141592653589793238'))
    expect(parseStake('123.456789')).to.equal(viem.parseEther('123.456789'))
    // Leading/trailing whitespace and a bare decimal are both fine.
    expect(parseStake('  5  ')).to.equal(viem.parseEther('5'))
    expect(parseStake('.5')).to.equal(viem.parseEther('.5'))
  })

  it('still accepts the quick-fill preset values (they are conveniences, not the only option)', () => {
    expect(parseStake('0.1')).to.equal(viem.parseEther('0.1'))
    expect(parseStake('1')).to.equal(viem.parseEther('1'))
    expect(parseStake('10')).to.equal(viem.parseEther('10'))
  })

  it('rejects non-numeric, empty, zero, and negative input', () => {
    expect(parseStake('')).to.equal(undefined)
    expect(parseStake('abc')).to.equal(undefined)
    expect(parseStake('1,5')).to.equal(undefined)
    expect(parseStake('1e5')).to.equal(undefined) // no scientific notation
    expect(parseStake('-1')).to.equal(undefined)
    expect(parseStake('0')).to.equal(undefined)
    expect(parseStake('0.0')).to.equal(undefined)
    expect(parseStake('NaN')).to.equal(undefined)
    expect(parseStake('1.2.3')).to.equal(undefined)
  })
})

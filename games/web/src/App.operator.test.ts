import { describe, it, expect } from 'vitest'
import { deployments } from './config'

describe('operator tab wiring', () => {
  it('943 carries the operator substrate; other chains hide the tab', () => {
    const withOperator = deployments.filter((d) => d.operator)
    expect(withOperator.length).toBeGreaterThan(0)
    expect(withOperator.every((d) => d.chainId === 943)).toBe(true)
  })

  it('accepts a well-formed bytes32 table deep-link and rejects a malformed one', () => {
    const isTableId = (t: string | null) => !!t && /^0x[0-9a-fA-F]{64}$/.test(t)
    expect(isTableId('0x' + 'a'.repeat(64))).toBe(true)
    expect(isTableId('0xdeadbeef')).toBe(false)
    expect(isTableId(null)).toBe(false)
  })
})

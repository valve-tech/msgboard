import { describe, expect, it } from 'vitest'
import { OWNABLE_VALIDATOR_ADDRESS, OWNABLE_VALIDATOR_RUNTIME } from '../../src/adapters/rhinestone.js'

describe('OwnableValidator pinned constants', () => {
  it('pins the canonical module address', () => {
    expect(OWNABLE_VALIDATOR_ADDRESS).toBe('0x2483DA3A338895199E5e538530213157e931Bf06')
  })

  it('pins runtime bytecode that carries the selectors the adapter calls', () => {
    const code = OWNABLE_VALIDATOR_RUNTIME.toLowerCase()
    expect(code.startsWith('0x60')).toBe(true)
    // validateSignatureWithData / getOwners / threshold / isValidSignatureWithSender selectors
    for (const sel of ['940d3840', 'fd8b84b1', 'c86ec2bf', 'f551e2ee']) {
      expect(code.includes(sel)).toBe(true)
    }
  })
})

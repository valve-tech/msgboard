import { describe, expect, it } from 'vitest'
import { rpcs } from '../src/lib/rpc'

describe('chip faucet config', () => {
  it('pulsechainV4 (943) declares a chipFaucet, others do not', () => {
    expect(rpcs.get('pulsechainV4')?.chipFaucet?.category).toBe('chipsplease:943')
    expect(rpcs.get('pulsechainV4')?.chipFaucet?.chips.toLowerCase())
      .toBe('0x81f130c7d9ff020f46f3b01918424173f8d5ca64')
    expect(rpcs.get('ethereum')?.chipFaucet).toBeUndefined()
  })
})

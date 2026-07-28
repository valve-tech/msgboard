import { describe, expect, it } from 'vitest'
import { isAddress, stringToHex } from 'viem'
import { chipFaucetConfig } from '../src/runChipFaucet'

const account = { address: '0xfaucet' } as never
const chips = '0x81f130c7d9ff020f46f3b01918424173f8d5ca64' as const
const addrMsg = { data: '0x1111111111111111111111111111111111111111', hash: '0xAAA' } as never
const junkMsg = { data: '0xnotanaddress', hash: '0xBBB' } as never

describe('chipFaucetConfig', () => {
  it('accepts an address post and rejects a non-address post', async () => {
    const cfg = chipFaucetConfig({ account, chips, rpcUrl: 'http://x' })
    expect(await cfg.condition!(addrMsg, {} as never)).toBe(true)
    expect(await cfg.condition!(junkMsg, {} as never)).toBe(false)
  })
  it('dedups by lowercased message hash (one PoW post = one grant)', () => {
    const cfg = chipFaucetConfig({ account, chips, rpcUrl: 'http://x' })
    expect(cfg.key!(addrMsg)).toBe('0xaaa')
  })
  it('mints to the post\'s data address (the wire trick)', () => {
    const cfg = chipFaucetConfig({ account, chips, rpcUrl: 'http://x' })
    expect(cfg.action.describe(addrMsg, {} as never)).toMatch(/0x1111/i)
  })
})

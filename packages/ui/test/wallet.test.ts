import { describe, expect, it, vi } from 'vitest'
import { connectInjectedWallet } from '../src/lib/wallet'

describe('connectInjectedWallet', () => {
  it('requests accounts and returns the address + chainId', async () => {
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' ? ['0x1111111111111111111111111111111111111111']
      : method === 'eth_chainId' ? '0x3af' : undefined)
    ;(globalThis as never as { window: unknown }).window = { ethereum: { request } }
    const res = await connectInjectedWallet()
    expect(res.address.toLowerCase()).toBe('0x1111111111111111111111111111111111111111')
    expect(res.chainId).toBe(943)
  })
})

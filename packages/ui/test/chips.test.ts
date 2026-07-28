import { describe, it, expect, vi } from 'vitest'
import type { Hex, PublicClient } from 'viem'
import { readChipsBalance } from '../src/lib/chips'

describe('readChipsBalance', () => {
  it('reads balanceOf(addr) on the Chips token via the given client', async () => {
    const readContract = vi.fn(async () => 777n)
    const client = { readContract } as unknown as PublicClient
    const chips = ('0x' + '11'.repeat(20)) as Hex
    const addr = ('0x' + '22'.repeat(20)) as Hex

    const bal = await readChipsBalance(client, chips, addr)

    expect(bal).toBe(777n)
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: chips,
        functionName: 'balanceOf',
        args: [addr],
      }),
    )
  })
})

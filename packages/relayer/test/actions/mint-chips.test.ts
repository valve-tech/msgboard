import { describe, expect, it, vi } from 'vitest'
import { mintChipsAction } from '../../src/actions/mint-chips.js'
import type { RelayerContext } from '../../src/types.js'

const chips = '0x81f130c7d9ff020f46f3b01918424173f8d5ca64' as const
const recipient = '0x1111111111111111111111111111111111111111' as const

describe('mintChipsAction', () => {
  it('describe reports the recipient and amount', () => {
    const action = mintChipsAction<string>({
      account: { address: '0xfrom' } as never,
      chips, recipient: (item) => item as `0x${string}`,
      amount: 1000n, cap: 1000n,
    })
    expect(action.describe(recipient, {} as RelayerContext)).toMatch(recipient)
  })

  it('execute mints min(amount,cap) to the recipient and waits for the receipt', async () => {
    const writeContract = vi.fn(async () => '0xtx')
    const waitForTransactionReceipt = vi.fn(async () => ({ transactionHash: '0xtx' }))
    const ctx = { chain: { id: 943 }, node: { transport: {} as never },
      publicClient: { waitForTransactionReceipt } } as unknown as RelayerContext
    const action = mintChipsAction<string>({
      account: { address: '0xfrom' } as never, chips,
      recipient: (item) => item as `0x${string}`, amount: 5000n, cap: 1000n,
      walletFactory: () => ({ writeContract }) as never,
    })
    const result = await action.execute(recipient, ctx)
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({
      address: chips, functionName: 'mint', args: [recipient, 1000n], // capped from 5000
    }))
    expect(result).toEqual({ ok: true, ref: '0xtx' })
  })
})

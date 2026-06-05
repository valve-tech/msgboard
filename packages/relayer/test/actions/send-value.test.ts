import { describe, expect, it, vi } from 'vitest'
import { sendValueAction } from '../../src/actions/send-value.js'
import type { RelayerContext } from '../../src/types.js'

const recipient = '0x1111111111111111111111111111111111111111'

describe('sendValueAction', () => {
  it('describe reports the recipient and amount', () => {
    const action = sendValueAction<string>({
      account: { address: '0xfrom' } as never,
      recipient: (item) => item as `0x${string}`,
      amount: 10n * 10n ** 18n,
      gas: 25_200n,
    })
    const ctx = {} as RelayerContext
    expect(action.describe(recipient, ctx)).toMatch(recipient)
    expect(action.describe(recipient, ctx)).toMatch(/10/)
  })

  it('execute sends the transaction and waits for the receipt', async () => {
    const sendTransaction = vi.fn(async () => '0xtx')
    const waitForTransactionReceipt = vi.fn(async () => ({ transactionHash: '0xtx' }))
    const ctx = {
      chain: { id: 943 },
      node: { rpcUrl: 'http://localhost' },
      publicClient: { waitForTransactionReceipt },
    } as unknown as RelayerContext
    const action = sendValueAction<string>({
      account: { address: '0xfrom' } as never,
      recipient: (item) => item as `0x${string}`,
      amount: 10n * 10n ** 18n,
      gas: 25_200n,
      walletFactory: () => ({ sendTransaction }) as never,
    })
    const result = await action.execute(recipient, ctx)
    expect(sendTransaction).toHaveBeenCalled()
    expect(result).toEqual({ ok: true, ref: '0xtx' })
  })
})

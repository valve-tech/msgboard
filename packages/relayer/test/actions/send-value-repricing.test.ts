import { describe, expect, it, vi } from 'vitest'
import { sendValueRepricingAction } from '../../src/actions/send-value-repricing.js'
import type { RelayerContext } from '../../src/types.js'

const recipient = '0x1111111111111111111111111111111111111111'
const account = { address: '0xfrom' } as never

const mkCtx = (over: Partial<Record<string, unknown>>) =>
  ({
    chain: { id: 943 },
    node: { transport: {} as never },
    publicClient: {
      getBlock: vi.fn(async () => ({ baseFeePerGas: 7n })), // 943: near-zero baseFee
      getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) =>
        blockTag === 'pending' ? 5 : 5,
      ),
      waitForTransactionReceipt: vi.fn(async () => ({ transactionHash: '0xtx' })),
      ...over,
    },
  }) as unknown as RelayerContext

describe('sendValueRepricingAction', () => {
  it('describe reports recipient, amount, and the dynamic-fee+RBF strategy', () => {
    const action = sendValueRepricingAction<string>({
      account,
      recipient: (item) => item as `0x${string}`,
      amount: 10n * 10n ** 18n,
      gas: 25_200n,
    })
    const s = action.describe(recipient, {} as RelayerContext)
    expect(s).toMatch(recipient)
    expect(s).toMatch(/10/)
    expect(s).toMatch(/RBF/)
  })

  it('mines on the first attempt: one send, fee derived from baseFee (never eth_gasPrice)', async () => {
    const sendTransaction = vi.fn(async () => '0xaaa' as `0x${string}`)
    const ctx = mkCtx({})
    const action = sendValueRepricingAction<string>({
      account,
      recipient: (item) => item as `0x${string}`,
      amount: 1n,
      gas: 21_000n,
      walletFactory: () => ({ sendTransaction }) as never,
    })
    const res = await action.execute(recipient, ctx)
    expect(res).toEqual({ ok: true, ref: '0xaaa' })
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    // fee came from getBlock().baseFeePerGas, and no getGasPrice exists on the mock (would throw if used)
    expect((ctx.publicClient as unknown as { getBlock: ReturnType<typeof vi.fn> }).getBlock).toHaveBeenCalled()
    const arg = (sendTransaction.mock.calls[0] as unknown[])[0] as { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number }
    expect(arg.nonce).toBe(5)
    expect(arg.maxPriorityFeePerGas).toBe(2_000_000_000n) // 2 gwei floor
    expect(arg.maxFeePerGas).toBe(7n * 2n + 2_000_000_000n)
  })

  it('reprices + replaces the SAME nonce at a higher fee when a receipt times out', async () => {
    const sendTransaction = vi
      .fn()
      .mockResolvedValueOnce('0xaaa' as `0x${string}`)
      .mockResolvedValueOnce('0xbbb' as `0x${string}`)
    const waitForTransactionReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce({ transactionHash: '0xbbb' })
    const ctx = mkCtx({ waitForTransactionReceipt })
    const action = sendValueRepricingAction<string>({
      account,
      recipient: (item) => item as `0x${string}`,
      amount: 1n,
      gas: 21_000n,
      staleMs: 1,
      walletFactory: () => ({ sendTransaction }) as never,
    })
    const res = await action.execute(recipient, ctx)
    expect(res).toEqual({ ok: true, ref: '0xbbb' })
    expect(sendTransaction).toHaveBeenCalledTimes(2)
    const first = sendTransaction.mock.calls[0][0] as { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
    const second = sendTransaction.mock.calls[1][0] as { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
    expect(second.nonce).toBe(first.nonce) // replace-by-fee: same nonce
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas) // bumped
    expect(second.maxPriorityFeePerGas).toBeGreaterThan(first.maxPriorityFeePerGas)
  })

  it('returns ok without re-sending if the nonce already confirmed', async () => {
    const sendTransaction = vi.fn(async () => '0xaaa' as `0x${string}`)
    let latest = 6 // already past nonce 5
    const ctx = mkCtx({
      getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) =>
        blockTag === 'pending' ? 5 : latest,
      ),
    })
    const action = sendValueRepricingAction<string>({
      account,
      recipient: (item) => item as `0x${string}`,
      amount: 1n,
      gas: 21_000n,
      walletFactory: () => ({ sendTransaction }) as never,
    })
    const res = await action.execute(recipient, ctx)
    expect(res.ok).toBe(true)
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})

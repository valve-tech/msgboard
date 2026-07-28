import { describe, expect, it, vi } from 'vitest'
import { computeTopUp, refuelGas } from '../src/gasRefill'

const funder = { address: '0xf00' } as never
const target = '0x1111111111111111111111111111111111111111' as const

describe('computeTopUp', () => {
  it('returns 0 when the balance is at or above the threshold', () => {
    expect(computeTopUp(50n, { below: 50n, to: 200n })).toBe(0n)
    expect(computeTopUp(60n, { below: 50n, to: 200n })).toBe(0n)
  })
  it('tops up to `to` when the balance is below the threshold', () => {
    expect(computeTopUp(10n, { below: 50n, to: 200n })).toBe(190n)
    expect(computeTopUp(0n, { below: 50n, to: 200n })).toBe(200n)
  })
  it('never returns a negative amount', () => {
    expect(computeTopUp(300n, { below: 50n, to: 200n })).toBe(0n)
  })
})

describe('refuelGas', () => {
  it('sends the top-up from the funder with explicit fees when below the threshold', async () => {
    const sendTransaction = vi.fn(async () => '0xtx' as const)
    const publicClient = { getBalance: async () => 10n }
    const res = await refuelGas({
      publicClient, walletClient: { sendTransaction }, funder, target,
      below: 50n, to: 200n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 500_000_000n,
    })
    expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({
      account: funder, to: target, value: 190n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 500_000_000n,
    }))
    expect(res).toEqual({ topUp: 190n, hash: '0xtx' })
  })

  it('does nothing (no tx) when the target is already funded', async () => {
    const sendTransaction = vi.fn(async () => '0xtx' as const)
    const publicClient = { getBalance: async () => 100n }
    const res = await refuelGas({ publicClient, walletClient: { sendTransaction }, funder, target, below: 50n, to: 200n })
    expect(sendTransaction).not.toHaveBeenCalled()
    expect(res).toEqual({ topUp: 0n })
  })

  it('defaults to PulseChain-sane EIP-1559 fees when none are given', async () => {
    const sendTransaction = vi.fn(async () => '0xtx' as const)
    const publicClient = { getBalance: async () => 0n }
    await refuelGas({ publicClient, walletClient: { sendTransaction }, funder, target, below: 50n, to: 200n })
    expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({
      maxFeePerGas: 2_000_000_000n, // 2 gwei
      maxPriorityFeePerGas: 500_000_000n, // 0.5 gwei
    }))
  })
})

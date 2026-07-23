import { http } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain } from '@msgboard/games'
import { OptimisticSettlement } from '@msgboard/settle'
import { makeSettlementRelayer } from '../src/worker'
import type { SettleSubmitRequest } from '../src/settleAction'
import type { SettleReadySession } from '../src/types'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex
const domain = makeDomain(31337, bankroll)

async function readySession(tableId: Hex, rounds: number): Promise<SettleReadySession> {
  const s = new HouseSession({
    domain, tableId, game: dice, player, house,
    seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 16,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
  })
  await s.open()
  for (let i = 0; i < rounds; i++) {
    await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
  }
  const settlement = new OptimisticSettlement({
    parties: { player: player.address, house: house.address }, commit: s.chain.commit,
    game: dice, domain, settlementMode: 0, bankroll,
  })
  return { tableId, transcriptJson: s.transcript.toJSON(), settlement, trigger: 'cooperative-final', observedAt: 0 }
}

const node = { transport: http('http://localhost:8545'), chain: pulsechainV4 }

describe('makeSettlementRelayer', () => {
  it('observe mode (default) lands nothing — describes only', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0x0' as Hex }))
    const s = await readySession(`0x${'aa'.repeat(32)}`, 3)
    const relayer = makeSettlementRelayer({
      node, provider: async () => [s], submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    const report = await relayer.runOnce()
    expect(report.described).toBe(1)
    expect(report.executed).toBe(0)
    expect(submitTx).not.toHaveBeenCalled()
  })

  it('live mode lands a settle-ready session (right calldata submitted)', async () => {
    const submitTx = vi.fn(async (_req: SettleSubmitRequest) => ({ hash: '0xbeef' as Hex }))
    const s = await readySession(`0x${'aa'.repeat(32)}`, 4)
    const relayer = makeSettlementRelayer({
      node, mode: 'live', provider: async () => [s], submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    const report = await relayer.runOnce()
    expect(report.executed).toBe(1)
    const req = submitTx.mock.calls[0]![0]
    expect(req.tx.functionName).toBe('settle')
    expect((req.tx.args[1] as { nonce: bigint }).nonce).toBe(4n)
  })

  it('nonce window pipelines two parallel sessions in one tick', async () => {
    const submitTx = vi.fn(async (r: { nonce: number }) => ({ hash: `0x${r.nonce}` as Hex }))
    const a = await readySession(`0x${'aa'.repeat(32)}`, 2)
    const b = await readySession(`0x${'bb'.repeat(32)}`, 3)
    const relayer = makeSettlementRelayer({
      node, mode: 'live', provider: async () => [a, b], submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 999_999 },
    })
    const report = await relayer.runOnce()
    expect(report.executed).toBe(2)
    expect(submitTx.mock.calls.map((c) => c[0].nonce).sort()).toEqual([0, 1])
  })

  it('replace-by-fee bumps a stuck settle tx on a later tick', async () => {
    let now = 0
    const submitTx = vi.fn(async (_req: SettleSubmitRequest) => ({ hash: '0xstuck' as Hex }))
    const s = await readySession(`0x${'aa'.repeat(32)}`, 2)
    const relayer = makeSettlementRelayer({
      node, mode: 'live', provider: async () => [s], submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      config: { signStaleMs: 999_999, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
      now: () => now,
    })
    await relayer.runOnce()           // submit @100
    now = 6_000                        // stale
    await relayer.runOnce()            // RBF same nonce, higher fee
    expect(submitTx).toHaveBeenCalledTimes(2)
    const first = submitTx.mock.calls[0]![0]
    const second = submitTx.mock.calls[1]![0]
    expect(second.nonce).toBe(first.nonce)
    expect(second.fees.maxFeePerGas).toBeGreaterThan(first.fees.maxFeePerGas)
  })
})

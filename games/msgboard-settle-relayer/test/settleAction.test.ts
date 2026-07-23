import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain } from '@msgboard/games'
import { OptimisticSettlement } from '@msgboard/settle'
import { createPendingTxTracker } from '@msgboard/relayer'
import { makeSettleAction, type SettleSubmitRequest } from '../src/settleAction'
import type { SettleJob, SettleReadySession } from '../src/types'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex
const domain = makeDomain(31337, bankroll)

async function job(tableId: Hex, rounds: number): Promise<SettleJob> {
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
  const session: SettleReadySession = {
    tableId, transcriptJson: s.transcript.toJSON(), settlement, trigger: 'cooperative-final', observedAt: 0,
  }
  return { session }
}

describe('settleAction', () => {
  it('builds the correct settle calldata and submits it (simulate->write)', async () => {
    const submitTx = vi.fn(async (_req: SettleSubmitRequest) => ({ hash: '0xdead' as Hex }))
    const action = makeSettleAction({
      tracker: createPendingTxTracker({ windowSize: 4, baseNonce: 0 }),
      submitTx,
      initialFees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n }),
      staleMs: 999_999,
    })
    const j = await job(`0x${'aa'.repeat(32)}`, 4)
    const result = await action.execute(j, {} as never)
    expect(result.ok).toBe(true)
    expect(submitTx).toHaveBeenCalledTimes(1)
    const req = submitTx.mock.calls[0]![0]
    // the TxRequest came from OptimisticSettlement.buildSettle
    expect(req.tx.address).toBe(bankroll)
    expect(req.tx.functionName).toBe('settle')
    expect(req.tx.args).toHaveLength(6) // open, final, 4 sigs
    expect((req.tx.args[1] as { nonce: bigint }).nonce).toBe(4n) // final state nonce
    expect(req.nonce).toBe(0)
    expect(req.fees.maxFeePerGas).toBe(100n)
  })

  it('describe is pure and submits nothing (observe-mode safe)', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0x0' as Hex }))
    const action = makeSettleAction({
      tracker: createPendingTxTracker({ windowSize: 4, baseNonce: 0 }),
      submitTx,
      initialFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      staleMs: 1,
    })
    const j = await job(`0x${'bb'.repeat(32)}`, 1)
    const text = action.describe(j, {} as never)
    expect(text).toContain('settle')
    expect(text).toContain('0xbb'.slice(0, 6))
    expect(submitTx).not.toHaveBeenCalled()
  })

  it('refuses to submit a tampered transcript (buildSettle throws -> ok:false, nothing sent)', async () => {
    const submitTx = vi.fn(async () => ({ hash: '0x0' as Hex }))
    const action = makeSettleAction({
      tracker: createPendingTxTracker({ windowSize: 4, baseNonce: 0 }),
      submitTx,
      initialFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      staleMs: 999_999,
    })
    const j = await job(`0x${'cc'.repeat(32)}`, 3)
    // tamper: flip a byte in the transcript JSON so chain/sig verify fails
    const tampered = { ...j, session: { ...j.session, transcriptJson: j.session.transcriptJson.replace('1000', '9999') } }
    const result = await action.execute(tampered, {} as never)
    expect(result.ok).toBe(false)
    expect(submitTx).not.toHaveBeenCalled() // never submits forged/altered state
  })
})

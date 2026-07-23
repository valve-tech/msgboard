import { http } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain, verifySessionStateSig } from '@msgboard/games'
import { OptimisticSettlement } from '@msgboard/settle'
import { makeSettlementRelayer } from '../src/worker'
import type { SettleSubmitRequest } from '../src/settleAction'
import type { SettleReadySession } from '../src/types'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex
const domain = makeDomain(31337, bankroll)
const node = { transport: http('http://localhost:8545'), chain: pulsechainV4 }

async function ready(tableId: Hex, rounds: number): Promise<SettleReadySession> {
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

const baseFees = async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 2n })
const cfg = { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 }

describe('worker safety invariants (spec §7 / §10)', () => {
  it('NEVER acts in observe mode — its default is to do nothing', async () => {
    const submitTx = vi.fn(async (_req: SettleSubmitRequest) => ({ hash: '0x0' as Hex }))
    const r = makeSettlementRelayer({ node, provider: async () => [await ready(`0x${'aa'.repeat(32)}`, 3)], submitTx, initialFees: baseFees, config: cfg })
    await r.runOnce()
    expect(submitTx).not.toHaveBeenCalled()
  })

  it('NEVER forges: it only submits a transcript it was given, and only what the SIGNATURES say', async () => {
    const submitTx = vi.fn(async (_req: SettleSubmitRequest) => ({ hash: '0xok' as Hex }))
    const s = await ready(`0x${'aa'.repeat(32)}`, 4)
    const r = makeSettlementRelayer({ node, mode: 'live', provider: async () => [s], submitTx, initialFees: baseFees, config: cfg })
    await r.runOnce()
    const req = submitTx.mock.calls[0]![0]
    const [openState, finalState, openSigP, openSigH, finalSigP, finalSigH] = req.tx.args as any[]
    // every submitted state carries BOTH real co-signatures — the worker added nothing of its own
    expect(await verifySessionStateSig(player.address, domain, openState, openSigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, openState, openSigH)).toBe(true)
    expect(await verifySessionStateSig(player.address, domain, finalState, finalSigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, finalState, finalSigH)).toBe(true)
  })

  it('NEVER lands a tampered/forged payout: a flipped balance makes buildSettle reject -> no tx', async () => {
    const submitTx = vi.fn(async (_req: SettleSubmitRequest) => ({ hash: '0x0' as Hex }))
    const s = await ready(`0x${'aa'.repeat(32)}`, 3)
    const forged: SettleReadySession = { ...s, transcriptJson: s.transcriptJson.replace('1000', '999999') }
    const r = makeSettlementRelayer({ node, mode: 'live', provider: async () => [forged], submitTx, initialFees: baseFees, config: cfg })
    const report = await r.runOnce()
    expect(submitTx).not.toHaveBeenCalled()
    expect(report.executed).toBe(0)
  })

  it('NEVER withholds: an absent/failing submitter delays but cannot censor — a later tick re-lands it', async () => {
    let fail = true
    const submitTx = vi.fn(async (_req: SettleSubmitRequest) => {
      if (fail) throw new Error('rpc down')
      return { hash: '0xlanded' as Hex }
    })
    const s = await ready(`0x${'aa'.repeat(32)}`, 2)
    const r = makeSettlementRelayer({ node, mode: 'live', provider: async () => [s], submitTx, initialFees: baseFees, config: cfg })
    await r.runOnce()                 // submitter throws -> nothing remembered, isolated by the engine
    fail = false
    const report = await r.runOnce()  // same session re-offered; now it lands
    expect(report.executed).toBe(1)
    expect(submitTx).toHaveBeenCalledTimes(2)
  })

  it('its ONLY power is WHEN: two workers offered the same session both build identical calldata', async () => {
    const calls: any[] = []
    const submitTx = vi.fn(async (r: SettleSubmitRequest) => { calls.push(r.tx); return { hash: '0x0' as Hex } })
    const s = await ready(`0x${'aa'.repeat(32)}`, 4)
    const w1 = makeSettlementRelayer({ node, mode: 'live', provider: async () => [s], submitTx, initialFees: baseFees, config: cfg })
    const w2 = makeSettlementRelayer({ node, mode: 'live', provider: async () => [s], submitTx, initialFees: baseFees, config: cfg })
    await w1.runOnce()
    await w2.runOnce()
    // identical calldata regardless of which worker runs — the worker contributes no degrees of freedom to WHAT settles
    expect(JSON.stringify(calls[0].args, bigintReplacer)).toBe(JSON.stringify(calls[1].args, bigintReplacer))
  })
})

const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

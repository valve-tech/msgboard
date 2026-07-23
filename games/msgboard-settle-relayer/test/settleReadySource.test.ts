import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain } from '@msgboard/games'
import { OptimisticSettlement } from '@msgboard/settle'
import { settleReadySource } from '../src/settleReadySource'
import type { SettleReadySession } from '../src/types'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex

async function buildSession(tableId: Hex, rounds: number): Promise<SettleReadySession> {
  const domain = makeDomain(31337, bankroll)
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

describe('settleReadySource', () => {
  it('yields one SettleJob per settle-ready session reported by the provider', async () => {
    const a = await buildSession(`0x${'aa'.repeat(32)}`, 3)
    const b = await buildSession(`0x${'bb'.repeat(32)}`, 5)
    const source = settleReadySource({ provider: async () => [a, b] })
    const jobs = await source.poll({} as never)
    expect(jobs.map((j) => j.session.tableId)).toEqual([a.tableId, b.tableId])
  })

  it('parallel sessions are independent jobs (no shared state, no ordering coupling)', async () => {
    const a = await buildSession(`0x${'aa'.repeat(32)}`, 2)
    const b = await buildSession(`0x${'bb'.repeat(32)}`, 7)
    const source = settleReadySource({ provider: async () => [b, a] }) // reversed
    const jobs = await source.poll({} as never)
    expect(jobs).toHaveLength(2)
    expect(jobs[0]!.session).toBe(b)
    expect(jobs[1]!.session).toBe(a)
  })

  it('drops a session whose transcript has no settle-ready rounds (OPEN only)', async () => {
    const domain = makeDomain(31337, bankroll)
    const s = new HouseSession({
      domain, tableId: `0x${'cc'.repeat(32)}`, game: dice, player, house,
      seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 8,
      openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
    })
    await s.open() // no rounds
    const settlement = new OptimisticSettlement({
      parties: { player: player.address, house: house.address }, commit: s.chain.commit,
      game: dice, domain, settlementMode: 0, bankroll,
    })
    const open: SettleReadySession = {
      tableId: `0x${'cc'.repeat(32)}`, transcriptJson: s.transcript.toJSON(),
      settlement, trigger: 'player-closeout', observedAt: 0,
    }
    const source = settleReadySource({ provider: async () => [open] })
    const jobs = await source.poll({} as never)
    expect(jobs).toHaveLength(0) // nothing to settle yet
  })
})

import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain } from '@msgboard/games'
import { replaySession } from '../src/replay'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as Hex
const tip = `0x${'77'.repeat(32)}` as Hex
const domain = makeDomain(31337, '0x00000000000000000000000000000000000a3eb1')

async function play(mode: number) {
  const s = new HouseSession({
    domain, tableId, game: dice, player, house, seedTip: tip, chainLength: 8,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: mode,
  })
  await s.open()
  for (let i = 0; i < 4; i++) {
    await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
  }
  return s
}

describe('replaySession', () => {
  it('reconstructs the open + final co-signed states from a retained transcript', async () => {
    const s = await play(0)
    const r = await replaySession(s.transcript.toJSON(), {
      parties: { player: player.address, house: house.address },
      commit: s.chain.commit, game: dice, domain, settlementMode: 0,
    })
    expect(r.open.state.nonce).toBe(0n)
    expect(r.open.state.balancePlayer).toBe(1000n)
    expect(r.final.state.nonce).toBe(4n)
    expect(r.final.state.balancePlayer).toBe(s.state.balancePlayer)
    expect(r.final.state.balanceHouse).toBe(s.state.balanceHouse)
    expect(r.rounds).toBe(4)
  })

  it('rejects a tampered transcript', async () => {
    const s = await play(0)
    const obj = JSON.parse(s.transcript.toJSON())
    const round = obj.entries.find((e: any) => e.kind === 'ROUND')
    round.body.outcome.playerDelta = '999999'
    await expect(replaySession(JSON.stringify(obj), {
      parties: { player: player.address, house: house.address },
      commit: s.chain.commit, game: dice, domain, settlementMode: 0,
    })).rejects.toThrow()
  })

  it('rejects a ctx that disagrees with the signed states (wrong settlementMode / commit)', async () => {
    const s = await play(0)
    const parties = { player: player.address, house: house.address }
    // wrong settlementMode (states were signed with mode 0)
    await expect(replaySession(s.transcript.toJSON(), {
      parties, commit: s.chain.commit, game: dice, domain, settlementMode: 1,
    })).rejects.toThrow()
    // wrong commit
    await expect(replaySession(s.transcript.toJSON(), {
      parties, commit: `0x${'99'.repeat(32)}` as Hex, game: dice, domain, settlementMode: 0,
    })).rejects.toThrow()
  })
})

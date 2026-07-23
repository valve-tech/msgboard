import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain, verifySessionStateSig } from '@msgboard/games'
import { OptimisticSettlement } from '../src/optimistic'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex
const tableId = `0x${'ab'.repeat(32)}` as Hex
const domain = makeDomain(31337, bankroll)

describe('OptimisticSettlement', () => {
  it('builds a settle call whose open/final states + sigs verify off-chain', async () => {
    const s = new HouseSession({
      domain, tableId, game: dice, player, house, seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 8,
      openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
    })
    await s.open()
    for (let i = 0; i < 4; i++) await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })

    const opt = new OptimisticSettlement({
      parties: { player: player.address, house: house.address }, commit: s.chain.commit,
      game: dice, domain, settlementMode: 0, bankroll,
    })
    const tx = await opt.buildSettle(s.transcript.toJSON())
    expect(tx.address).toBe(bankroll)
    expect(tx.functionName).toBe('settle')
    const [openState, finalState, openSigP, openSigH, finalSigP, finalSigH] = tx.args as any[]
    expect(openState.nonce).toBe(0n)
    expect(finalState.nonce).toBe(4n)
    expect(await verifySessionStateSig(player.address, domain, openState, openSigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, openState, openSigH)).toBe(true)
    expect(await verifySessionStateSig(player.address, domain, finalState, finalSigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, finalState, finalSigH)).toBe(true)
  })
})

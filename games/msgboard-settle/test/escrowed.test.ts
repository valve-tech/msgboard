import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, limbo, makeDomain, verifySessionStateSig } from '@msgboard/games'
import { EscrowedSettlement } from '../src/escrowed'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const channel = '0x00000000000000000000000000000000000c4a11' as Hex
const tableId = `0x${'ab'.repeat(32)}` as Hex
const domain = makeDomain(31337, channel)

describe('EscrowedSettlement', () => {
  it('builds a settle call whose final state + sigs verify off-chain', async () => {
    const s = new HouseSession({
      domain, tableId, game: limbo, player, house, seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 8,
      openBalances: { player: 1000n, house: 1000n }, settlementMode: 1,
    })
    await s.open()
    for (let i = 0; i < 3; i++) await s.playRound({ stake: 10n, params: { targetX100: 200n }, clientSeed: `0x${'44'.repeat(32)}` })

    const esc = new EscrowedSettlement({
      parties: { player: player.address, house: house.address }, commit: s.chain.commit,
      game: limbo, domain, settlementMode: 1, channel,
    })
    const tx = await esc.buildSettle(s.transcript.toJSON())
    expect(tx.functionName).toBe('settle')
    const [finalState, sigP, sigH] = tx.args as any[]
    expect(finalState.nonce).toBe(3n)
    expect(await verifySessionStateSig(player.address, domain, finalState, sigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, finalState, sigH)).toBe(true)
  })
})

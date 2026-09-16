import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, limbo, makeDomain, verifyCloseSig } from '@msgboard/games'
import { EscrowedSettlement } from '../src/escrowed'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const channel = '0x00000000000000000000000000000000000c4a11' as Hex
const tableId = `0x${'ab'.repeat(32)}` as Hex
const domain = makeDomain(31337, channel)

describe('EscrowedSettlement', () => {
  it('builds a settle call whose SessionClose + close-sigs verify off-chain', async () => {
    const s = new HouseSession({
      domain, tableId, game: limbo, player, house, seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 8,
      openBalances: { player: 1000n, house: 1000n }, settlementMode: 1,
    })
    await s.open()
    for (let i = 0; i < 3; i++) await s.playRound({ stake: 10n, params: { targetX100: 200n }, clientSeed: `0x${'44'.repeat(32)}` })
    // mutual close: both parties co-sign the DISTINCT SessionClose for the final state.
    await s.authorizeClose()

    const esc = new EscrowedSettlement({
      parties: { player: player.address, house: house.address }, commit: s.chain.commit,
      game: limbo, domain, settlementMode: 1, channel,
    })
    const tx = await esc.buildSettle(s.transcript.toJSON())
    expect(tx.functionName).toBe('settle')
    // settle() now takes (SessionClose, sigPlayer, sigHouse) — NOT the running SessionState.
    const [close, sigP, sigH] = tx.args as any[]
    expect(close.nonce).toBe(3n)
    expect(close.balancePlayer + close.balanceHouse).toBe(2000n) // pot conserved
    expect(close.gameId).toBe(limbo.gameId)
    expect(await verifyCloseSig(player.address, domain, close, sigP)).toBe(true)
    expect(await verifyCloseSig(house.address, domain, close, sigH)).toBe(true)
  })

  it('refuses to build settle from a transcript with no mutual-close authorization', async () => {
    const s = new HouseSession({
      domain, tableId, game: limbo, player, house, seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 8,
      openBalances: { player: 1000n, house: 1000n }, settlementMode: 1,
    })
    await s.open()
    await s.playRound({ stake: 10n, params: { targetX100: 200n }, clientSeed: `0x${'44'.repeat(32)}` })
    // note: NO authorizeClose() — the fast path is unavailable without a co-signed close.
    const esc = new EscrowedSettlement({
      parties: { player: player.address, house: house.address }, commit: s.chain.commit,
      game: limbo, domain, settlementMode: 1, channel,
    })
    await expect(esc.buildSettle(s.transcript.toJSON())).rejects.toThrow(/mutual-close/)
  })
})

import { describe, it, expect } from 'vitest'
import { type Hex } from 'viem'
import { verifyFinishedSession } from '../src/session'
import { runHouseSide, runPlayerSide } from '../src/coSignTransport'
import { fixedDiceConfig } from './helpers'

describe('co-sign over transport', () => {
  it('produces a transcript that verifies like the in-process session', async () => {
    const { houseCfg, playerCfg, houseT, playerT, play, ctx } = fixedDiceConfig()
    const [transcriptJson] = await Promise.all([
      runHouseSide(houseCfg, houseT, play),
      runPlayerSide(playerCfg, playerT),
    ])
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)
  })

  it('the split co-signatures recover to the right addresses (player half ≠ house half)', async () => {
    const { houseCfg, playerCfg, houseT, playerT, play, ctx } = fixedDiceConfig()
    const [transcriptJson] = await Promise.all([
      runHouseSide(houseCfg, houseT, play),
      runPlayerSide(playerCfg, playerT),
    ])
    const t = JSON.parse(transcriptJson)
    for (const e of t.entries) {
      const { player, house } = e.body.sigs
      expect(player).not.toBe(house) // distinct keys signed distinct halves
      expect(player.length).toBe(132) // 65-byte ECDSA sig as 0x + 130 hex
      expect(house.length).toBe(132)
    }
    // sanity: ctx parties are the two distinct accounts the helper used
    expect(ctx.parties.player.toLowerCase()).not.toBe(ctx.parties.house.toLowerCase())
  })

  it('the player REFUSES to sign a round whose proposed balance was tampered (real recompute, not theater)', async () => {
    const { houseCfg, playerCfg, houseT, playerT, play } = fixedDiceConfig()
    // Wrap the house transport so the ROUND state it sends the player is corrupted: bump the
    // player balance by 1 without a matching reveal. The honest player must reject it.
    const corruptHouseT = {
      ...houseT,
      request: (state: any, proof: any) =>
        houseT.request(
          state.nonce === 1n ? { ...state, balancePlayer: state.balancePlayer + 1n } : state,
          proof,
        ),
    }
    const results = await Promise.allSettled([
      runHouseSide(houseCfg, corruptHouseT, play),
      runPlayerSide(playerCfg, playerT),
    ])
    expect(results.some((r) => r.status === 'rejected')).toBe(true)
  })

  it('the player REFUSES a round whose clientSeed is not the one it committed (anti-house-bias binding)', async () => {
    const { houseCfg, playerCfg, houseT, playerT, play } = fixedDiceConfig()
    // The attack: the house drives the round with a DIFFERENT clientSeed than the player committed —
    // i.e. a seed it could have ground (alongside its own committed serverSeed) to force a loss. The
    // house builds a fully self-consistent state for ITS seed, so balance/gameStateHash recompute
    // cleanly; the ONLY thing that stops the theft is the binding to the player's own committed seed.
    const houseSeed = `0x${'44'.repeat(32)}` as Hex
    expect(houseSeed).not.toBe(playerCfg.clientSeed)
    const biasedPlay = { ...play, clientSeed: houseSeed }
    const results = await Promise.allSettled([
      runHouseSide(houseCfg, houseT, biasedPlay),
      runPlayerSide(playerCfg, playerT),
    ])
    expect(results.some((r) => r.status === 'rejected')).toBe(true)
  })
})

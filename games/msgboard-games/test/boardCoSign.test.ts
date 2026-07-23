import { describe, it, expect } from 'vitest'
import { type Hex } from 'viem'
import { LocalTransport } from '../src/transport'
import { MsgBoardTransport, type BoardClient } from '../src/msgboardTransport'
import { makeBoardHouseCoSign, makeBoardPlayerCoSign } from '../src/boardCoSign'
import { runHouseSide, runPlayerSide } from '../src/coSignTransport'
import { verifyFinishedSession } from '../src/session'
import { fixedDiceConfig } from './helpers'

/** In-memory BoardClient: a shared append-only log keyed by category. Both transports built on the
 *  same instance see each other's messages — the real MsgBoardTransport JSON-encode/decode path runs. */
function fakeBoard(): BoardClient {
  const store: Record<string, Array<{ data: Hex }>> = {}
  return {
    addMessage: async ({ category, data }: { category: Hex; data: Hex }) => { (store[category] ??= []).push({ data }); return {} },
    content: async ({ category }: { category?: Hex }) => (category ? { [category]: store[category] ?? [] } : store),
  }
}

describe('board-backed co-sign transport', () => {
  it('carries the split co-sign round-trip over a PUSH transport; transcript verifies', async () => {
    const { houseCfg, playerCfg, play, ctx } = fixedDiceConfig()
    const [houseLink, playerLink] = LocalTransport.pair()
    const houseT = makeBoardHouseCoSign(houseLink)
    const playerT = makeBoardPlayerCoSign(playerLink)

    const [transcriptJson] = await Promise.all([
      runHouseSide(houseCfg, houseT, play),
      runPlayerSide(playerCfg, playerT),
    ])
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)
  })

  it('carries it over a PULL board (real MsgBoardTransport JSON encode) — bigints survive the wire', async () => {
    const { houseCfg, playerCfg, play, ctx } = fixedDiceConfig()
    const board = fakeBoard()
    const houseTransport = new MsgBoardTransport(board, houseCfg.tableId)
    const playerTransport = new MsgBoardTransport(board, houseCfg.tableId) // same table → same category

    const houseT = makeBoardHouseCoSign(houseTransport, { poll: () => houseTransport.poll(), pollMs: 5, timeoutMs: 10_000 })
    const playerT = makeBoardPlayerCoSign(playerTransport, { poll: () => playerTransport.poll(), pollMs: 5 })
    const stop = playerT.startServing()

    const [transcriptJson] = await Promise.all([
      runHouseSide(houseCfg, houseT, play),
      runPlayerSide(playerCfg, playerT),
    ])
    stop()
    // If the bigint codec were wrong, JSON.stringify would have thrown or the revived state would
    // mis-hash and verifyFinishedSession would be false. True ⇒ nonce/balances/stake/params all survived.
    expect(await verifyFinishedSession(transcriptJson, ctx)).toBe(true)
  })

  it('a house-substituted clientSeed makes the player refuse → the house request times out', async () => {
    const { houseCfg, playerCfg, play } = fixedDiceConfig()
    const [houseLink, playerLink] = LocalTransport.pair()
    // short timeout so the refusal surfaces fast instead of the 2-minute default
    const houseT = makeBoardHouseCoSign(houseLink, { timeoutMs: 400 })
    const playerT = makeBoardPlayerCoSign(playerLink)

    const biasedPlay = { ...play, clientSeed: `0x${'44'.repeat(32)}` as Hex } // not the player's committed seed
    const results = await Promise.allSettled([
      runHouseSide(houseCfg, houseT, biasedPlay),
      runPlayerSide(playerCfg, playerT),
    ])
    expect(results.some((r) => r.status === 'rejected')).toBe(true)
  })
})

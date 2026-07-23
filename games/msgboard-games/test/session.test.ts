import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, verifyFinishedSession } from '../src/session'
import { dice } from '../src/games/dice'
import { limbo } from '../src/games/limbo'
import { plinko } from '../src/games/plinko'
import { keno } from '../src/games/keno'
import { TEST_DOMAIN } from '../src/sessionState'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as Hex
const tip = `0x${'77'.repeat(32)}` as Hex

function newSession(game: any, opts: { chainLength?: number; openBalances?: { player: bigint; house: bigint } } = {}) {
  return new HouseSession({
    domain: TEST_DOMAIN, tableId, game,
    player, house, seedTip: tip, chainLength: opts.chainLength ?? 8,
    openBalances: opts.openBalances ?? { player: 1000n, house: 1000n }, settlementMode: 0,
  })
}

const ctxFor = (game: any, commit: Hex) => ({
  parties: { player: player.address, house: house.address },
  commit, game, domain: TEST_DOMAIN,
})

describe('HouseSession', () => {
  it('opens with a both-signed state 0 carrying the seed-chain commit', async () => {
    const s = newSession(dice)
    await s.open()
    expect(s.state.nonce).toBe(0n)
    expect(s.state.rngCommit).toBe(s.chain.commit)
    expect(await s.bothSigned(s.state)).toBe(true)
  })

  it('plays dice rounds, conserves chips, and advances the nonce', async () => {
    const s = newSession(dice)
    await s.open()
    const before = s.state.balancePlayer + s.state.balanceHouse
    for (let i = 0; i < 5; i++) {
      await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
    }
    expect(s.state.nonce).toBe(5n)
    expect(s.state.balancePlayer + s.state.balanceHouse).toBe(before) // conservation
    expect(await s.bothSigned(s.state)).toBe(true)
  })

  it('plays limbo rounds too (same driver, different game)', async () => {
    const s = newSession(limbo)
    await s.open()
    await s.playRound({ stake: 10n, params: { targetX100: 200n }, clientSeed: `0x${'44'.repeat(32)}` })
    expect(s.state.nonce).toBe(1n)
  })

  it('verifies a finished session from the transcript ALONE, including co-signatures (board outage)', async () => {
    const s = newSession(dice)
    await s.open()
    for (let i = 0; i < 3; i++) {
      await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    }
    const ok = await verifyFinishedSession(s.transcript.toJSON(), ctxFor(dice, s.chain.commit))
    expect(ok).toBe(true)
  })

  it('audits non-bigint params from the transcript alone (plinko string+number, keno number[])', async () => {
    // Regression: serializeParams/deserializeParams used to assume every param was a bigint, so
    // plinko (risk: string, rows: number) and keno (picks: number[]) round-tripped wrong and
    // verifyFinishedSession failed even though live play settled fine. Lock the type-aware codec.
    const sp = newSession(plinko)
    await sp.open()
    await sp.playRound({ stake: 10n, params: { rows: 16, risk: 'medium' }, clientSeed: `0x${'66'.repeat(32)}` })
    expect(await verifyFinishedSession(sp.transcript.toJSON(), ctxFor(plinko, sp.chain.commit))).toBe(true)

    const sk = newSession(keno)
    await sk.open()
    await sk.playRound({ stake: 10n, params: { picks: [3, 7, 12, 25] }, clientSeed: `0x${'66'.repeat(32)}` })
    expect(await verifyFinishedSession(sk.transcript.toJSON(), ctxFor(keno, sk.chain.commit))).toBe(true)
  })

  it('rejects a wrong commit (commit cross-check against OPEN body)', async () => {
    const s = newSession(dice)
    await s.open()
    await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    const ok = await verifyFinishedSession(s.transcript.toJSON(), ctxFor(dice, `0x${'00'.repeat(32)}`))
    expect(ok).toBe(false)
  })

  it('a tampered round result fails transcript re-verification', async () => {
    const s = newSession(dice)
    await s.open()
    await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    const obj = JSON.parse(s.transcript.toJSON())
    const round = obj.entries.find((e: any) => e.kind === 'ROUND')
    round.body.outcome.playerDelta = '999999'
    const ok = await verifyFinishedSession(JSON.stringify(obj), ctxFor(dice, s.chain.commit)).catch(() => false)
    expect(ok).toBe(false)
  })

  it('a tampered co-signature fails verification', async () => {
    const s = newSession(dice)
    await s.open()
    await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    const obj = JSON.parse(s.transcript.toJSON())
    const round = obj.entries.find((e: any) => e.kind === 'ROUND')
    round.body.sigs.house = `0x${'00'.repeat(65)}`
    const ok = await verifyFinishedSession(JSON.stringify(obj), ctxFor(dice, s.chain.commit)).catch(() => false)
    expect(ok).toBe(false)
  })

  it('throws when the seed chain is exhausted', async () => {
    const s = newSession(dice, { chainLength: 2 })
    await s.open()
    await s.playRound({ stake: 10n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
    await s.playRound({ stake: 10n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
    await expect(
      s.playRound({ stake: 10n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` }),
    ).rejects.toThrow()
  })

  it('throws on balance underflow regardless of win or loss', async () => {
    // both sides hold 50; a 100 stake underflows the loser (loss -100) or the house (win profit 98)
    const s = newSession(dice, { openBalances: { player: 50n, house: 50n } })
    await s.open()
    await expect(
      s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` }),
    ).rejects.toThrow()
  })
})

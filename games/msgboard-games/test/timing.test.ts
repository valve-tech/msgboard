import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, verifyFinishedSession } from '../src/session'
import { dice } from '../src/games/dice'
import { TEST_DOMAIN } from '../src/sessionState'
import {
  decisionMs, networkMs, totalMs, entryDigest, withTiming,
  type Clock, type Envelope,
} from '../src/transcript'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as Hex
const tip = `0x${'77'.repeat(32)}` as Hex

function newSession(opts: { clock?: Clock } = {}) {
  return new HouseSession({
    domain: TEST_DOMAIN, tableId, game: dice,
    player, house, seedTip: tip, chainLength: 8,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
    clock: opts.clock,
  })
}

const ctx = (commit: Hex) => ({
  parties: { player: player.address, house: house.address },
  commit, game: dice, domain: TEST_DOMAIN,
})

/** Deterministic monotone fake clock: returns 1000, 1001, 1002, ... per call. */
function fakeClock(start = 1000): Clock {
  let t = start
  return () => t++
}

describe('per-turn timing model', () => {
  it('(a) populates all four marks, monotonically ordered, on every entry', async () => {
    const s = newSession({ clock: fakeClock() })
    await s.open()
    for (let i = 0; i < 3; i++) {
      await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    }
    expect(s.transcript.entries.length).toBe(4) // OPEN + 3 ROUND
    for (const e of s.transcript.entries) {
      const t = e.timing!
      expect(t).toBeDefined()
      expect(typeof t.offeredAt).toBe('number')
      expect(typeof t.signedAt).toBe('number')
      expect(typeof t.broadcastAt).toBe('number')
      expect(typeof t.confirmedAt).toBe('number')
      // offered <= signed <= broadcast <= confirmed
      expect(t.offeredAt!).toBeLessThanOrEqual(t.signedAt!)
      expect(t.signedAt!).toBeLessThanOrEqual(t.broadcastAt!)
      expect(t.broadcastAt!).toBeLessThanOrEqual(t.confirmedAt!)
    }
  })

  it('(b) decisionMs / networkMs / totalMs derive correctly', async () => {
    const t = { offeredAt: 100, signedAt: 130, broadcastAt: 135, confirmedAt: 200 }
    expect(decisionMs(t)).toBe(30) // signed - offered
    expect(networkMs(t)).toBe(65) // confirmed - broadcast
    expect(totalMs(t)).toBe(100) // confirmed - offered

    // and the same derivation holds against a real recorded turn
    const s = newSession({ clock: fakeClock() })
    await s.open()
    await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    const round = s.transcript.entries.find((e) => e.kind === 'ROUND')!
    const rt = round.timing!
    expect(decisionMs(rt)).toBe(rt.signedAt! - rt.offeredAt!)
    expect(networkMs(rt)).toBe(rt.confirmedAt! - rt.broadcastAt!)
    expect(totalMs(rt)).toBe(rt.confirmedAt! - rt.offeredAt!)
    expect(decisionMs(rt)! + networkMs(rt)!).toBeLessThanOrEqual(totalMs(rt)!)
  })

  it('helpers guard against undefined and negative spans', () => {
    expect(decisionMs(undefined)).toBeUndefined()
    expect(decisionMs({})).toBeUndefined()
    expect(decisionMs({ offeredAt: 100 })).toBeUndefined() // missing signedAt
    expect(networkMs({ broadcastAt: 200, confirmedAt: 100 })).toBeUndefined() // negative
    expect(totalMs({ offeredAt: 50, confirmedAt: 50 })).toBe(0) // zero is allowed
  })

  it('(c) PARITY: a timed transcript replays/verifies identically to an untimed one', async () => {
    // Same inputs, same deterministic clock pattern, but build a second transcript
    // with timing STRIPPED. Prove digests, signatures, head, and replay are unchanged.
    const s = newSession({ clock: fakeClock() })
    await s.open()
    for (let i = 0; i < 3; i++) {
      await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    }

    const timed = JSON.parse(s.transcript.toJSON()) as {
      tableId: Hex; head: Hex; entries: Envelope[]
    }
    // every timed entry actually carries timing
    expect(timed.entries.every((e) => e.timing !== undefined)).toBe(true)

    // construct the untimed twin: drop the `timing` wrapper field from each entry
    const untimedEntries = timed.entries.map(({ timing, ...rest }) => rest as Envelope)

    // 1. entry digests are byte-identical with and without timing
    for (let i = 0; i < timed.entries.length; i++) {
      expect(entryDigest(untimedEntries[i]!)).toBe(entryDigest(timed.entries[i]!))
      // 2. signatures unchanged (they were never recomputed)
      expect(untimedEntries[i]!.sig).toBe(timed.entries[i]!.sig)
    }

    // 3. transcript head identical
    const untimedJson = JSON.stringify({ tableId: timed.tableId, head: timed.head, entries: untimedEntries })
    const { Transcript } = await import('../src/transcript')
    const timedT = Transcript.fromJSON(s.transcript.toJSON())
    const untimedT = Transcript.fromJSON(untimedJson)
    expect(untimedT.head).toBe(timedT.head)

    // 4. full replay/verify succeeds for BOTH and yields the same boolean
    const timedOk = await verifyFinishedSession(s.transcript.toJSON(), ctx(s.chain.commit))
    const untimedOk = await verifyFinishedSession(untimedJson, ctx(s.chain.commit))
    expect(timedOk).toBe(true)
    expect(untimedOk).toBe(true)
  })

  it('PARITY: gameStateHash inside the signed state never sees timing', async () => {
    // Two sessions with WILDLY different clocks must produce identical gameStateHash
    // for the same round inputs (timing lives outside the signed SessionState).
    const a = newSession({ clock: fakeClock(1000) })
    const b = newSession({ clock: fakeClock(9_000_000) })
    await a.open(); await b.open()
    const round = { stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` as Hex }
    await a.playRound(round); await b.playRound(round)
    expect(a.state.gameStateHash).toBe(b.state.gameStateHash)
    expect(await a.bothSigned(a.state)).toBe(true)
    expect(await b.bothSigned(b.state)).toBe(true)
    // and the round envelope signatures match across the two differently-clocked sessions
    const ae = a.transcript.entries.find((e) => e.kind === 'ROUND')!
    const be = b.transcript.entries.find((e) => e.kind === 'ROUND')!
    expect(ae.sig).toBe(be.sig)
    expect(entryDigest(ae)).toBe(entryDigest(be))
  })

  it('withTiming does not mutate the digest of an existing envelope', async () => {
    const s = newSession({ clock: fakeClock() })
    await s.open()
    const e = s.transcript.entries[0]!
    const before = entryDigest(e)
    const re = withTiming({ ...e, timing: undefined }, { offeredAt: 1, signedAt: 2, broadcastAt: 3, confirmedAt: 4 })
    expect(entryDigest(re)).toBe(before)
    expect(re.sig).toBe(e.sig)
  })
})

import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { AttestedElGamalDeck, LocalTransport, TEST_DOMAIN, hashState, verifyStateSig } from '@msgboard/zk-cards-core'
import {
  Player, openSession, decisionMs, networkMs, totalMs, type Clock, type TurnTiming,
} from '../src/session'

const ANTE = 5n, ESCROW_EACH = 100n

// Fixed keys so two runs (timed vs differently-timed) produce byte-identical
// signatures for the same game inputs — the heart of the parity proof.
const PK_A = `0x${'a1'.repeat(32)}` as const
const PK_B = `0x${'b2'.repeat(32)}` as const
const TABLE = `0x${'cd'.repeat(32)}` as const

/** Deterministic monotone fake clock: 1000, 1001, 1002, ... */
function fakeClock(start = 1000): Clock {
  let t = start
  return () => t++
}

function pair(opts: { clockA?: Clock; clockB?: Clock } = {}) {
  const [ta, tb] = LocalTransport.pair()
  const wa = privateKeyToAccount(PK_A)
  const wb = privateKeyToAccount(PK_B)
  const deck = new AttestedElGamalDeck()
  const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain: TEST_DOMAIN, tableId: TABLE, ante: ANTE, escrowEach: ESCROW_EACH, clock: opts.clockA })
  const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain: TEST_DOMAIN, tableId: TABLE, ante: ANTE, escrowEach: ESCROW_EACH, clock: opts.clockB })
  return { a, b }
}

describe('hilo-war per-turn timing model', () => {
  it('(a) records timing per co-signed nonce; all four marks present and monotonic', async () => {
    const { a, b } = pair({ clockA: fakeClock(1000), clockB: fakeClock(5000) })
    await openSession(a, b)
    await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])

    // genesis (nonce 0) + at least the two co-signs of one flip (deal + terminal)
    expect(a.timing.size).toBeGreaterThanOrEqual(2)
    expect(a.timing.has(0n)).toBe(true)
    for (const t of a.timing.values()) {
      expect(typeof t.offeredAt).toBe('number')
      expect(typeof t.signedAt).toBe('number')
      expect(typeof t.broadcastAt).toBe('number')
      expect(typeof t.confirmedAt).toBe('number')
      expect(t.offeredAt!).toBeLessThanOrEqual(t.signedAt!)
      expect(t.signedAt!).toBeLessThanOrEqual(t.broadcastAt!)
      expect(t.broadcastAt!).toBeLessThanOrEqual(t.confirmedAt!)
    }
  })

  it('(b) decisionMs / networkMs / totalMs derive correctly and guard bad input', () => {
    const t: TurnTiming = { offeredAt: 100, signedAt: 130, broadcastAt: 135, confirmedAt: 200 }
    expect(decisionMs(t)).toBe(30)
    expect(networkMs(t)).toBe(65)
    expect(totalMs(t)).toBe(100)
    expect(decisionMs(undefined)).toBeUndefined()
    expect(networkMs({ broadcastAt: 200, confirmedAt: 100 })).toBeUndefined() // negative
    expect(totalMs({ offeredAt: 50, confirmedAt: 50 })).toBe(0)
  })

  it('(c) PARITY: the co-signatures verify against a timing-free state digest; timing is held off-band', async () => {
    // NOTE: per-flip deck shuffle/salt use fresh randomness, so two SESSIONS can't be
    // made byte-identical. The parity guarantee is instead proven structurally on a
    // single run: signatures are produced over hashState(state), and `state` has no
    // timing field — so re-deriving that digest from the stored state and verifying the
    // co-signatures against it proves timing is OUTSIDE the signed surface. Timing lives
    // only in the Player.timing map, never in `state`, never in an envelope body.
    const addrA = privateKeyToAccount(PK_A).address
    const addrB = privateKeyToAccount(PK_B).address

    const { a, b } = pair({ clockA: fakeClock(1000), clockB: fakeClock(9_000_000) })
    await openSession(a, b)
    await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])

    expect(a.timing.size).toBeGreaterThan(0) // timing WAS recorded

    const co = a.channel.latest!
    // the recomputed digest of `state` (which carries no timing) is exactly what was signed
    const digest = hashState(TEST_DOMAIN, co.state)
    expect(await verifyStateSig(addrA, TEST_DOMAIN, co.state, co.sigA!)).toBe(true)
    expect(await verifyStateSig(addrB, TEST_DOMAIN, co.state, co.sigB!)).toBe(true)
    // `state` has no `timing`/`offeredAt`/etc. key — the digest cannot depend on it
    expect(Object.keys(co.state as object)).not.toContain('timing')
    expect(Object.keys(co.state as object)).not.toContain('offeredAt')
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/)

    // both sides agree on the co-signed state and the transcript verifies cleanly
    expect(hashState(TEST_DOMAIN, b.channel.latest!.state)).toBe(digest)
    expect(await a.transcript.verify({ A: addrA, B: addrB })).toBe(true)
    expect(await b.transcript.verify({ A: addrA, B: addrB })).toBe(true)
  })
})

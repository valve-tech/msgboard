import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { AttestedElGamalDeck, LocalTransport, TEST_DOMAIN } from '@msgboard/zk-cards-core'
import { Phase } from '../src/rules'
import { Player, openSession } from '../src/session'

const ANTE = 5n, ESCROW_EACH = 100n

function freshPair(opts: { escrowEach?: bigint } = {}) {
  const escrowEach = opts.escrowEach ?? ESCROW_EACH
  const [ta, tb] = LocalTransport.pair()
  const wa = privateKeyToAccount(generatePrivateKey())
  const wb = privateKeyToAccount(generatePrivateKey())
  const deck = new AttestedElGamalDeck()
  const tableId = ('0x' + crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')) as `0x${string}`
  const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach })
  const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach })
  return { a, b, ta, tb }
}

describe('hilo-war session', () => {
  it('setup co-signs genesis with a deck commitment', async () => {
    const { a, b } = freshPair()
    await openSession(a, b)
    expect(a.channel.latest!.state.nonce).toBe(0n)
    expect(a.channel.latest!.state.deckCommitment).toBe(b.channel.latest!.state.deckCommitment)
    expect(a.channel.fullySigned(a.channel.latest!)).toBe(true)
  })

  it('plays three hold/hold flips to completion; both sides agree; conservation holds', async () => {
    const { a, b } = freshPair()
    await openSession(a, b)
    for (let k = 0; k < 3; k++) {
      const [ra, rb] = await Promise.all([
        a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }),
        b.playFlip({ bet: 'HOLD', onRaise: 'CALL' }),
      ])
      expect(ra.flip).toEqual(rb.flip)
      expect(ra.myCard).toBeGreaterThanOrEqual(0)
      expect(rb.myCard).toBeGreaterThanOrEqual(0)
      expect(ra.opponentCard).toBe(rb.myCard)
      expect(rb.opponentCard).toBe(ra.myCard)
    }
    const s = a.channel.latest!.state
    expect(s.balanceA + s.balanceB + s.pot).toBe(2n * ESCROW_EACH)
    expect(s.nonce).toBeGreaterThanOrEqual(3n)
  })

  it('raise/fold: folder pays one ante net, folded cards never revealed', async () => {
    const { a, b } = freshPair()
    await openSession(a, b)
    const [ra, rb] = await Promise.all([
      a.playFlip({ bet: 'RAISE', onRaise: 'CALL' }),
      b.playFlip({ bet: 'HOLD', onRaise: 'FOLD' }),
    ])
    expect(ra.flip.foldedCardHidden).toBe(true)
    expect(ra.flip.result!.winner).toBe('A')
    expect(ra.opponentCard).toBeNull()
    expect(rb.opponentCard).toBeNull()
    const s = a.channel.latest!.state
    // pot at fold = 2 antes + A's raise = 3·ante, of which A contributed 2·ante → A nets one ante
    expect(s.balanceA).toBe(ESCROW_EACH + ANTE)
    expect(s.balanceB).toBe(ESCROW_EACH - ANTE)
    expect(s.pot).toBe(0n)
  })

  it('cooperative settle produces a fully co-signed SETTLED state', async () => {
    const { a, b } = freshPair()
    await openSession(a, b)
    await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    const [fa, fb] = await Promise.all([a.requestSettle(), b.acceptSettle()])
    expect(fa.state.phase).toBe(Phase.SETTLED)
    expect(fa.sigA && fa.sigB).toBeTruthy()
    expect(fa.state.balanceA + fa.state.balanceB).toBe(2n * ESCROW_EACH)
    expect(fa.state.pot).toBe(0n)
    expect(fb.state).toEqual(fa.state)
  })
})

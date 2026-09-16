import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import type { Hex } from 'viem'
import { AttestedElGamalDeck, type WireMasked } from '@msgboard/zk-cards-core'
import { jointKey, runShuffleChain } from '../src/deckN'
import { dealPlan, deckCommitment } from '../src/dealSeq'
import { collectShares, ctxFor, type RevealShare } from '../src/revealN'
import { verifyDealBinding } from '../src/dealBindingN'

// ---- helpers (mirrors dealSeq.test.ts / showdownReveal.test.ts) -----------

const mkSeat = async (p: AttestedElGamalDeck) => {
  const k = await p.keygen()
  const acct = privateKeyToAccount(generatePrivateKey())
  return { ...k, addr: acct.address, signer: acct }
}

const randTableId = (): Hex =>
  ('0x' +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as Hex

async function setupHonest(n: number) {
  const p = new AttestedElGamalDeck()
  const seats = await Promise.all(Array.from({ length: n }, () => mkSeat(p)))
  const agg = jointKey(p, seats.map((s) => s.pub))
  const tableId = randTableId()
  const { finalDeck } = await runShuffleChain(p, agg, seats)
  return { p, seats, tableId, finalDeck }
}

/** Collect all N seats' shares for every dealt slot (community + every seat's own hole) — the
 *  full-visibility view a neutral relay/watchtower (or a test harness with every secret) has. */
async function fullDealtShares(
  p: AttestedElGamalDeck,
  seats: { secret: Hex; pub: Hex }[],
  deck: WireMasked[],
  tableId: Hex,
  slots: number[],
): Promise<Record<number, RevealShare[]>> {
  const out: Record<number, RevealShare[]> = {}
  for (const slot of slots) {
    out[slot] = await collectShares(p, seats, deck, slot, tableId)
  }
  return out
}

// ---- tests ------------------------------------------------------------------

describe('verifyDealBinding (secp256k1 — HoldemTableN C3)', () => {
  it('ACCEPTS an honest deal', async () => {
    const n = 3
    const { p, seats, tableId, finalDeck } = await setupHonest(n)
    const plan = dealPlan(n)
    const dealtSlots = [...plan.holeSlots.flat(), ...plan.flop, plan.turn, plan.river]
    const dealtShares = await fullDealtShares(p, seats, finalDeck, tableId, dealtSlots)

    const result = await verifyDealBinding({
      provider: p,
      tableId,
      registeredKeys: seats.map((s) => s.pub),
      deck: finalDeck,
      deckCommitment: deckCommitment(finalDeck),
      dealtShares,
    })
    expect(result).toEqual({ ok: true })
  })

  it('REJECTS a decoy deck masked under a wrong aggregate (check a)', async () => {
    const p = new AttestedElGamalDeck()
    const a = await mkSeat(p)
    const b = await mkSeat(p)
    const evil = await mkSeat(p)
    const registeredKeys = [a.pub, b.pub]
    // The deck is actually masked under agg(a, evil) — NOT agg(a, b), the registered pair.
    const decoyAgg = jointKey(p, [a.pub, evil.pub])
    const tableId = randTableId()
    const { finalDeck } = await runShuffleChain(p, decoyAgg, [a, evil])

    const slot = 0
    const ctx = ctxFor(tableId, slot)
    // Shares are honestly produced by the REGISTERED seats (a, b) over their OWN real secrets —
    // attribution (check c) passes on its own terms; only decode (check a) can catch this,
    // because b's secret was never actually used to mask the deck.
    const shares: RevealShare[] = [
      { from: a.pub, share: await p.share(a.secret, finalDeck[slot]!, ctx) },
      { from: b.pub, share: await p.share(b.secret, finalDeck[slot]!, ctx) },
    ]

    const result = await verifyDealBinding({
      provider: p,
      tableId,
      registeredKeys,
      deck: finalDeck,
      deckCommitment: deckCommitment(finalDeck),
      dealtShares: { [slot]: shares },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/decode failed/)
  })

  it('REJECTS a duplicate-card deck (check b)', async () => {
    const n = 2
    const { p, seats, tableId, finalDeck } = await setupHonest(n)
    const tampered: WireMasked[] = [...finalDeck]
    tampered[1] = tampered[0]! // a shuffler-style duplicated ciphertext across two dealt slots

    const dealtShares = await fullDealtShares(p, seats, tampered, tableId, [0, 1])
    const result = await verifyDealBinding({
      provider: p,
      tableId,
      registeredKeys: seats.map((s) => s.pub),
      deck: tampered,
      deckCommitment: deckCommitment(tampered),
      dealtShares,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/both revealed card/)
  })

  it('REJECTS a forged/misattributed share (check c)', async () => {
    const n = 2
    const { p, seats, tableId, finalDeck } = await setupHonest(n)
    const slot = 0
    const ctx = ctxFor(tableId, slot)
    const evil = await mkSeat(p)
    // A share genuinely produced by `evil`'s secret, falsely claimed to be from seats[1].
    const forged: RevealShare = { from: seats[1]!.pub, share: await p.share(evil.secret, finalDeck[slot]!, ctx) }
    const honestOwn: RevealShare = { from: seats[0]!.pub, share: await p.share(seats[0]!.secret, finalDeck[slot]!, ctx) }

    const result = await verifyDealBinding({
      provider: p,
      tableId,
      registeredKeys: seats.map((s) => s.pub),
      deck: finalDeck,
      deckCommitment: deckCommitment(finalDeck),
      dealtShares: { [slot]: [honestOwn, forged] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/attribution failed/)
  })

  it('rejects when the deck does not hash to the claimed commitment', async () => {
    const n = 2
    const { p, seats, tableId, finalDeck } = await setupHonest(n)
    const dealtShares = await fullDealtShares(p, seats, finalDeck, tableId, [0])
    const result = await verifyDealBinding({
      provider: p,
      tableId,
      registeredKeys: seats.map((s) => s.pub),
      deck: finalDeck,
      deckCommitment: `0x${'ab'.repeat(32)}` as Hex,
      dealtShares,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/deckCommitment mismatch/)
  })

  it('rejects an empty dealtShares map', async () => {
    const n = 2
    const { p, seats, tableId, finalDeck } = await setupHonest(n)
    const result = await verifyDealBinding({
      provider: p,
      tableId,
      registeredKeys: seats.map((s) => s.pub),
      deck: finalDeck,
      deckCommitment: deckCommitment(finalDeck),
      dealtShares: {},
    })
    expect(result.ok).toBe(false)
  })
})

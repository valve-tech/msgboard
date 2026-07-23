import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { AttestedElGamalDeck } from '../src/attestedDeck'

const walletA = privateKeyToAccount(generatePrivateKey())
const walletB = privateKeyToAccount(generatePrivateKey())

describe('AttestedElGamalDeck', () => {
  const deck = new AttestedElGamalDeck()

  it('full two-party flow: keygen → mask → A shuffles → B shuffles → deal', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    expect(d0).toHaveLength(52)

    const s1 = await deck.shuffle(agg, d0, walletA)
    expect(await deck.verifyShuffle(agg, d0, s1, walletA.address)).toBe(true)
    const s2 = await deck.shuffle(agg, s1.deck, walletB)
    expect(await deck.verifyShuffle(agg, s1.deck, s2, walletB.address)).toBe(true)

    const ctx = 'test-table/slot-0'
    const shA = await deck.share(a.secret, s2.deck[0]!, ctx)
    const shB = await deck.share(b.secret, s2.deck[0]!, ctx)
    expect(await deck.verifyShare(a.pub, s2.deck[0]!, shA, ctx)).toBe(true)
    expect(await deck.verifyShare(b.pub, s2.deck[0]!, shB, ctx)).toBe(true)
    const card = deck.unmask(s2.deck[0]!, [shA, shB])
    expect(card).toBeGreaterThanOrEqual(0)
    expect(card).toBeLessThan(52)
  })

  it('double shuffle is a permutation: unmasking all 52 yields all 52 cards', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const s1 = await deck.shuffle(agg, await deck.initialDeck(agg), walletA)
    const s2 = await deck.shuffle(agg, s1.deck, walletB)
    const seen = new Set<number>()
    for (let i = 0; i < 52; i++) {
      const ctx = `t/slot-${i}`
      const cards = deck.unmask(s2.deck[i]!, [
        await deck.share(a.secret, s2.deck[i]!, ctx),
        await deck.share(b.secret, s2.deck[i]!, ctx),
      ])
      seen.add(cards)
    }
    expect(seen.size).toBe(52)
  })

  it('rejects a tampered shuffle (card substituted after signing)', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const s1 = await deck.shuffle(agg, d0, walletA)
    const tampered = { ...s1, deck: [...s1.deck] }
    tampered.deck[5] = d0[5]! // swap a card back
    expect(await deck.verifyShuffle(agg, d0, tampered, walletA.address)).toBe(false)
  })

  it('rejects a shuffle signed by the wrong party', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const s1 = await deck.shuffle(agg, d0, walletA)
    expect(await deck.verifyShuffle(agg, d0, s1, walletB.address)).toBe(false)
  })

  it('rejects a bad share and unmask explodes on garbage', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const evil = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const bad = await deck.share(evil.secret, d0[0]!, 'ctx')
    expect(await deck.verifyShare(a.pub, d0[0]!, bad, 'ctx')).toBe(false)
    const good = await deck.share(a.secret, d0[0]!, 'ctx')
    expect(await deck.verifyShare(a.pub, d0[0]!, good, 'wrong-ctx')).toBe(false)
    expect(() => deck.unmask(d0[0]!, [good, bad])).toThrow(/not a card point/)
  })
})

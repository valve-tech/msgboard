// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review.
//
// Lifecycle test for the Baby-JubJub ZypherDeckProvider (P6.3), exercised through the same
// MaskedDeckProvider seam as AttestedElGamalDeck. Real ZK shuffle: each shuffle is a genuine
// uzkge proof (verified off-chain by verify_shuffled_cards), so the suite is SLOW — the one-time
// init_prover_key(52) is ~11s and each shuffle_cards is ~10s. Timeouts are generous accordingly.
import { describe, it, expect } from 'vitest'
import type { Hex } from 'viem'
import { ZypherDeckProvider } from '../src/zypherDeck'

// A no-op signer: the Zypher shuffle proof is a SNARK, not a signature (the seam's ShuffleSigner
// is unused by this provider, kept only for interface parity).
const noopSigner = {
  address: '0x0000000000000000000000000000000000000000' as Hex,
  async signMessage() {
    return '0x' as Hex
  },
}

describe('ZypherDeckProvider (Baby-JubJub real ZK shuffle)', () => {
  const deck = new ZypherDeckProvider()

  it('full two-party flow: keygen → mask → A shuffles (ZK) → verify → reveal → deal', async () => {
    const a = await deck.keygen()
    const b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])

    const d0 = await deck.initialDeck(agg)
    expect(d0).toHaveLength(52)

    const s1 = await deck.shuffle(agg, d0, noopSigner)
    expect(s1.deck).toHaveLength(52)
    // The real shuffle argument must verify off-chain.
    expect(await deck.verifyShuffle(agg, d0, s1, noopSigner.address)).toBe(true)
    // refresh_joint_key produced the 24-word on-chain pkc.
    expect(deck.lastPkc).toHaveLength(24)

    const card0 = s1.deck[0]!
    const shA = await deck.share(a.secret, card0, 'table/slot-0')
    const shB = await deck.share(b.secret, card0, 'table/slot-0')
    // Each reveal proof verifies against its revealer's deck pubkey.
    expect(await deck.verifyShare(a.pub, card0, shA, 'table/slot-0')).toBe(true)
    expect(await deck.verifyShare(b.pub, card0, shB, 'table/slot-0')).toBe(true)

    const idx = deck.unmask(card0, [shA, shB])
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(idx).toBeLessThan(52)
  }, 120_000)

  it('shuffle is a true permutation: unmasking all 52 yields all 52 distinct cards', async () => {
    const a = await deck.keygen()
    const b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const s1 = await deck.shuffle(agg, d0, noopSigner)

    const seen = new Set<number>()
    for (let i = 0; i < 52; i++) {
      const c = s1.deck[i]!
      const shA = await deck.share(a.secret, c, `t/slot-${i}`)
      const shB = await deck.share(b.secret, c, `t/slot-${i}`)
      seen.add(deck.unmask(c, [shA, shB]))
    }
    expect(seen.size).toBe(52)
  }, 120_000)

  it('rejects a tampered shuffle (card substituted after proving)', async () => {
    const a = await deck.keygen()
    const b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const s1 = await deck.shuffle(agg, d0, noopSigner)
    const tampered = { ...s1, deck: [...s1.deck] }
    tampered.deck[5] = d0[5]! // swap an original card back in
    expect(await deck.verifyShuffle(agg, d0, tampered, noopSigner.address)).toBe(false)
  }, 120_000)

  it('rejects a reveal from the wrong key', async () => {
    const a = await deck.keygen()
    const b = await deck.keygen()
    const evil = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const c = d0[0]!
    const bad = await deck.share(evil.secret, c, 'ctx')
    // The reveal proof is bound to evil's pk, so checking it against a.pub must fail.
    expect(await deck.verifyShare(a.pub, c, bad, 'ctx')).toBe(false)
  }, 120_000)
})

// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review (same posture as
// zypherDeck.test.ts: real WASM shuffles, so this suite is SLOW).
//
// Tests the off-chain half of deckkey-binding-spec.md §B2/§B3: the transcript builder
// (`buildDealBinding`) and the validate-before-sign guard (`verifyDealBinding`) that a client
// MUST run before co-signing a DEAL. Every negative test is constructed so it isolates exactly
// ONE of `verifyDealBinding`'s checks (a)-(e) — see the comment on each test for which.
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hex } from 'viem'
import { ZypherDeckProvider } from '../src/zypherDeck'
import {
  buildDealBinding, verifyDealBinding, hashDeck, computeShuffleRoot, computeJointKeyCommit,
  type Step, type ShuffleRound,
} from '../src/deckBinding'
import type { WireMasked } from '../src/maskedDeck'

// The Zypher shuffle proof is a SNARK, not a signature; ShuffleSigner is unused by this
// provider (kept only for MaskedDeckProvider interface parity) — mirrors zypherDeck.test.ts.
const noopSigner = {
  address: '0x0000000000000000000000000000000000000000' as Hex,
  async signMessage() {
    return '0x' as Hex
  },
}

describe('deckBinding (Baby-JubJub deck-key binding — real ZK shuffle)', () => {
  const deck = new ZypherDeckProvider()

  let a: { secret: Hex; pub: Hex }
  let b: { secret: Hex; pub: Hex }
  let evil: { secret: Hex; pub: Hex }
  let registeredKeys: Hex[]
  let honestAgg: Hex
  let honestRounds: ShuffleRound[]
  let honestBinding: ReturnType<typeof buildDealBinding>
  let honestDeckCommitment: Hex

  beforeAll(async () => {
    a = await deck.keygen()
    b = await deck.keygen()
    evil = await deck.keygen()
    registeredKeys = [a.pub, b.pub]
    honestAgg = deck.aggregate(registeredKeys)

    const d0 = await deck.initialDeck(honestAgg)
    const r1 = await deck.shuffle(honestAgg, d0, noopSigner) // seat 1 (A) shuffles
    const r2 = await deck.shuffle(honestAgg, r1.deck, noopSigner) // seat 2 (B) shuffles seat 1's output
    honestRounds = [
      { authorSeat: 1, before: d0, after: r1 },
      { authorSeat: 2, before: r1.deck, after: r2 },
    ]
    honestBinding = buildDealBinding(honestAgg, honestRounds)
    honestDeckCommitment = hashDeck(r2.deck)
  }, 180_000)

  it('ACCEPTS an honest deal', async () => {
    const result = await verifyDealBinding({
      provider: deck,
      registeredKeys,
      jointKeyCommit: honestBinding.jointKeyCommit,
      shuffleRoot: honestBinding.shuffleRoot,
      deckCommitment: honestDeckCommitment,
      rounds: honestRounds,
    })
    expect(result).toEqual({ ok: true })
  }, 60_000)

  it('REJECTS a decoy deck masked under a wrong aggregate (check a: jointKeyCommit)', async () => {
    // A fully self-consistent decoy transcript: real shuffles, real proofs, real jointKeyCommit —
    // just built against a DIFFERENT (colluding) aggregate than the table's actual registered
    // keys. Every hash-chain/shuffleRoot check on the decoy transcript passes on its own terms;
    // only comparing its jointKeyCommit against Σ registered keys catches it.
    const decoyAgg = deck.aggregate([a.pub, evil.pub])
    const decoyD0 = await deck.initialDeck(decoyAgg)
    const dr1 = await deck.shuffle(decoyAgg, decoyD0, noopSigner)
    const dr2 = await deck.shuffle(decoyAgg, dr1.deck, noopSigner)
    const decoyRounds: ShuffleRound[] = [
      { authorSeat: 1, before: decoyD0, after: dr1 },
      { authorSeat: 2, before: dr1.deck, after: dr2 },
    ]
    const decoyBinding = buildDealBinding(decoyAgg, decoyRounds)

    const result = await verifyDealBinding({
      provider: deck,
      registeredKeys, // the REAL [a, b] keys — decoyAgg used [a, evil]
      jointKeyCommit: decoyBinding.jointKeyCommit,
      shuffleRoot: decoyBinding.shuffleRoot,
      deckCommitment: hashDeck(dr2.deck),
      rounds: decoyRounds,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/jointKeyCommit/)
  }, 180_000)

  it('REJECTS a bad pkc / tampered jointKeyCommit (check a)', async () => {
    const result = await verifyDealBinding({
      provider: deck,
      registeredKeys,
      jointKeyCommit: `0x${'ab'.repeat(32)}` as Hex, // garbage — matches no real (agg, pkc)
      shuffleRoot: honestBinding.shuffleRoot,
      deckCommitment: honestDeckCommitment,
      rounds: honestRounds,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/jointKeyCommit/)
  }, 30_000)

  it('REJECTS a poisoned canonical head / D0 (check b)', async () => {
    // Swap step 0's `before` for an unrelated-but-validly-shaped deck (the final post-shuffle
    // deck) while leaving everything else — including the chain link into step 1 and the tail
    // into deckCommitment — intact. Only the independent D0 recomputation catches this: the
    // attacker's own re-derived jointKeyCommit/shuffleRoot are self-consistent with the poisoned
    // rounds, so (a), (c), (d) all pass on their own terms.
    const poisonedRounds: ShuffleRound[] = [
      { ...honestRounds[0]!, before: honestRounds[1]!.after.deck },
      honestRounds[1]!,
    ]
    const poisonedBinding = buildDealBinding(honestAgg, poisonedRounds)
    const result = await verifyDealBinding({
      provider: deck,
      registeredKeys,
      jointKeyCommit: poisonedBinding.jointKeyCommit,
      shuffleRoot: poisonedBinding.shuffleRoot,
      deckCommitment: honestDeckCommitment,
      rounds: poisonedRounds,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/canonical head|D0/i)
  }, 30_000)

  it('REJECTS a reattributed/substituted step (check d: shuffleRoot)', async () => {
    // Relabel step 0's authorSeat (1 -> 2) — a framing attempt (C2 in the spec). The deck bytes
    // are untouched, so every hash-chain/D0/tail check still passes; only the shuffleRoot, which
    // commits authorSeat, catches the reattribution when compared against the ORIGINAL committed
    // root (as would be pinned in the co-signed ChannelState at DEAL time).
    const tamperedRounds: ShuffleRound[] = [{ ...honestRounds[0]!, authorSeat: 2 }, honestRounds[1]!]
    const result = await verifyDealBinding({
      provider: deck,
      registeredKeys,
      jointKeyCommit: honestBinding.jointKeyCommit,
      shuffleRoot: honestBinding.shuffleRoot, // the ORIGINAL root — does not match the relabeled steps
      deckCommitment: honestDeckCommitment,
      rounds: tamperedRounds,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/shuffleRoot/)
  }, 30_000)

  it('REJECTS a hash-consistent but cryptographically-invalid transcript (check e: verify52)', async () => {
    // A fully self-consistent (all hashes line up) but CRYPTOGRAPHICALLY BOGUS transcript: the
    // "after" deck is arbitrary non-shuffle bytes with a garbage proof. Every bookkeeping check
    // (a)-(d) passes because the attacker computed jointKeyCommit/shuffleRoot over exactly this
    // data; only running verify52 for real catches that no genuine shuffle argument backs it.
    const d0 = await deck.initialDeck(honestAgg)
    const fakeAfter: WireMasked[] = Array.from({ length: 52 }, (_, i) => ({
      c1: `0x${(1000 + i * 2).toString(16).padStart(128, '0')}` as Hex,
      c2: `0x${(1001 + i * 2).toString(16).padStart(128, '0')}` as Hex,
    }))
    const garbageRounds: ShuffleRound[] = [
      { authorSeat: 1, before: d0, after: { deck: fakeAfter, proof: `0x${'00'.repeat(64)}` } },
    ]
    const binding = buildDealBinding(honestAgg, garbageRounds)
    const result = await verifyDealBinding({
      provider: deck,
      registeredKeys,
      jointKeyCommit: binding.jointKeyCommit,
      shuffleRoot: binding.shuffleRoot,
      deckCommitment: hashDeck(fakeAfter),
      rounds: garbageRounds,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/verify52/)
  }, 60_000)

  it('rejects an empty transcript', async () => {
    const result = await verifyDealBinding({
      provider: deck,
      registeredKeys,
      jointKeyCommit: honestBinding.jointKeyCommit,
      shuffleRoot: honestBinding.shuffleRoot,
      deckCommitment: honestDeckCommitment,
      rounds: [],
    })
    expect(result.ok).toBe(false)
  })

  // ── encoding pins (wave2-contract-blueprint.md §8) ──────────────────────────────────────────
  // These fixtures use FIXED, hand-computable inputs (not live WASM output) so the exact bytes
  // can be pinned here and cross-checked against a future Solidity-side parity test. The expected
  // values below were independently cross-checked by hand-building the ABI preimage byte-for-byte
  // (uint256/uint256/uint256[24] as 26 concatenated static words with no offset; a Step[] as
  // offset+length+4-static-words-per-tuple) and keccak256-ing that — see the deckBinding.ts
  // module header for the encoding rationale.
  it('encoding fixture: jointKeyCommit(aggX=1, aggY=2, pkc=[3..26]) is pinned byte-for-byte', () => {
    const pkc = Array.from({ length: 24 }, (_, i) => BigInt(i + 3))
    expect(computeJointKeyCommit(1n, 2n, pkc)).toBe(
      '0x4d055a87f1e16beec6692ef6253775ce5c5f3d92463cdb38b056c11f56c520d5',
    )
  })

  it('encoding fixture: shuffleRoot over a fixed 2-step transcript is pinned byte-for-byte', () => {
    const steps: Step[] = [
      { authorSeat: 1, beforeHash: `0x${'11'.repeat(32)}` as Hex, afterHash: `0x${'22'.repeat(32)}` as Hex, proofHash: `0x${'33'.repeat(32)}` as Hex },
      { authorSeat: 2, beforeHash: `0x${'22'.repeat(32)}` as Hex, afterHash: `0x${'44'.repeat(32)}` as Hex, proofHash: `0x${'55'.repeat(32)}` as Hex },
    ]
    expect(computeShuffleRoot(steps)).toBe(
      '0x678cdad02d5b00f93b0eb6f3b73618f9c3ce0a01140771413550850fc1a23e7a',
    )
  })
})

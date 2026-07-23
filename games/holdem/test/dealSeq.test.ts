import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { keccak256, concatHex, type Hex } from 'viem'
import { AttestedElGamalDeck, Transcript, verifyEnvelope } from '@msgboard/zk-cards-core'
import { jointKey, runShuffleChain, verifyShuffleChain } from '../src/deckN'
import { collectShares, revealCommunity, revealHole, ctxFor } from '../src/revealN'
import {
  dealPlan,
  deckCommitment,
  DuplicateCardFault,
  postStep,
  runDeal,
  ShareAttributionFault,
  type DealStep,
} from '../src/dealSeq'

// ---- helpers ---------------------------------------------------------------

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

/**
 * A fake/in-memory board that the deal sequencer posts each step to. It exposes
 * exactly the surface the sequencer needs (append-an-envelope), counts the posts,
 * and records that a "PoW stamp" was minted for each post (the live board would
 * grind ~1-2s here; the fake just records it). This is the dealSeq analogue of the
 * fake-transport pattern the other game tests use — NO live RPC.
 */
function fakeBoard(tableId: Hex) {
  const transcript = new Transcript(tableId)
  let stamps = 0
  return {
    transcript,
    get posts() {
      return transcript.entries.length
    },
    get stamps() {
      return stamps
    },
    stamp() {
      stamps++
    },
  }
}

async function setupTable(n: number) {
  const p = new AttestedElGamalDeck()
  const seats = await Promise.all(Array.from({ length: n }, () => mkSeat(p)))
  const agg = jointKey(p, seats.map((s) => s.pub))
  const tableId = randTableId()
  const { initial, finalDeck, rounds } = await runShuffleChain(p, agg, seats)
  return { p, seats, agg, tableId, initial, finalDeck, rounds }
}

// ---- tests -----------------------------------------------------------------

describe('dealPlan — slot layout', () => {
  it('N=6: hole slots are one-card-at-a-time [s, s+N], flop/turn/river next, no reuse, count 2N+5', () => {
    const plan = dealPlan(6)
    // seat s gets [s, s+6]
    expect(plan.holeSlots).toEqual([
      [0, 6],
      [1, 7],
      [2, 8],
      [3, 9],
      [4, 10],
      [5, 11],
    ])
    expect(plan.flop).toEqual([12, 13, 14])
    expect(plan.turn).toBe(15)
    expect(plan.river).toBe(16)
    const all = [...plan.holeSlots.flat(), ...plan.flop, plan.turn, plan.river]
    expect(new Set(all).size).toBe(all.length) // no slot reused
    expect(all.length).toBe(2 * 6 + 5)
  })

  it('N=2 (heads-up): hole [s, s+2], 9 slots total', () => {
    const plan = dealPlan(2)
    expect(plan.holeSlots).toEqual([
      [0, 2],
      [1, 3],
    ])
    expect(plan.flop).toEqual([4, 5, 6])
    expect(plan.turn).toBe(7)
    expect(plan.river).toBe(8)
  })
})

describe('deckCommitment', () => {
  it('mirrors the keccak-over-flattened-ciphertext digest', async () => {
    const { finalDeck } = await setupTable(3)
    const expected = keccak256(concatHex(finalDeck.flatMap((m) => [m.c1, m.c2])))
    expect(deckCommitment(finalDeck)).toBe(expected)
  })
})

describe('full deal over the (fake) board', () => {
  for (const n of [2, 3]) {
    it(`N=${n}: each seat learns exactly its 2 hole cards, community revealed to all, rest never revealed`, async () => {
      const { p, seats, agg, tableId, finalDeck } = await setupTable(n)
      const board = fakeBoard(tableId)
      const plan = dealPlan(n)
      const pubs = seats.map((s) => s.pub)

      // Drive the deal: every reveal group (and each share) is verified-then-combined,
      // and each posted step is one envelope on the board, each PoW-stamped.
      const result = await runDeal({
        provider: p,
        seats,
        agg,
        tableId,
        deck: finalDeck,
        plan,
        board,
        verifyAllShares: true,
      })

      // each seat learns exactly its 2 hole cards
      for (let s = 0; s < n; s++) {
        expect(result.holeCards[s]!.length).toBe(2)
        for (const c of result.holeCards[s]!) expect(c).toBeGreaterThanOrEqual(0)
      }
      // every hole card belongs to exactly one seat; community known to all
      expect(result.community.length).toBe(5)
      // the union of all revealed cards is 2N+5 DISTINCT card indices
      const revealed = [...Object.values(result.holeCards).flat(), ...result.community]
      expect(new Set(revealed).size).toBe(2 * n + 5)

      // the rest of the deck (the 52 - (2N+5) burned/undealt slots) is NEVER revealed:
      // assert the transcript carries no share for any undealt slot.
      const dealtSlots = new Set<number>([
        ...plan.holeSlots.flat(),
        ...plan.flop,
        plan.turn,
        plan.river,
      ])
      for (const e of board.transcript.entries) {
        const body = e.body as { slot?: number }
        if (typeof body.slot === 'number') expect(dealtSlots.has(body.slot)).toBe(true)
      }

      // post budget: N shuffle posts + one share-post per seat per reveal group.
      // hole rounds: each of the 2N hole slots is revealed to its owner; the N-1
      // peers each post their share once per hole slot they serve, batched per
      // (seat, slot). community: 5 slots × N shares. We assert the EXACT post count
      // the sequencer emits and that it equals stamps (every post grinds PoW).
      expect(board.posts).toBe(result.postCount)
      expect(board.stamps).toBe(board.posts)

      // transcript integrity: chain head advances, every envelope verifies, and
      // every signer is one of the seated wallet addresses.
      const seatAddrs = new Set(seats.map((s) => s.addr.toLowerCase()))
      for (const e of board.transcript.entries) {
        expect(await verifyEnvelope(e)).toBe(true)
        expect(seatAddrs.has(e.from.toLowerCase())).toBe(true)
      }

      // sanity: independently re-derive each seat's hole + community from finalDeck.
      for (let s = 0; s < n; s++) {
        const myCards: number[] = []
        for (const slot of plan.holeSlots[s]!) {
          const peers = seats.filter((_, i) => i !== s)
          const peerShares = await collectShares(p, peers, finalDeck, slot, tableId)
          const own = await p.share(seats[s]!.secret, finalDeck[slot]!, ctxFor(tableId, slot))
          myCards.push(revealHole(p, finalDeck, slot, own, peerShares))
        }
        expect(myCards.sort()).toEqual([...result.holeCards[s]!].sort())
      }
      for (const slot of [...plan.flop, plan.turn, plan.river]) {
        const shares = await collectShares(p, seats, finalDeck, slot, tableId)
        const idx = revealCommunity(p, finalDeck, slot, shares)
        expect(result.community).toContain(idx)
      }
    })
  }
})

describe('SHUFFLE posts carry the REAL per-round WireShuffles (M1 carry-forward)', () => {
  it('N=3: the transcript SHUFFLE posts replay as a verifiable shuffle chain against the initial deck', async () => {
    const { p, seats, agg, tableId, initial, finalDeck, rounds } = await setupTable(3)
    const board = fakeBoard(tableId)
    const plan = dealPlan(3)

    await runDeal({
      provider: p,
      seats,
      agg,
      tableId,
      deck: finalDeck,
      rounds, // pass the real per-round shuffles
      plan,
      board,
      verifyAllShares: true,
    })

    // Extract the WireShuffle from each SHUFFLE post body, in seat order.
    const shufflePosts = board.transcript.entries
      .filter((e) => e.kind === 'SHUFFLE')
      .map((e) => e.body as { seat: number; round: { deck: typeof finalDeck; proof: unknown } })
    expect(shufflePosts.length).toBe(3)

    // They must NOT be the placeholder (final deck re-posted with proof '0x'): each round's
    // deck differs from the next (a real re-encryption+permutation), and proofs are real sigs.
    for (const sp of shufflePosts) {
      expect(sp.round.proof).not.toBe('0x')
      expect((sp.round.proof as string).length).toBeGreaterThan(2)
    }

    // The decisive assertion: the posted rounds replay as a valid shuffle chain over the
    // initial deck — i.e. the board transcript is a VERIFIABLE shuffle record.
    const postedRounds = shufflePosts.map((sp) => sp.round) as typeof rounds
    const signerAddrs = seats.map((s) => s.addr)
    expect(await verifyShuffleChain(p, agg, initial, postedRounds, signerAddrs)).toBe(true)

    // and the last posted round's deck is exactly the final deck the deal dealt from.
    expect(deckCommitment(postedRounds[postedRounds.length - 1]!.deck)).toBe(deckCommitment(finalDeck))
  })

  it('rejects a rounds list whose length != seat count', async () => {
    const { p, seats, agg, tableId, finalDeck, rounds } = await setupTable(3)
    const board = fakeBoard(tableId)
    await expect(
      runDeal({
        provider: p,
        seats,
        agg,
        tableId,
        deck: finalDeck,
        rounds: rounds.slice(0, 2), // wrong length
        plan: dealPlan(3),
        board,
        verifyAllShares: true,
      }),
    ).rejects.toThrow(/rounds length must be 3/)
  })
})

describe('bad share is caught with seat attribution', () => {
  it('a forged peer share fails verify-first and names the offending seat (not just the slot)', async () => {
    const { p, seats, agg, tableId, finalDeck } = await setupTable(3)
    const board = fakeBoard(tableId)
    const plan = dealPlan(3)

    // Forge: seat 2 produces a share from a DIFFERENT secret (wrong key) for the
    // very first hole slot it must serve. verifyAllShares must reject it, and the
    // sequencer must attribute the fault to seat 2 (by its deck pub), not merely
    // report "slot k failed".
    const evil = await p.keygen()
    const badPub = seats[2]!.pub
    const badSlot = plan.holeSlots[0]![0]!
    const forge = async (slot: number, fromPub: Hex) => {
      if (slot === badSlot && fromPub.toLowerCase() === badPub.toLowerCase()) {
        return {
          from: badPub,
          share: await p.share(evil.secret, finalDeck[slot]!, ctxFor(tableId, slot)),
        }
      }
      return null
    }

    await expect(
      runDeal({
        provider: p,
        seats,
        agg,
        tableId,
        deck: finalDeck,
        plan,
        board,
        verifyAllShares: true,
        forgeShare: forge,
      }),
    ).rejects.toMatchObject({
      name: 'ShareAttributionFault',
      slot: badSlot,
      seat: badPub,
    })
  })
})

describe('duplicate-card injection (well-formedness, whole-branch review fix)', () => {
  // The attested shuffle (signature + length only) does NOT prove the deck is a valid
  // PERMUTATION. A malicious shuffler can COPY one slot's ElGamal ciphertext (c1,c2) into
  // another slot during its shuffle turn — two curve points, no plaintext knowledge needed.
  // Both slots then decrypt to the SAME valid card; every per-slot reveal passes (no
  // RevealFault) and the deal silently deals a duplicate. We reproduce the review's
  // slot 0 → slot 5 copy and assert it is now CAUGHT as an attributable fault.
  it('copying one slot ciphertext into another (slot 0 → slot 5) is caught as an attributable DuplicateCardFault', async () => {
    const { p, seats, agg, tableId, finalDeck } = await setupTable(3)
    const board = fakeBoard(tableId)
    const plan = dealPlan(3)

    // Malicious shuffler duplicates slot 0 into slot 5 (both are DEALT slots: slot 0 is
    // seat 0's first hole, slot 5 is seat 2's second hole, N=3 → holeSlots[2]=[2,5]).
    // This spans a hole↔hole boundary across two different seats, so the duplicate can
    // ONLY surface in a CROSS-SLOT uniqueness check over all revealed slots together.
    const corrupt = [...finalDeck]
    corrupt[5] = { ...finalDeck[0]! }

    // Sanity: both slots individually reveal to the SAME valid card (no per-slot fault).
    const idx0 = revealCommunity(
      p,
      corrupt,
      0,
      await collectShares(p, seats, corrupt, 0, tableId),
    )
    const idx5 = revealCommunity(
      p,
      corrupt,
      5,
      await collectShares(p, seats, corrupt, 5, tableId),
    )
    expect(idx0).toBe(idx5) // the silent duplicate the old code would have dealt

    // The fix: runDeal asserts the multiset of revealed indices is collision-free and
    // raises an attributable DuplicateCardFault naming the two colliding slots + card.
    await expect(
      runDeal({
        provider: p,
        seats,
        agg,
        tableId,
        deck: corrupt,
        plan,
        board,
        verifyAllShares: true,
      }),
    ).rejects.toMatchObject({
      name: 'DuplicateCardFault',
      card: idx0,
      slots: [0, 5],
    })
  })

  it('a legitimate deck deals 2N+5 DISTINCT cards and raises NO duplicate fault (no false positive)', async () => {
    const { p, seats, agg, tableId, finalDeck } = await setupTable(3)
    const board = fakeBoard(tableId)
    const plan = dealPlan(3)
    const result = await runDeal({
      provider: p,
      seats,
      agg,
      tableId,
      deck: finalDeck,
      plan,
      board,
      verifyAllShares: true,
    })
    const revealed = [...Object.values(result.holeCards).flat(), ...result.community]
    expect(new Set(revealed).size).toBe(2 * 3 + 5)
  })
})

describe('out-of-order / wrong-seat posts rejected', () => {
  it('a step posted by the wrong signer fails verifyEnvelope', async () => {
    const { seats, tableId } = await setupTable(2)
    const board = fakeBoard(tableId)
    const dummyShare = {
      from: seats[0]!.pub,
      share: { share: ('0x' + '00'.repeat(33)) as Hex, proof: { t1: '0x' as Hex, t2: '0x' as Hex, z: '0x' as Hex } },
    }
    const step: DealStep = {
      kind: 'COMMUNITY_SHARE',
      group: 'FLOP',
      slot: 4,
      share: dummyShare,
    }
    // signer #0 signs, but we lie about `from` by posting under seat 1's signer
    // for a body that... actually the guard is: verifyEnvelope recovers the signer
    // and it must equal `from`. We post a tampered envelope.
    const env = await postStep(board.transcript, seats[0]!.signer, step, board)
    // tamper: claim it came from seat 1
    const forged = { ...env, from: seats[1]!.addr }
    const { verifyEnvelope } = await import('@msgboard/zk-cards-core')
    expect(await verifyEnvelope(env)).toBe(true)
    expect(await verifyEnvelope(forged)).toBe(false)
  })

  it('a non-canonical prev-chain is detected by the transcript', async () => {
    const { seats, tableId } = await setupTable(2)
    const board = fakeBoard(tableId)
    const step: DealStep = { kind: 'SHUFFLE', seat: 0, round: { deck: [], proof: '0x' } }
    await postStep(board.transcript, seats[0]!.signer, step, board)
    // appending an envelope with a stale prev must throw a chain break
    const bad = await (async () => {
      const { makeEnvelope } = await import('@msgboard/zk-cards-core')
      return makeEnvelope(seats[0]!.signer, tableId, 1, ('0x' + '11'.repeat(32)) as Hex, 'SHUFFLE', {
        seat: 0,
      })
    })()
    expect(() => board.transcript.append(bad)).toThrow(/chain break/)
  })
})

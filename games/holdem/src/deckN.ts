import type { Hex } from 'viem'
import type {
  MaskedDeckProvider,
  ShuffleSigner,
  WireMasked,
  WireShuffle,
} from '@msgboard/zk-cards-core'

/**
 * N-party verifiable deck — Track 3 Task 1.
 *
 * This is a THIN orchestration layer over the existing, already-N-agnostic
 * `@msgboard/zk-cards-core` crypto. It does NOT re-implement ElGamal, aggregation,
 * remasking, Chaum–Pedersen shares, or the attested shuffle — it sequences the
 * provider's primitives for an arbitrary number of seats.
 *
 *   - `jointKey` is the aggregate of every seat's deck public key. Because
 *     `aggregatePubKeys` is a commutative point sum, the joint key is independent
 *     of seat order and reduces an arbitrary-length list (so N≥3 is free).
 *   - `runShuffleChain` threads the masked deck through every seat in turn: seat 0
 *     shuffles+re-encrypts the freshly-masked initial deck, seat i shuffles seat
 *     i-1's output. Each step is one `provider.shuffle` — real ElGamal re-encryption
 *     plus a Fisher–Yates permutation, attested by that seat's wallet signature over
 *     keccak(before‖after).
 *   - `verifyShuffleChain` replays the chain, checking each round's attest signature
 *     against the running "before" deck and the seat address at that position.
 *
 * TRUST MODEL — TWO DISTINCT PROPERTIES (do not conflate; whole-branch review fix):
 *
 *   (a) ORDER SECRECY  — one HONEST shuffler suffices: because that seat re-encrypts and
 *       permutes with secret randomness no other seat sees, no single seat (and no
 *       coalition short of ALL shufflers) knows the final order. This is what the attested
 *       shuffle chain buys (spec §12).
 *
 *   (b) DECK WELL-FORMEDNESS (the deck is a valid PERMUTATION — no duplicated/dropped
 *       cards) — the attested shuffle does NOT prove this. `verifyShuffle` checks only the
 *       signature and the deck LENGTH; it does NOT prove the output is a permutation of the
 *       input. A single MALICIOUS shuffler among N-1 honest ones can copy one slot's
 *       ElGamal ciphertext into another during its turn — both slots then decrypt to the
 *       same card and every per-slot reveal still passes. ONE honest shuffler does NOT
 *       protect against this. In v1 well-formedness is enforced SEPARATELY by a cross-slot
 *       uniqueness check at deal time (`dealSeq.ts` `runDeal` → `DuplicateCardFault`), NOT
 *       by the attested shuffle. See the spec note on the attested-shuffle limitation.
 *
 * v1 posture: the shuffle is ATTESTED (a signature), not zero-knowledge. ORDER SECRECY
 * rests on "every shuffler would have to collude to know the order" (spec §12); DECK
 * WELL-FORMEDNESS rests on the deal-time uniqueness check. The `MaskedDeckProvider` seam is
 * the drop-in point for the later SNARK shuffle prover, which would prove BOTH at once and
 * make the deal-time check redundant.
 */

export interface SeatKeys {
  /** deck secret (ElGamal scalar) — NEVER leaves the seat */
  secret: Hex
  /** deck public key (ElGamal point) — aggregated into the joint key */
  pub: Hex
  /** wallet address — recovered from each shuffle attest signature */
  addr: Hex
}

/** A seat able to attest (sign) a shuffle round it performs. */
export interface ShuffleSeat {
  signer: ShuffleSigner
}

/** Joint deck key = aggregate of all seats' deck public keys (order-independent). */
export function jointKey(provider: MaskedDeckProvider, pubs: Hex[]): Hex {
  return provider.aggregate(pubs)
}

/**
 * Seat 0 shuffles the freshly-masked initial deck under `agg`; seat i then shuffles
 * seat i-1's output. Returns the initial deck actually masked (so verification can
 * replay the very first round), the per-seat shuffle rounds, and the final deck.
 */
export async function runShuffleChain(
  provider: MaskedDeckProvider,
  agg: Hex,
  seats: { signer: ShuffleSigner }[],
): Promise<{ initial: WireMasked[]; finalDeck: WireMasked[]; rounds: WireShuffle[] }> {
  const initial = await provider.initialDeck(agg)
  const rounds: WireShuffle[] = []
  let deck = initial
  for (const seat of seats) {
    const round = await provider.shuffle(agg, deck, seat.signer)
    rounds.push(round)
    deck = round.deck
  }
  return { initial, finalDeck: deck, rounds }
}

/**
 * Verify a shuffle chain: every round must verify against the deck that preceded it
 * and the seat address at that position. The round/signer counts must match exactly.
 *
 * NOTE: this attests ATTRIBUTION + length only — it does NOT prove each round is a valid
 * permutation (a shuffler can duplicate a ciphertext and still pass). Deck WELL-FORMEDNESS
 * is enforced separately by the deal-time uniqueness check (`runDeal` → `DuplicateCardFault`);
 * this function is what that fault uses to TRACE a duplicate back to the offending round/seat.
 */
export async function verifyShuffleChain(
  provider: MaskedDeckProvider,
  agg: Hex,
  initial: WireMasked[],
  rounds: WireShuffle[],
  signerAddrs: Hex[],
): Promise<boolean> {
  if (rounds.length !== signerAddrs.length) return false
  let before = initial
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i]!
    const ok = await provider.verifyShuffle(agg, before, round, signerAddrs[i]!)
    if (!ok) return false
    before = round.deck
  }
  return true
}

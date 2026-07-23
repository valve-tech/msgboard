import type { Hex } from 'viem'
import type {
  MaskedDeckProvider,
  WireMasked,
  WireShare,
} from '@msgboard/zk-cards-core'

/**
 * N-party selective card reveal — Track 3 Task 2.
 *
 * Like `deckN.ts`, this is a THIN orchestration over the already-N-agnostic
 * `@msgboard/zk-cards-core` crypto: a reveal is just the collection + combination of
 * Chaum–Pedersen decryption shares (one per seat) over a slot of the masked deck.
 * We do NOT re-implement ElGamal or Chaum–Pedersen — `provider.share` proves a
 * share, `provider.verifyShare` checks its soundness, and `provider.unmask`
 * (over `unmaskWithShares`) combines all shares to a card index.
 *
 * Two reveal modes, distinguished ONLY by which seats contribute a share:
 *
 *   - COMMUNITY (flop/turn/river): every one of the N seats contributes a share,
 *     and the combined point is a public card readable by ALL. `revealCommunity`
 *     requires all N shares.
 *
 *   - HOLE (a seat's private cards): the N-1 OTHER seats each contribute a share
 *     (broadcast on the transport), but the combination is short exactly the owner's
 *     share. Only the owner can compute its own share (it alone holds its deck
 *     secret), so only the owner can complete the unmask and learn the card.
 *     `revealHole` takes the owner's own share + the N-1 peer shares. A passive
 *     observer holding only the peer shares cannot resolve the card (combining N-1
 *     shares yields a non-card point → fault), so the card stays hidden.
 *
 * REVEAL-TIME INTEGRITY GATE (v1, attested-shuffle posture):
 * Task-1 attestation proves ATTRIBUTION (who shuffled) but NOT permutation
 * correctness — a malicious shuffler could duplicate or drop a card and still sign a
 * valid attestation. In v1 the reveal is the real integrity gate: if a slot's
 * ciphertext does not decrypt to a genuine card point, `unmaskWithShares` throws.
 * This module PROPAGATES that as an attributable `RevealFault` (which slot failed),
 * never swallowing it and never returning a bogus card.
 */

/** A decryption share contributed by one seat, tagged with that seat's deck pubkey. */
export interface RevealShare {
  /** the contributing seat's deck public key — used to verify the CP proof */
  from: Hex
  share: WireShare
}

/**
 * Thrown when a slot fails to reveal: either a share is missing (incomplete set) or
 * the deck slot is corrupt (passed shuffle-attestation but isn't a real card — the
 * v1 integrity gate). Carries the offending `slot` so the fault is attributable.
 */
export class RevealFault extends Error {
  readonly slot: number
  constructor(slot: number, cause?: unknown) {
    super(
      `reveal: slot ${slot} did not resolve to a card point ` +
        `(missing share, or a corrupted deck that passed shuffle-attestation)` +
        (cause instanceof Error ? `: ${cause.message}` : ''),
    )
    this.name = 'RevealFault'
    this.slot = slot
  }
}

/**
 * Replay-binding context for a share. MUST include both `tableId` and `slot` so a
 * share proven for slot X cannot be replayed to verify slot Y. (Task 3 further
 * scopes uniqueness per hand via a hand counter folded into `tableId`.)
 */
export function ctxFor(tableId: Hex, slot: number): string {
  return `holdem/${tableId}/slot/${slot}`
}

/** Each given seat contributes a (proven) decryption share for `deck[slot]`. */
export async function collectShares(
  provider: MaskedDeckProvider,
  seats: { secret: Hex; pub: Hex }[],
  deck: WireMasked[],
  slot: number,
  tableId: Hex,
): Promise<RevealShare[]> {
  const card = deck[slot]!
  const ctx = ctxFor(tableId, slot)
  return Promise.all(
    seats.map(async (s) => ({ from: s.pub, share: await provider.share(s.secret, card, ctx) })),
  )
}

/**
 * Verify every contributed share is a sound Chaum–Pedersen decryption share for the
 * RIGHT seat over `deck[slot]`, bound to this slot's ctx. The `pubs` list is the
 * authoritative set of seat deck-pubkeys: each share's `from` must be one of them and
 * its proof must verify against it. Returns false on any forged/stale/replayed share.
 */
export async function verifyAllShares(
  provider: MaskedDeckProvider,
  pubs: Hex[],
  deck: WireMasked[],
  slot: number,
  tableId: Hex,
  shares: RevealShare[],
): Promise<boolean> {
  const card = deck[slot]!
  const ctx = ctxFor(tableId, slot)
  const allowed = new Set(pubs.map((p) => p.toLowerCase()))
  const results = await Promise.all(
    shares.map((rs) =>
      allowed.has(rs.from.toLowerCase())
        ? provider.verifyShare(rs.from, card, rs.share, ctx)
        : Promise.resolve(false),
    ),
  )
  return results.every(Boolean)
}

/** Combine a set of decryption shares for one slot, surfacing a corrupt deck as a fault. */
function combine(
  provider: MaskedDeckProvider,
  deck: WireMasked[],
  slot: number,
  shares: WireShare[],
): number {
  try {
    return provider.unmask(deck[slot]!, shares)
  } catch (cause) {
    // `unmaskWithShares` throws when the combined point isn't a card point — either an
    // incomplete share set or a corrupted (non-permutation) deck. Either way this is a
    // hard, attributable fault: never swallow it, never return a bogus card.
    throw new RevealFault(slot, cause)
  }
}

/**
 * Community reveal: combine ALL N shares to the public card index. Requires every
 * seat's share — an incomplete set yields a non-card point and a `RevealFault`.
 */
export function revealCommunity(
  provider: MaskedDeckProvider,
  deck: WireMasked[],
  slot: number,
  shares: RevealShare[],
): number {
  return combine(provider, deck, slot, shares.map((rs) => rs.share))
}

/**
 * Hole reveal: only the owner can call this, because only the owner can produce
 * `ownShare` (it alone holds its deck secret). Combines the owner's own share with the
 * N-1 peer shares. Without `ownShare` the combination is short one share and stays
 * hidden (a non-owner gets a `RevealFault`, never the card). A corrupt slot surfaces
 * as a `RevealFault` here too.
 */
export function revealHole(
  provider: MaskedDeckProvider,
  deck: WireMasked[],
  slot: number,
  ownShare: WireShare,
  peerShares: RevealShare[],
): number {
  return combine(provider, deck, slot, [...peerShares.map((rs) => rs.share), ownShare])
}

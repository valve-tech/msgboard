import type { Hex } from 'viem'
import type { MaskedDeckProvider, WireMasked } from '@msgboard/zk-cards-core'
import {
  deckCommitment as computeDeckCommitment,
  assertNoDuplicateCards,
  verifyAttributed,
  ShareAttributionFault,
  DuplicateCardFault,
} from './dealSeq'
import type { RevealShare } from './revealN'

/**
 * `verifyDealBinding` — the C3 off-chain obligation for HoldemTableN's secp256k1 deal path
 * (holdem-hardening-blueprint.md §10: "C3 deferred", "client MUST retain deck+gameState until
 * Settled" — this module is the deferred residual). Mirrors, in spirit, `zk-core`'s
 * `deckBinding.ts#verifyDealBinding` — the validate-before-co-sign guard a client MUST run
 * before co-signing — but for the DIFFERENT curve/protocol: `zk-core/deckBinding.ts` is
 * Zypher/Baby-JubJub specific (`jointKeyCommit`/`shuffleRoot`, both committed ON-CHAIN for
 * ZkTable) and explicitly says the secp256k1 `AttestedElGamalDeck` path is OUT OF SCOPE for it.
 * HoldemTableN has NO on-chain joint-key commitment at all (that on-chain binding is the
 * still-deferred "full decoy-key closure" — see the module's OPEN note); this guard is the
 * OFF-CHAIN-ONLY substitute a client can run today with what's actually available: the
 * registered per-seat deck pubkeys, the masked deck, and whatever decryption shares it can
 * legitimately see.
 *
 * WHAT IS CHECKED (blueprint §10 item 2):
 *   (a) the deck's aggregate masking key == `aggregatePubKeys(registeredKeys)`, AS FAR AS
 *       CHECKABLE OFF-CHAIN. ElGamal ciphertexts don't expose the masking key they were formed
 *       under directly — the strongest available off-chain proxy is: decrypting with GENUINE,
 *       ATTRIBUTED shares from every seat in `registeredKeys` (never a peer-supplied aggregate)
 *       yields a valid card-table point. A deck actually masked under a DIFFERENT (decoy)
 *       aggregate manifests here as a DECODE FAILURE, not a hash mismatch — see the reject
 *       reason on that branch below.
 *   (b) no duplicate cards across the slots being checked (reused from `dealSeq.ts` —
 *       `assertNoDuplicateCards`, the exact same well-formedness gate `runDeal` enforces).
 *   (c) every contributed share is attributable to its claimed registered seat (reused from
 *       `dealSeq.ts` — `verifyAttributed`, the exact same verify-before-combine chokepoint
 *       `runDeal` enforces, including WHICH seat's share is bad on failure).
 *
 * PRIVACY BOUNDARY (deliberate, matches `revealN.ts`'s hole-reveal design): a co-signing seat
 * can only ever assemble a COMPLETE (all-N) share set for (i) the community slots (broadcast to
 * everyone) and (ii) its OWN hole slots (its self-computed share + the N-1 broadcast peer
 * shares) — it never sees another seat's own hole share, by design. `dealtShares` should
 * therefore only contain the slots the caller can legitimately see; omitted slots are simply
 * not checked (this is the honest privacy boundary, not a gap in the guard). A neutral
 * relay/watchtower with full visibility (e.g. replaying an already-finished showdown's posted
 * reveals) may instead pass every dealt slot.
 *
 * HOOK — a client (see `session.ts`'s genesis co-sign) MUST call this and see `{ok: true}`
 * BEFORE co-signing the `ChannelStateN` that commits to `deckCommitment`. Never trust a
 * peer-assembled deck/commitment without having independently run this first.
 */

export type VerifyDealBindingResult = { ok: true } | { ok: false; reason: string }

export interface VerifyDealBindingArgs {
  /** the secp256k1 deck provider (`AttestedElGamalDeck` in production) */
  provider: MaskedDeckProvider
  /** the table's on-chain bytes32 id — must be the id `ctxFor`/`_ctxFor` bind on-chain */
  tableId: Hex
  /** the table's REGISTERED per-seat deck pubkeys, in seat order — the ONLY trusted source for
   *  the aggregate; NEVER substitute a peer-supplied aggregate or anything read off the deck
   *  ciphertexts themselves */
  registeredKeys: Hex[]
  /** the masked deck about to be committed (the one that will hash to `deckCommitment`) */
  deck: WireMasked[]
  /** the value about to be co-signed into the genesis `ChannelStateN` */
  deckCommitment: Hex
  /** slot -> every share contributed for that slot that the caller can see (see the PRIVACY
   *  BOUNDARY note above). A slot with fewer than all N seats' shares will fail to decode and
   *  reject — supply a complete set only for slots you can actually assemble one for. */
  dealtShares: Record<number, RevealShare[]>
}

function reject(reason: string): VerifyDealBindingResult {
  return { ok: false, reason }
}

/**
 * Run checks (a)/(b)/(c) over every slot in `dealtShares`. Returns `{ok: true}` only if the
 * deck hashes to the claimed commitment AND every checked slot is attribution-clean, decodes
 * against the registered keys, and the decoded set is collision-free. Never throws for a
 * garbage/decoy/malformed input — only a clear reject.
 */
export async function verifyDealBinding(args: VerifyDealBindingArgs): Promise<VerifyDealBindingResult> {
  const { provider, tableId, registeredKeys, deck, deckCommitment: committed, dealtShares } = args
  const slots = Object.keys(dealtShares).map(Number).sort((a, b) => a - b)
  if (slots.length === 0) return reject('no dealt slots supplied to check')

  if (computeDeckCommitment(deck) !== committed) {
    return reject('deckCommitment mismatch: the deck does not hash to the claimed commitment')
  }

  const revealedBySlot = new Map<number, number>()
  for (const slot of slots) {
    const shares = dealtShares[slot]!

    // (c) attribution — every contributed share must verify against ITS claimed registered
    // pubkey (exactly `runDeal`'s verify-then-combine chokepoint).
    try {
      await verifyAttributed(provider, registeredKeys, deck, slot, tableId, shares)
    } catch (e) {
      const who = e instanceof ShareAttributionFault ? ` from ${e.seat}` : ''
      return reject(`slot ${slot}: share attribution failed${who} — forged, stale, or replayed share`)
    }

    // (a) aggregate masking key — decode success using ONLY genuine, attributed shares from
    // `registeredKeys` is the strongest off-chain-checkable proxy available (see module header).
    let card: number
    try {
      card = provider.unmask(deck[slot]!, shares.map((rs) => rs.share))
    } catch {
      return reject(
        `slot ${slot}: decode failed — deck is not masked under aggregatePubKeys(registeredKeys) ` +
          `(a decoy aggregate) or the ciphertext is corrupt`,
      )
    }
    revealedBySlot.set(slot, card)
  }

  // (b) well-formedness — no two checked slots may reveal the same card.
  try {
    assertNoDuplicateCards(revealedBySlot)
  } catch (e) {
    if (e instanceof DuplicateCardFault) {
      return reject(`slots ${e.slots[0]} and ${e.slots[1]} both revealed card ${e.card} — deck is not a valid permutation`)
    }
    return reject(e instanceof Error ? e.message : 'duplicate card detected across dealt slots')
  }

  return { ok: true }
}

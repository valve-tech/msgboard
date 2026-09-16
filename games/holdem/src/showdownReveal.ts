import type { Hex } from 'viem'
import {
  type WireMasked,
  type Point,
  deserializeScalar,
  deserializeMasked,
  deserializePoint,
  decryptionShare,
  proveShare,
} from '@msgboard/zk-cards-core'
import { ctxFor } from './revealN'

/**
 * `postShowdownReveals` share/proof generator — the off-chain client half of HoldemTableN's C2
 * binding on-chain showdown adjudication (holdem-hardening-blueprint.md §4/§10). secp256k1 only
 * (the `AttestedElGamalDeck` provider / `elgamal.ts` + `chaumPedersen.ts` primitives) — this
 * module does NOT re-implement ElGamal or Chaum–Pedersen, it just shapes their outputs for the
 * exact on-chain calldata `HoldemTableN.postShowdownReveals(tableId, seat, deck, slots, shares,
 * proofs)` expects, byte-for-byte:
 *
 *   - `slots`  → `uint32[]`      ascending, de-duplicated slot indices.
 *   - `shares` → `uint256[2][]`  each `[d.x, d.y]` — the raw ElGamal decryption share
 *                                `d = c1[slot]·sk` (same as `elgamal.ts#decryptionShare`).
 *   - `proofs` → `uint256[5][]`  each `[t1.x, t1.y, t2.x, t2.y, z]` — the Chaum–Pedersen DLEQ
 *                                proof from `chaumPedersen.ts#proveShare`, bound to
 *                                `ctx = ctxFor(tableId, slot) = "holdem/{tableId}/slot/{slot}"`
 *                                (REUSED from `revealN.ts` — the exact string
 *                                `HoldemTableN._ctxFor` reconstructs on-chain).
 *
 * This module never verifies its own output (that's `chaumPedersen.verifyShare` off-chain / the
 * on-chain `RevealShareDLEQ.verify` — see the test suite for a round-trip that checks generated
 * output actually verifies under `verifyShare`, the exact mirror of the on-chain DLEQ).
 *
 * REQUIRED-SLOT SET: a seat owes ONE share per slot in `requiredShowdownSlots(nSeats,
 * liveMask)`, not just its own hole cards — every card was masked under the AGGREGATE of all N
 * seats' deck keys, so decoding ANY slot needs a contribution from EVERY seat (see
 * `HoldemTableN._isRequiredSlot`, mirrored exactly below).
 *
 * CLIENT OBLIGATION — "retain deck+gameState until Settled" (blueprint §10, accepted decision):
 * every showdown entrypoint (`openShowdownDispute`, `postShowdownReveals`, `finalizeShowdownN`,
 * `resolveShowdownTimeout`) is deck/gameState HASH-PINNED — each call takes the full plaintext
 * masked deck and the game-state bytes as calldata and checks their hash against the co-signed
 * commitment. A client that discards its local copies once a hand "looks done" cannot answer a
 * showdown dispute opened later (any time before `disputeDeadline`/`sd.deadlineCeil`) and risks
 * a forced-fold or a pot split it could have avoided by just answering. Every seat MUST retain
 * both the full masked deck and the SETTLED `gameState` bytes for the entire life of a hand,
 * until the table's settlement is actually final on-chain — not just until the UI shows a
 * result.
 */

/** `[d.x, d.y]` — the on-chain `uint256[2] share` calldata shape for one slot. */
export type ShareXY = readonly [bigint, bigint]
/** `[t1.x, t1.y, t2.x, t2.y, z]` — the on-chain `uint256[5] proof` calldata shape for one slot. */
export type ProofWords = readonly [bigint, bigint, bigint, bigint, bigint]

/** One seat's full reveal batch for `postShowdownReveals` — arrays are 1:1 index-aligned. */
export interface ShowdownRevealBatch {
  /** ascending, de-duplicated */
  slots: number[]
  shares: ShareXY[]
  proofs: ProofWords[]
}

function pointXY(p: Point): [bigint, bigint] {
  const a = p.toAffine()
  return [a.x, a.y]
}

/**
 * The canonical required-slot set for a showdown dispute — mirrors `HoldemTableN._isRequiredSlot`
 * EXACTLY: every LIVE (non-folded) seat's two hole slots `[s, N+s]`, plus the 5 board slots
 * `[2N, 2N+5)`. A folded seat's hole slots are never required (its cards stay private — nobody
 * needs to decode a card that plays no role in ranking). `liveMask` bit `s` set ⇔ seat `s` is
 * live, matching `IGameRulesN.showdownEligible`'s `liveMask` output.
 *
 * STUB CASE: when at most one seat is live (the on-chain `showdownEligible` sweep-stub branch,
 * where `requiredCount` is forced to 0), nothing is required at all — `finalizeShowdownN`
 * settles immediately with no reveals. Returns `[]` in that case; callers must not post shares.
 */
export function requiredShowdownSlots(nSeats: number, liveMask: bigint | number): number[] {
  const mask = BigInt(liveMask)
  let liveCount = 0
  for (let s = 0; s < nSeats; s++) if ((mask >> BigInt(s)) & 1n) liveCount++
  if (liveCount <= 1) return []

  const slots: number[] = []
  for (let s = 0; s < nSeats; s++) {
    if ((mask >> BigInt(s)) & 1n) {
      slots.push(s)
      slots.push(nSeats + s)
    }
  }
  const base = 2 * nSeats
  for (let i = 0; i < 5; i++) slots.push(base + i)
  return slots.sort((a, b) => a - b)
}

export interface GenerateShowdownRevealsArgs {
  /** the table's on-chain bytes32 id — MUST be the id `_ctxFor` binds on-chain */
  tableId: Hex
  /** this seat's ElGamal deck secret (serialized scalar) — NEVER leaves the seat */
  secret: Hex
  /** the full masked deck (all 52 slots), the SAME one bound to `disputeState.deckCommitment` */
  deck: WireMasked[]
  /** the slots this seat must answer this call — see `requiredShowdownSlots` (may be a subset,
   *  for batching across multiple `postShowdownReveals` calls) */
  slots: number[]
}

/**
 * Produce this seat's decryption share + DLEQ proof for every given slot, shaped for
 * `HoldemTableN.postShowdownReveals(tableId, seat, deck, slots, shares, proofs)`. This is what
 * the bot harness / a real client submits, per seat, per (batch of) required slot(s).
 */
export function generateShowdownReveals(args: GenerateShowdownRevealsArgs): ShowdownRevealBatch {
  const sk = deserializeScalar(args.secret)
  const slots = [...new Set(args.slots)].sort((a, b) => a - b)
  const shares: ShareXY[] = []
  const proofs: ProofWords[] = []

  for (const slot of slots) {
    const wire = args.deck[slot]
    if (!wire) throw new Error(`generateShowdownReveals: deck has no slot ${slot}`)
    const m = deserializeMasked(wire)
    const ctx = ctxFor(args.tableId, slot)

    const d = decryptionShare(sk, m)
    const proof = proveShare(sk, m, ctx)

    const [dx, dy] = pointXY(d)
    const [t1x, t1y] = pointXY(deserializePoint(proof.t1))
    const [t2x, t2y] = pointXY(deserializePoint(proof.t2))
    const z = deserializeScalar(proof.z)

    shares.push([dx, dy])
    proofs.push([t1x, t1y, t2x, t2y, z])
  }

  return { slots, shares, proofs }
}

/**
 * `uint256[] deck` calldata: 4 affine words per card, in slot order — `[c1.x, c1.y, c2.x,
 * c2.y]`. Matches `HoldemTableN._deckHash`'s expected layout (it re-compresses these 4 words
 * per card to the same 33-byte SEC1 encoding `deckCommitment`/`dealSeq.deckCommitment` hashes
 * off-chain), so `deck` passed here alongside a `ShowdownRevealBatch` is exactly what
 * `postShowdownReveals`/`finalizeShowdownN`/`resolveShowdownTimeout` expect as the `deck` arg.
 */
export function encodeDeckForShowdown(deck: WireMasked[]): bigint[] {
  const words: bigint[] = []
  for (const wire of deck) {
    const [c1x, c1y] = pointXY(deserializePoint(wire.c1))
    const [c2x, c2y] = pointXY(deserializePoint(wire.c2))
    words.push(c1x, c1y, c2x, c2y)
  }
  return words
}

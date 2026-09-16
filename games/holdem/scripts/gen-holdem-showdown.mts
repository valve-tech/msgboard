// Generator for the on-chain HoldemTableN C2 (DEMAND_SHOWDOWN) end-to-end Foundry suite
// (test/foundry/HoldemTableNShowdownC2.t.sol), invoked via `vm.ffi`. Produces a REAL N-party
// secp256k1 masked deck under the joint (aggregate) key of `n` seats, plus REAL Chaum-Pedersen
// decryption-share + DLEQ-proof batches for EVERY seat over EVERY slot HoldemTableN's showdown
// dispute needs decoded — using the SAME production code the real client uses
// (`@msgboard/holdem`'s `showdownReveal.ts#generateShowdownReveals` / `encodeDeckForShowdown`),
// not a reimplementation. No fixtures, no stubs: the deck, the shares, and the DLEQ proofs all
// come from the same off-chain crypto (`@msgboard/zk-cards-core`'s secp256k1 ElGamal +
// Chaum-Pedersen primitives) the real game uses.
//
// SLOT LAYOUT (mirrors HoldemShowdownLib._isRequiredSlot / showdownReveal.ts's
// requiredShowdownSlots for a FULL live mask — every seat live, nobody folded): seat s's two
// hole slots are deck positions [s, n+s]; the 5 board cards are [2n, 2n+5). When every seat is
// live this required-slot set is exactly the CONTIGUOUS range [0, 2n+5) — this script asserts
// that against `requiredShowdownSlots` itself (self-check, mirrors gen-card-table-secp.mts's
// posture) rather than assuming it, so a future change to that convention fails loudly here
// instead of silently desyncing this fixture. The deck this script builds is therefore SIZED
// EXACTLY to the required slots (no filler cards beyond what a showdown dispute ever touches).
//
// Two modes (argv[0]):
//
//   pks <n>
//     Cheap: only derives the `n` deterministic per-seat secp256k1 keypairs and prints their
//     PUBLIC keys (no deck/shares) — used by the Foundry test to register real on-curve deck
//     keys at create()/join() time, BEFORE the real on-chain tableId exists (the keys are
//     tableId-independent; only the reveal DLEQ proofs, generated in `full` mode below, are
//     bound to it). Prints: (uint256[] pksFlat) — n*2 words, seat-major [x,y].
//
//   full <tableIdHex> <n> <card_0> <card_1> ... <card_{2n+4}>
//     The real run, AFTER the on-chain tableId is known: masks the given plaintext card index
//     (0..51, `(rank-2)*4+suit`) into each required slot under the joint key, then produces
//     EVERY seat's full decryption-share + DLEQ-proof batch for ALL `2n+5` slots (bound to
//     `ctxFor(tableIdHex, slot)` — the exact context HoldemShowdownLib._ctxFor reconstructs
//     on-chain), shaped exactly for `HoldemTableN.postShowdownReveals`. Prints:
//       (uint256[] pksFlat, uint256[] deck, bytes32 deckCommitment,
//        uint256[] sharesFlat, uint256[] proofsFlat)
//     `deck` is the `encodeDeckForShowdown` layout (4 words/card: c1.x,c1.y,c2.x,c2.y, slot
//     order) — byte-identical to what postShowdownReveals/finalizeShowdownN/
//     resolveShowdownTimeout expect and what `deckCommitment` (the on-chain `_deckHash`
//     compressed-SEC1 keccak) is computed over. `sharesFlat`/`proofsFlat` are flattened
//     (seat-major, then slot-minor, ascending) — 2 words/share, 5 words/proof — to sidestep
//     solc's nested-fixed-array-in-one-tuple stack-too-deep on decode (same convention as
//     gen-card-table-secp.mts / gen-showdown-dispute.mts); the Foundry test slices per
//     (seat, slot) with `base = seat*numSlots + slot`.
//
// The per-seat secret keys are DETERMINISTIC (a fixed function of seat index only, not of
// tableId or the card assignment) — mirroring gen-share-dispute.mts's convention — so a `pks`
// call and a LATER `full` call for the same `n` always agree on which public key belongs to
// which seat, even though they run as separate processes.

import { encodeAbiParameters, keccak256, concatHex, type Hex } from 'viem'
import {
  ORDER,
  aggregatePubKeys,
  pubKeyOf,
  maskCard,
  serializePoint,
  serializeScalar,
  type Point,
} from '@msgboard/zk-cards-core'
import { generateShowdownReveals, encodeDeckForShowdown, requiredShowdownSlots } from '../src/showdownReveal.ts'

/** Deterministic-ish per-seat secret key — a fixed function of seat index alone. */
function skFor(seat: number): bigint {
  return (BigInt(seat + 1) * 0x9e3779b97f4a7c15n + 0x2025n) % ORDER
}

function affine(p: Point): [bigint, bigint] {
  const a = p.toAffine()
  return [a.x, a.y]
}

/// On-chain mirror: HoldemShowdownLib._deckHash hashes the same compressed (c1,c2) wire points.
function deckCommitment(deck: { c1: Hex; c2: Hex }[]): Hex {
  return keccak256(concatHex(deck.flatMap((m) => [m.c1, m.c2])))
}

function pksBlob(n: number): Hex {
  const pks = Array.from({ length: n }, (_, i) => pubKeyOf(skFor(i)))
  const pksFlat: bigint[] = []
  for (const pk of pks) pksFlat.push(...affine(pk))
  return encodeAbiParameters([{ type: 'uint256[]' }], [pksFlat])
}

function fullBlob(tableId: Hex, n: number, cards: number[]): Hex {
  const numSlots = 2 * n + 5
  if (cards.length !== numSlots) {
    throw new Error(`gen-holdem-showdown: expected ${numSlots} card indices for n=${n}, got ${cards.length}`)
  }
  for (const c of cards) {
    if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`gen-holdem-showdown: bad card index ${c}`)
  }

  // Self-check: our contiguous [0, numSlots) slot layout must equal requiredShowdownSlots' own
  // derivation for a full (every seat live) mask — see this file's header.
  const fullMask = (1n << BigInt(n)) - 1n
  const required = requiredShowdownSlots(n, fullMask)
  const contiguous = Array.from({ length: numSlots }, (_, i) => i)
  if (required.length !== contiguous.length || required.some((s, i) => s !== contiguous[i])) {
    throw new Error(
      `gen-holdem-showdown: requiredShowdownSlots(n=${n}, full) != contiguous [0,${numSlots}): got ${JSON.stringify(required)}`,
    )
  }

  const sks = Array.from({ length: n }, (_, i) => skFor(i))
  const pks = sks.map((sk) => pubKeyOf(sk))
  const agg = aggregatePubKeys(pks)

  const deckWire = cards.map((card, slot) => {
    // deterministic-ish per-slot masking randomness (mirrors gen-share-dispute.mts)
    const r = (BigInt(slot + 1) * 0x1234567n + 0x99n) % ORDER
    const m = maskCard(agg, card, r)
    return { c1: serializePoint(m.c1), c2: serializePoint(m.c2) }
  })

  const commit = deckCommitment(deckWire)
  const deckWords = encodeDeckForShowdown(deckWire)

  const pksFlat: bigint[] = []
  for (const pk of pks) pksFlat.push(...affine(pk))

  const slots = contiguous
  const sharesFlat: bigint[] = []
  const proofsFlat: bigint[] = []
  for (let i = 0; i < n; i++) {
    const batch = generateShowdownReveals({
      tableId,
      secret: serializeScalar(sks[i]!),
      deck: deckWire,
      slots,
    })
    if (batch.slots.length !== numSlots || batch.slots.some((s, idx) => s !== idx)) {
      throw new Error(`gen-holdem-showdown: seat ${i} reveal batch slot mismatch`)
    }
    for (let s = 0; s < numSlots; s++) {
      sharesFlat.push(batch.shares[s]![0], batch.shares[s]![1])
      proofsFlat.push(...batch.proofs[s]!)
    }
  }

  return encodeAbiParameters(
    [
      { type: 'uint256[]' },
      { type: 'uint256[]' },
      { type: 'bytes32' },
      { type: 'uint256[]' },
      { type: 'uint256[]' },
    ],
    [pksFlat, deckWords, commit, sharesFlat, proofsFlat],
  )
}

function main() {
  const argv = process.argv.slice(2)
  const mode = argv[0]
  if (mode === 'pks') {
    const n = Number(argv[1])
    process.stdout.write(pksBlob(n))
    return
  }
  if (mode === 'full') {
    const tableId = argv[1] as Hex
    const n = Number(argv[2])
    const cards = argv.slice(3).map((c) => Number(c))
    process.stdout.write(fullBlob(tableId, n, cards))
    return
  }
  throw new Error(`gen-holdem-showdown: unknown mode ${JSON.stringify(mode)} (expected 'pks' or 'full')`)
}

main()

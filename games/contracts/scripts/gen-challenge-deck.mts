// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review (same posture as
// games/zk-core/scripts/gen-shuffle-proof.mts / gen-showdown-dispute.mts / gen-deck-round-trip.mts:
// isolated dev/build script, not shipped in any package output). Lives under games/contracts (not
// games/zk-core/scripts, which this Wave-2 pass only READS/RUNS, never edits) because it is
// specific to ZkTable's `challengeDeck` Foundry suite.
//
// Generates a REAL two-seat Baby-JubJub (ed_on_bn254) shuffle-chain transcript for
// ZkTable.challengeDeck's ffi tests (ZkTableDecoyChallenge.t.sol): seat 1 shuffles the canonical
// initial deck D0 into deck1 (a genuine verify52-passing proof under the REAL joint key), then
// seat 2 shuffles deck1 into deck2 — under the REAL joint key in "honest" mode, or under an
// unrelated ROGUE joint key in "decoy" mode (simulating a seat that masks its shuffle
// contribution under a wrong key: the resulting proof is real/well-formed but does not verify
// against the pinned real pkc, exactly the deckkey-binding-spec.md attack this feature attributes).
//
// Usage: node gen-challenge-deck.mts <honest|decoy>
// Prints a single 0x-prefixed ABI blob:
//   (uint256[2] deckKeyA, uint256[2] deckKeyB, uint256 aggX, uint256 aggY, uint256[24] pkc,
//    uint256[] d0 /* 208 */, uint256[] afterDeck1 /* 208 */, bytes proof1,
//    uint256[] afterDeck2 /* 208 */, bytes proof2)
//
// All deck word arrays (d0/afterDeck1/afterDeck2) are in ZkTable's on-chain layout
// ([e1.x,e1.y,e2.x,e2.y] per card — see DeckConstants.sol's header) — the SAME per-card half-swap
// gen-showdown-dispute.mts / gen-deck-round-trip.mts apply to the WASM's raw
// [e2X,e2Y,e1X,e1Y] masked-card tuples. `proof1`/`proof2` are the RAW verify52 proof bytes exactly
// as the WASM prover emits them (no reordering applies to proof bytes, only to deck words) — the
// contract itself re-swaps each deck's per-card halves back to the WASM's wire order when it
// builds verify52's `pi` (see ZkTable.sol's `_challengeDeck` comment on this exact swap).

import { createRequire } from 'node:module'
import { encodeAbiParameters } from 'viem'

const require = createRequire(import.meta.url)
const z = require('@zypher-game/secret-engine') as ZypherSecretEngine

interface KeyPair { sk: string; pk: string; pkxy: [string, string] }
type ZCard = [string, string, string, string] // WASM order: [e2X, e2Y, e1X, e1Y]
interface MaskedCardWithProof { card: ZCard; proof: string }
interface ShuffleOut { cards: ZCard[]; proof: string }
interface ZypherSecretEngine {
  generate_key(): KeyPair
  aggregate_keys(pubs: string[]): string
  init_prover_key(num: number): void
  refresh_joint_key(joint: string, num: number): string[]
  init_masked_cards(joint: string, num: number): MaskedCardWithProof[]
  shuffle_cards(joint: string, deck: ZCard[]): ShuffleOut
  verify_shuffled_cards(deck1: ZCard[], deck2: ZCard[], proof: string): boolean
}

const NUM = 52

// ---- Baby-JubJub (ed_on_bn254) point arithmetic, mirroring EdOnBN254.sol / gen-deck-round-trip.mts ----
const Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const E_A = 1n
const E_D = 9706598848417545097372247223557719406784115219466060233080913168975159366771n
interface Point { x: bigint; y: bigint }
function mod(a: bigint, m: bigint): bigint { const r = a % m; return r >= 0n ? r : r + m }
function modinv(a: bigint, m: bigint): bigint {
  let [oldR, r] = [mod(a, m), m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  return mod(oldS, m)
}
function padd(a1: Point, a2: Point): Point {
  if (a1.x === 0n && a1.y === 0n) return a2
  if (a2.x === 0n && a2.y === 0n) return a1
  const x1x2 = mod(a1.x * a2.x, Q)
  const y1y2 = mod(a1.y * a2.y, Q)
  const dx1x2y1y2 = mod(E_D * mod(x1x2 * y1y2, Q), Q)
  const x3Num = mod(a1.x * a2.y + a1.y * a2.x, Q)
  const y3Num = mod(y1y2 - E_A * x1x2, Q)
  const x3 = mod(x3Num * modinv(mod(1n + dx1x2y1y2, Q), Q), Q)
  const y3 = mod(y3Num * modinv(mod(1n - dx1x2y1y2, Q), Q), Q)
  return { x: x3, y: y3 }
}

function toBig(v: string): bigint { return BigInt(v) }

// WASM raw [e2X,e2Y,e1X,e1Y] per card -> ZkTable on-chain [e1.x,e1.y,e2.x,e2.y] per card.
function toZkLayout(cards: ZCard[]): bigint[] {
  const deck: bigint[] = []
  for (const [e2X, e2Y, e1X, e1Y] of cards) deck.push(toBig(e1X), toBig(e1Y), toBig(e2X), toBig(e2Y))
  return deck
}

function main() {
  const mode = process.argv[2] ?? 'honest'
  if (mode !== 'honest' && mode !== 'decoy') throw new Error(`unknown mode ${mode} (want honest|decoy)`)

  z.init_prover_key(NUM)

  const keyA = z.generate_key()
  const keyB = z.generate_key()
  const aggReal = padd(
    { x: toBig(keyA.pkxy[0]), y: toBig(keyA.pkxy[1]) },
    { x: toBig(keyB.pkxy[0]), y: toBig(keyB.pkxy[1]) },
  )
  const jointReal = z.aggregate_keys([keyA.pk, keyB.pk])
  const pkc = z.refresh_joint_key(jointReal, NUM)
  if (pkc.length !== 24) throw new Error(`pkc length ${pkc.length} != 24`)

  const masked = z.init_masked_cards(jointReal, NUM)
  const before1 = masked.map((m) => m.card) // D0, WASM order

  // seat 1: honest shuffle D0 -> deck1, under the REAL joint key.
  const step1 = z.shuffle_cards(jointReal, before1)
  const okStep1 = z.verify_shuffled_cards(before1, step1.cards, step1.proof)
  if (!okStep1) throw new Error('step1 off-chain verify_shuffled_cards returned false')

  let step2: ShuffleOut
  if (mode === 'honest') {
    // seat 2: honest shuffle deck1 -> deck2, under the SAME real joint key.
    step2 = z.shuffle_cards(jointReal, step1.cards)
    const okStep2 = z.verify_shuffled_cards(step1.cards, step2.cards, step2.proof)
    if (!okStep2) throw new Error('step2 (honest) off-chain verify_shuffled_cards returned false')
  } else {
    // seat 2: masks its contribution under an UNRELATED rogue joint key. The resulting proof is
    // real/well-formed (verifies off-chain against jointX's own refreshed pkc) but is bound to
    // pkcX, not the pinned pkcReal — on-chain verify52(proof, pi, pkcReal) must reject it.
    const rogueA = z.generate_key()
    const rogueB = z.generate_key()
    const jointX = z.aggregate_keys([rogueA.pk, rogueB.pk])
    z.refresh_joint_key(jointX, NUM) // reloads prover state to jointX/pkcX
    step2 = z.shuffle_cards(jointX, step1.cards)
    const okStep2Wasm = z.verify_shuffled_cards(step1.cards, step2.cards, step2.proof)
    if (!okStep2Wasm) throw new Error('step2 (decoy) off-chain verify_shuffled_cards returned false (must be well-formed under jointX)')
  }

  const d0 = toZkLayout(before1)
  const afterDeck1 = toZkLayout(step1.cards)
  const afterDeck2 = toZkLayout(step2.cards)
  if (d0.length !== 208 || afterDeck1.length !== 208 || afterDeck2.length !== 208) {
    throw new Error('deck length != 208')
  }

  const blob = encodeAbiParameters(
    [
      { type: 'uint256[2]' },
      { type: 'uint256[2]' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256[24]' },
      { type: 'uint256[]' },
      { type: 'uint256[]' },
      { type: 'bytes' },
      { type: 'uint256[]' },
      { type: 'bytes' },
    ],
    [
      [toBig(keyA.pkxy[0]), toBig(keyA.pkxy[1])],
      [toBig(keyB.pkxy[0]), toBig(keyB.pkxy[1])],
      aggReal.x,
      aggReal.y,
      pkc.map(toBig) as unknown as readonly bigint[],
      d0 as unknown as readonly bigint[],
      afterDeck1 as unknown as readonly bigint[],
      step1.proof as `0x${string}`,
      afterDeck2 as unknown as readonly bigint[],
      step2.proof as `0x${string}`,
    ],
  )
  process.stdout.write(blob)
}

main()

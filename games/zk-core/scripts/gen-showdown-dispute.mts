// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review (same posture as
// gen-shuffle-proof.mts / gen-card-table.mts: isolated dev/build script, not shipped in any
// package output).
//
// Generator for the on-chain ZkTable DEMAND_SHOWDOWN Foundry tests (ZkTableShowdownDispute.t.sol),
// invoked via `vm.ffi`. Produces a REAL 52-card Baby-JubJub (ed_on_bn254) masked deck under the
// joint key of two seats, plus REAL Groth16 `verifyRevealWithSnark`-compatible reveal proofs
// (via secret-engine's `reveal_card_with_snark`) for BOTH seats at BOTH of two adjacent showdown
// slots {deckIndex, deckIndex+1} — the exact 4-share bundle a HiLoWar showdown dispute needs
// (see ZkTable.sol's showdown machinery / IGameRules.showdownSlots).
//
// Usage: node gen-showdown-dispute.mts <deckIndex>
// Prints a single 0x-prefixed ABI blob:
//   (uint256[2] deckKeyA, uint256[2] deckKeyB, uint256[] deck /* 208 words */, bytes32 deckCommitment,
//    uint256[] reveals /* 8 words: 4 x [x,y] */, uint256[] proofs /* 32 words: 4 x [8] */)
// reveals/proofs are flattened (NOT nested fixed arrays — a Solidity abi.decode with multiple
// nested-fixed-array params in one tuple hits solc's Yul stack-too-deep even under viaIR), ordered
// [seatA@slotA, seatB@slotA, seatA@slotB, seatB@slotB] — 2 words per reveal, 8 words per proof.
//
// DECK LAYOUT NOTE: secret-engine's masked-card tuple is [e2X, e2Y, e1X, e1Y] (see
// zypherDeck.ts's ZCard type), but ZkTable's on-chain 208-word layout is
// deck[4s]=e1.x, deck[4s+1]=e1.y, deck[4s+2]=e2.x, deck[4s+3]=e2.y (see ZkTable.sol /
// respondWithShare's pi construction) — the two halves are SWAPPED relative to the WASM tuple.
// This script does that swap when building `deck`.
//
// This uses init_masked_cards' UNSHUFFLED deck (no shuffle_cards call): deck position i's card
// decodes to plaintext index i by construction (see gen-card-table.mts's derivation), which is
// all a showdown-dispute test needs — the shuffle proof itself is a separate, already-covered
// concern (ShuffleVerifier52.t.sol).

import { createRequire } from 'node:module'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'

const require = createRequire(import.meta.url)
const z = require('@zypher-game/secret-engine') as ZypherSecretEngine

interface KeyPair { sk: string; pk: string; pkxy: [string, string] }
type ZCard = [string, string, string, string] // [e2X, e2Y, e1X, e1Y]
interface MaskedCardWithProof { card: ZCard; proof: string }
interface SnarkReveal { card: [string, string]; snark_proof: string[] }
interface ZypherSecretEngine {
  generate_key(): KeyPair
  aggregate_keys(pubs: string[]): string
  init_prover_key(num: number): void
  init_reveal_key(): void
  refresh_joint_key(joint: string, num: number): string[]
  init_masked_cards(joint: string, num: number): MaskedCardWithProof[]
  reveal_card_with_snark(sk: string, card: ZCard): SnarkReveal
}

const NUM = 52

function toBig(v: string): bigint {
  return BigInt(v)
}

// deck[] in ZkTable's on-chain layout: swap the WASM's [e2X,e2Y,e1X,e1Y] halves to
// [e1X,e1Y,e2X,e2Y] per slot.
function buildZkTableDeck(masked: MaskedCardWithProof[]): bigint[] {
  const deck: bigint[] = []
  for (const m of masked) {
    const [e2X, e2Y, e1X, e1Y] = m.card
    deck.push(toBig(e1X), toBig(e1Y), toBig(e2X), toBig(e2Y))
  }
  return deck
}

function main() {
  const deckIndex = Number(process.argv[2] ?? '0')
  if (!Number.isInteger(deckIndex) || deckIndex < 0 || deckIndex > 50) {
    throw new Error('deckIndex must be an integer in [0, 50] (needs deckIndex+1 <= 51)')
  }
  const slotA = deckIndex
  const slotB = deckIndex + 1

  z.init_prover_key(NUM)
  z.init_reveal_key()
  const keyA = z.generate_key()
  const keyB = z.generate_key()
  const joint = z.aggregate_keys([keyA.pk, keyB.pk])
  z.refresh_joint_key(joint, NUM)
  const masked = z.init_masked_cards(joint, NUM)

  const deckWords = buildZkTableDeck(masked)
  const deckCommitment = keccak256(
    ('0x' + deckWords.map((w) => w.toString(16).padStart(64, '0')).join('')) as Hex,
  )

  const revealFor = (key: KeyPair, slot: number) => {
    const r = z.reveal_card_with_snark(key.sk, masked[slot]!.card)
    const point: [bigint, bigint] = [toBig(r.card[0]), toBig(r.card[1])]
    const proof = r.snark_proof.map(toBig)
    if (proof.length !== 8) throw new Error(`snark_proof length ${proof.length} != 8`)
    return { point, proof }
  }

  const aAtA = revealFor(keyA, slotA)
  const bAtA = revealFor(keyB, slotA)
  const aAtB = revealFor(keyA, slotB)
  const bAtB = revealFor(keyB, slotB)

  // Flattened dynamic arrays (NOT uint256[2][4]/uint256[8][4]): a Solidity abi.decode with
  // multiple nested-fixed-array parameters in one tuple hits solc's Yul "stack too deep" even
  // under viaIR. The consuming Foundry test decodes these as plain uint256[] and slices
  // [4*i, 4*i+2) / [8*i, 8*i+8) per share (order: [A@slotA, B@slotA, A@slotB, B@slotB]).
  const revealsFlat = [aAtA.point, bAtA.point, aAtB.point, bAtB.point].flat()
  const proofsFlat = [aAtA.proof, bAtA.proof, aAtB.proof, bAtB.proof].flat()

  const blob = encodeAbiParameters(
    [
      { type: 'uint256[2]' },
      { type: 'uint256[2]' },
      { type: 'uint256[]' },
      { type: 'bytes32' },
      { type: 'uint256[]' },
      { type: 'uint256[]' },
    ],
    [
      [toBig(keyA.pkxy[0]), toBig(keyA.pkxy[1])],
      [toBig(keyB.pkxy[0]), toBig(keyB.pkxy[1])],
      deckWords as unknown as readonly bigint[],
      deckCommitment,
      revealsFlat as unknown as readonly bigint[],
      proofsFlat as unknown as readonly bigint[],
    ],
  )
  process.stdout.write(blob)
}

main()

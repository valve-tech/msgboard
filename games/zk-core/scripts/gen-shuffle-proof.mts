// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review.
//
// Generates a REAL Baby-JubJub (ed_on_bn254) uzkge shuffle proof off-chain using the
// Zypher `@zypher-game/secret-engine` WASM prover, and emits a fixture that the Foundry
// `ShuffleVerifier52` positive-verify test (P6.2) feeds to the vendored on-chain verifier.
//
// This binary is GPLv3-derived (upstream zypher-game/uzkge is GPL-3.0-only; the npm package
// self-tags MIT — a genuine license ambiguity, deferred to counsel per the spec's P6.5).
// It is isolated here as a build/dev script and is NOT shipped in any package output.
//
// The prover protocol order matters (recovered empirically — see P6.1 in the spec):
//   1. init_prover_key(52)            one-time proving-key setup (~11s)
//   2. aggregate_keys([pk...])  -> joint
//   3. refresh_joint_key(joint, 52)   MUST run before shuffle_cards — loads the joint key into
//                                     prover state; skipping it makes shuffle_cards panic
//                                     ("unreachable"). Returns the 24-word `pkc` the on-chain
//                                     ShuffleVerifier52 wants.
//   4. init_masked_cards(joint, 52) -> [{ card:[e2X,e2Y,e1X,e1Y], proof }]
//   5. shuffle_cards(joint, before) where before = masked.map(m => m.card)  (BARE MaskedCard
//      4-tuples — NOT the {card,proof} objects; passing the objects is the marshalling panic).
//      -> { cards, proof }
//   6. verify_shuffled_cards(before, cards, proof) -> true  (off-chain soundness check)
//
// verify52 public inputs: pi = flatten(before) ++ flatten(after) = 416 field elements;
// pkc = refresh_joint_key output (24 words).

import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// CJS WASM module; loaded via createRequire so this stays an ESM .mts.
const z = require('@zypher-game/secret-engine') as ZypherSecretEngine

interface MaskedCardWithProof {
  card: [string, string, string, string]
  proof: string
}
interface ShuffleOut {
  cards: [string, string, string, string][]
  proof: string
}
interface KeyPair {
  sk: string
  pk: string
  pkxy: [string, string]
}
interface Reveal {
  card: [string, string]
  proof: string
}
interface ZypherSecretEngine {
  generate_key(): KeyPair
  aggregate_keys(pubs: string[]): string
  init_prover_key(num: number): void
  init_reveal_key(): void
  refresh_joint_key(joint: string, num: number): string[]
  init_masked_cards(joint: string, num: number): MaskedCardWithProof[]
  shuffle_cards(joint: string, deck: [string, string, string, string][]): ShuffleOut
  verify_shuffled_cards(
    deck1: [string, string, string, string][],
    deck2: [string, string, string, string][],
    proof: string,
  ): boolean
  reveal_card(sk: string, card: [string, string, string, string]): Reveal
  verify_revealed_card(
    pk: string,
    card: [string, string, string, string],
    reveal: Reveal,
  ): boolean
}

const NUM = 52
const NUM_PLAYERS = Number(process.env.SHUFFLE_PLAYERS ?? 2)

function main() {
  const t0 = Date.now()
  z.init_prover_key(NUM)
  const tKey = Date.now()

  const players = Array.from({ length: NUM_PLAYERS }, () => z.generate_key())
  const joint = z.aggregate_keys(players.map((p) => p.pk))

  // Load the joint key into prover state and capture the on-chain pkc (24 words).
  const pkc = z.refresh_joint_key(joint, NUM)
  if (pkc.length !== 24) throw new Error(`pkc length ${pkc.length} != 24`)

  const masked = z.init_masked_cards(joint, NUM)
  const before = masked.map((m) => m.card)

  const tShuffleStart = Date.now()
  const out = z.shuffle_cards(joint, before)
  const tShuffleEnd = Date.now()
  const after = out.cards

  // Off-chain soundness gate: the generated proof MUST verify against the WASM verifier.
  const okOffchain = z.verify_shuffled_cards(before, after, out.proof)
  if (!okOffchain) throw new Error('off-chain verify_shuffled_cards returned false — bad proof')

  // Negative control: a single-byte tamper must NOT verify off-chain.
  const tampered = out.proof.slice(0, -2) + (out.proof.endsWith('ff') ? '00' : 'ff')
  let okTamper: boolean
  try {
    okTamper = z.verify_shuffled_cards(before, after, tampered)
  } catch {
    okTamper = false // a throw is also a rejection
  }
  if (okTamper) throw new Error('tampered proof verified off-chain — soundness broken')

  const proofBytes = (out.proof.length - 2) / 2

  // pi = flatten(before) ++ flatten(after). Each card is [e2X,e2Y,e1X,e1Y] (MaskedCard order).
  const pi = [...before.flat(), ...after.flat()]
  if (pi.length !== 416) throw new Error(`pi length ${pi.length} != 416`)

  // ---- P6.4 reveal sample: a single-party Chaum-Pedersen DLEQ reveal proof on after[0] ----
  // reveal_card(sk, card) -> { card:[x,y] (reveal token), proof (160 bytes = a||b||r) }. This is
  // exactly the input to the vendored EdOnBN254 RevealVerifier.verifyReveal(pk, masked, reveal,
  // proofBytes), proving that verifier is curve-correct for our (now Baby-JubJub) reveals.
  z.init_reveal_key()
  const revealCard = after[0]
  const revealer = players[0]
  const reveal = z.reveal_card(revealer.sk, revealCard)
  const okReveal = z.verify_revealed_card(revealer.pk, revealCard, reveal)
  if (!okReveal) throw new Error('off-chain verify_revealed_card returned false')
  const revealProofBytes = (reveal.proof.length - 2) / 2
  if (revealProofBytes !== 160) throw new Error(`reveal proof ${revealProofBytes} bytes != 160`)

  const fixture = {
    _note:
      'GPLv3 via @zypher-game/secret-engine@0.3.0 — PoC fixture, pending license review. ' +
      'Real Baby-JubJub uzkge shuffle proof generated off-chain; verified true off-chain by ' +
      'verify_shuffled_cards and (P6.2) on-chain by the vendored ShuffleVerifier52.verify52. ' +
      'The reveal.* fields (P6.4) are a single-party reveal_card DLEQ proof for the vendored ' +
      'EdOnBN254 RevealVerifier.verifyReveal.',
    numPlayers: NUM_PLAYERS,
    joint,
    pkc,
    before,
    after,
    pi,
    proof: out.proof,
    offchainVerify: okOffchain,
    reveal: {
      pk: revealer.pkxy, // EdOnBN254 affine pubkey (x, y)
      masked: revealCard, // [e2X, e2Y, e1X, e1Y]
      token: reveal.card, // reveal-token point (x, y)
      proof: reveal.proof, // 160 bytes: a(64) || b(64) || r(32)
      offchainVerify: okReveal,
    },
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = resolve(here, '../../../games/contracts/test/fixtures/zypher-shuffle52-gen.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(fixture, null, 1) + '\n')

  console.log(`init_prover_key(52): ${((tKey - t0) / 1000).toFixed(2)}s`)
  console.log(`shuffle_cards:       ${((tShuffleEnd - tShuffleStart) / 1000).toFixed(2)}s`)
  console.log(`players: ${NUM_PLAYERS}  proof: ${proofBytes} bytes  pi: ${pi.length}  pkc: ${pkc.length}`)
  console.log(`off-chain verify: ${okOffchain}  tamper-rejected: ${!okTamper}`)
  console.log(`wrote ${outPath}`)
}

main()

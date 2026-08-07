// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review (same posture as
// gen-showdown-dispute.mts / gen-deck-constants.mts: isolated dev/build script, not shipped in
// any package output).
//
// Round-trip fixture generator for test/foundry/DeckConstants.t.sol (invoked via vm.ffi). Picks a
// FRESH random 2-party joint key, computes its raw affine aggregate (aggX, aggY) with this
// script's own Baby-JubJub point arithmetic, calls the REAL Zypher init_masked_cards(joint, 52)
// for that same joint key, and emits the resulting 208-word ZkTable-layout deck alongside
// (aggX, aggY) — so the Foundry test can assert DeckConstants.initialDeck(agg) reproduces this
// deck word-for-word. This is the test that guarantees the DeckConstants word LAYOUT (not just
// the M_i values) is right.
//
// deck[] word layout: swap the WASM's [e2X,e2Y,e1X,e1Y] card tuple to ZkTable's on-chain
// [e1X,e1Y,e2X,e2Y] per slot — identical convention to gen-showdown-dispute.mts's
// buildZkTableDeck (see ZkTable.sol's respondWithShare/_verifyAndStoreReveal pi construction).
//
// Usage: node gen-deck-round-trip.mts
// Prints a single 0x-prefixed ABI blob: (uint256 aggX, uint256 aggY, uint256[] deck /* 208 */)

import { createRequire } from 'node:module'
import { encodeAbiParameters } from 'viem'

const require = createRequire(import.meta.url)
const z = require('@zypher-game/secret-engine') as ZypherSecretEngine

interface KeyPair { sk: string; pk: string; pkxy: [string, string] }
type ZCard = [string, string, string, string] // [e2X, e2Y, e1X, e1Y]
interface MaskedCardWithProof { card: ZCard; proof: string }
interface ZypherSecretEngine {
  generate_key(): KeyPair
  aggregate_keys(pubs: string[]): string
  init_prover_key(num: number): void
  init_reveal_key(): void
  refresh_joint_key(joint: string, num: number): string[]
  init_masked_cards(joint: string, num: number): MaskedCardWithProof[]
}

const NUM = 52

// ---- Baby-JubJub (ed_on_bn254) point arithmetic, mirroring EdOnBN254.sol exactly ----
const Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const E_A = 1n
const E_D = 9706598848417545097372247223557719406784115219466060233080913168975159366771n

interface Point { x: bigint; y: bigint }

function mod(a: bigint, m: bigint): bigint {
  const r = a % m
  return r >= 0n ? r : r + m
}
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
  z.init_prover_key(NUM)
  z.init_reveal_key()

  const keyA = z.generate_key()
  const keyB = z.generate_key()
  const agg = padd(
    { x: toBig(keyA.pkxy[0]), y: toBig(keyA.pkxy[1]) },
    { x: toBig(keyB.pkxy[0]), y: toBig(keyB.pkxy[1]) },
  )

  const joint = z.aggregate_keys([keyA.pk, keyB.pk])
  z.refresh_joint_key(joint, NUM)
  const masked = z.init_masked_cards(joint, NUM)
  const deckWords = buildZkTableDeck(masked)
  if (deckWords.length !== 208) throw new Error(`deck length ${deckWords.length} != 208`)

  const blob = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[]' }],
    [agg.x, agg.y, deckWords as unknown as readonly bigint[]],
  )
  process.stdout.write(blob)
}

main()

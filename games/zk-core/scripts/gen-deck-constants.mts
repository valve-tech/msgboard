// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review (same posture as
// gen-shuffle-proof.mts / gen-card-table.mts / zypherDeck.ts: isolated dev/build script, not
// shipped in any package output). The 52 output points are the uzkge protocol's fixed
// plaintext-card encoding table — intrinsic mathematical constants, not creative content — but
// flagged here for consistency.
//
// Generates contracts/zk/DeckConstants.sol: the on-chain CANONICAL INITIAL (unshuffled) masked
// deck for ZkTable's dispute-time deck-key-binding design (spec deckkey-binding-spec.md, B4).
//
// STRUCTURE (empirically confirmed by THIS script, every run — see the assertions below, not
// just asserted from the design doc):
//   Zypher's initial (unshuffled) masked deck, as returned by init_masked_cards(agg, 52), is
//   DETERMINISTIC per joint key `agg` in a very specific way:
//     - e1_i == G (the fixed EdOnBN254 generator) for ALL 52 cards, for EVERY joint key agg.
//     - e2_i == M_i (+) agg, where M_i is a FIXED per-slot Baby-JubJub point, IDENTICAL no matter
//       which agg was used to mask the deck.
//   Equivalently: the ElGamal masking randomness r is the constant 1 for every card, every slot,
//   every joint key — Zypher does not re-randomize the initial deck's masking. This means the
//   on-chain contract can recompute the ENTIRE initial masked deck for ANY joint key agg from 52
//   hardcoded constants + 52 point-additions, with no proof and no off-chain input beyond agg
//   itself. That is exactly what DeckConstants.initialDeck(agg) below does.
//
// EMPIRICAL METHOD (this script, not trusted from prose):
//   1. Derive M_i under TWO independently-generated joint keys — a 2-party aggregate (k1+k2) and
//      an unrelated single-key aggregate (k3) — by computing M_i = e2_i (-) agg using this
//      script's own Baby-JubJub point arithmetic (mirroring EdOnBN254.sol exactly).
//   2. Assert e1_i == G for all 104 (52 x 2 runs) cards.
//   3. Assert the two runs' M_i tables are IDENTICAL, index-for-index — this is the actual proof
//      of agg-independence (r=1): if masking used any agg-dependent or per-card random r, the
//      two runs' subtracted tables would not agree.
//   4. Cross-check M_0 against the ANCHOR_M0 constant independently derived in
//      gen-card-table.mts (a DIFFERENT extraction method: reveal_card share-subtraction, not
//      direct agg-subtraction) — three independent derivations converging on the same table is
//      strong evidence the table itself, not just this script's arithmetic, is correct.
//   5. Assert all 52 x-coordinates are unique before writing anything, so a drifted/broken
//      engine install fails loudly instead of emitting a bad table.
//
// The point arithmetic mirrors contracts/vendor/uzkge/libraries/EdOnBN254.sol exactly (same
// field Q, curve params E_A/E_D, generator G, and the same twisted-Edwards affine addition
// formula), reimplemented here in BigInt so this script has no Solidity/FFI dependency.
//
// Usage:
//   npx tsx scripts/gen-deck-constants.mts          # writes contracts/zk/DeckConstants.sol
//
// Engine version: @zypher-game/secret-engine@0.3.0 (pinned in zk-core/package.json). Regenerate
// (and re-verify the anchor + cross-run checks below) whenever that pin changes.

import { createRequire } from 'node:module'
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const G_X = 0x2b8cfd91b905cae31d41e7dedf4a927ee3bc429aad7e344d59d2810d82876c32n
const G_Y = 0x2aaa6c24a758209e90aced1f10277b762a7c1115dbc0e16ac276fc2c671a861fn

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
function pneg(a: Point): Point {
  if (a.x === 0n && a.y === 0n) return a
  return { x: mod(-a.x, Q), y: a.y }
}
function hex32(v: bigint): string {
  return '0x' + v.toString(16).padStart(64, '0')
}

const ANCHOR_M0: Point = {
  x: 0x23118ac889f6ac9172ea3e80a3741abe2cebce374cc96a6d98bfa132cd2b1e97n,
  y: 0x0e7e20b3cb30785b64cd6972e2ddf919db64d03d6cf01456243c5ef2fb766a65n,
}

/** Aggregates raw affine pubkeys with this script's own (EdOnBN254-mirroring) point addition. */
function aggregateXY(keys: KeyPair[]): Point {
  let agg: Point = { x: 0n, y: 1n } // EdOnBN254 identity
  for (const k of keys) agg = padd(agg, { x: BigInt(k.pkxy[0]), y: BigInt(k.pkxy[1]) })
  return agg
}

/**
 * Derives the initial masked deck under `keys`' aggregate and returns (agg, e1s, Ms) where
 * Ms[i] = e2_i (-) agg — the candidate canonical card point for slot i.
 */
function deriveRun(keys: KeyPair[]): { agg: Point; e1s: Point[]; Ms: Point[] } {
  const agg = aggregateXY(keys)
  const joint = z.aggregate_keys(keys.map((k) => k.pk))
  z.refresh_joint_key(joint, NUM)
  const masked = z.init_masked_cards(joint, NUM)
  const e1s: Point[] = []
  const Ms: Point[] = []
  for (let i = 0; i < NUM; i++) {
    const card = masked[i]!.card
    const e2: Point = { x: BigInt(card[0]), y: BigInt(card[1]) }
    const e1: Point = { x: BigInt(card[2]), y: BigInt(card[3]) }
    e1s.push(e1)
    Ms.push(padd(e2, pneg(agg)))
  }
  return { agg, e1s, Ms }
}

function renderSolidity(points: Point[]): string {
  const words: string[] = []
  for (const p of points) words.push(hex32(p.x), hex32(p.y))
  // 4 words per line for readability (104 words / 4 = 26 lines).
  const lines: string[] = []
  for (let i = 0; i < words.length; i += 4) {
    lines.push('            ' + words.slice(i, i + 4).join(', ') + (i + 4 < words.length ? ',' : ''))
  }

  return `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EdOnBN254} from "../vendor/uzkge/libraries/EdOnBN254.sol";

/// @notice GENERATED — do not hand-edit the M table; regenerate via
/// games/zk-core/scripts/gen-deck-constants.mts (pins the zypher-game secret-engine npm package,
/// version 0.3.0). NOTE: this NatSpec deliberately avoids writing the npm scope name verbatim
/// with its leading at-sign — solc's NatSpec parser treats a leading at-sign as a doc-tag and
/// rejects unknown ones at the contract level (error 6546).
///
/// On-chain CANONICAL INITIAL (unshuffled) masked deck for ZkTable's deck-key-binding dispute
/// path (deckkey-binding-spec.md, B4). Zypher's init_masked_cards(agg, 52) output is deterministic
/// in a specific way, empirically confirmed by the regen script (run under two unrelated
/// aggregates, both e1==G and both M-tables identical): the masking randomness r is the constant
/// 1 for every card, every slot, every joint key agg — so e1_i == G (the fixed EdOnBN254
/// generator) always, and e2_i == M_i (+) agg where M_i is this FIXED per-slot point, independent
/// of agg. That lets this contract recompute the entire 208-word initial deck for ANY joint key
/// from just these 52 hardcoded points plus 52 point-additions (~52 EdOnBN254.add calls), with no
/// proof and no off-chain input beyond agg itself.
///
/// M_i here is the SAME canonical per-slot plaintext-card point table as
/// contracts/vendor/uzkge/CardTable52.sol (that file's decode table was derived independently, by
/// subtracting a reveal_card share rather than the raw aggregate — the two derivations agree,
/// which is itself part of the confirmation this table is correct; see gen-deck-constants.mts's
/// header for the cross-check).
///
/// Word layout of initialDeck's uint256[208] output MUST match what ZkTable._verifyAndStoreReveal
/// / ShowdownDecodeLib consume: per card i, deck[4i]=e1.x, deck[4i+1]=e1.y, deck[4i+2]=e2.x,
/// deck[4i+3]=e2.y (i.e. [c1.x, c1.y, c2.x, c2.y] in the seam's naming — c1 is the ElGamal
/// ephemeral, c2 the message-bearing point). This is verified byte-for-byte against a live
/// Zypher-generated deck in test/foundry/DeckConstants.t.sol (FOUNDRY_PROFILE=ffi).
library DeckConstants {
    uint256 internal constant DECK_SIZE = 52;
    uint256 internal constant DECK_WORDS = 208;

    /// @dev The 52 fixed per-slot card points M_i (i = 0..51), flattened [x0,y0,x1,y1,...],
    /// in the SAME canonical order as CardTable52 / init_masked_cards's unshuffled deck position
    /// i (deck position i decodes to plaintext card index i).
    function _points() private pure returns (uint256[104] memory p) {
        p = [
${lines.join('\n')}
        ];
    }

    /// @notice Recomputes the canonical initial (unshuffled) masked deck under joint key \`agg\`.
    /// For each card i: e1 = G (fixed generator), e2 = M_i (+) agg. ~52 EdOnBN254.add calls.
    function initialDeck(EdOnBN254.Point memory agg) internal view returns (uint256[208] memory deck) {
        uint256[104] memory pts = _points();
        EdOnBN254.Point memory g = EdOnBN254.generator();
        for (uint256 i = 0; i < DECK_SIZE; i++) {
            EdOnBN254.Point memory m = EdOnBN254.Point(pts[2 * i], pts[2 * i + 1]);
            EdOnBN254.Point memory e2 = EdOnBN254.add(m, agg);
            uint256 base = 4 * i;
            deck[base] = g.x;
            deck[base + 1] = g.y;
            deck[base + 2] = e2.x;
            deck[base + 3] = e2.y;
        }
    }
}
`
}

function main() {
  z.init_prover_key(NUM)
  z.init_reveal_key()

  const k1 = z.generate_key()
  const k2 = z.generate_key()
  const k3 = z.generate_key()

  // Two unrelated aggregates: a 2-party sum and an unrelated single key.
  const run1 = deriveRun([k1, k2])
  const run2 = deriveRun([k3])

  // ---- Empirical structure confirmation (fails loudly, not just asserted from prose) ----
  for (let i = 0; i < NUM; i++) {
    if (run1.e1s[i]!.x !== G_X || run1.e1s[i]!.y !== G_Y) {
      throw new Error(`run1 card ${i}: e1 != G — structure assumption FALSE`)
    }
    if (run2.e1s[i]!.x !== G_X || run2.e1s[i]!.y !== G_Y) {
      throw new Error(`run2 card ${i}: e1 != G — structure assumption FALSE`)
    }
  }
  for (let i = 0; i < NUM; i++) {
    if (run1.Ms[i]!.x !== run2.Ms[i]!.x || run1.Ms[i]!.y !== run2.Ms[i]!.y) {
      throw new Error(
        `card ${i}: M_i differs between two unrelated aggregates — agg-independence (r=1) FALSE`,
      )
    }
  }
  if (run1.Ms[0]!.x !== ANCHOR_M0.x || run1.Ms[0]!.y !== ANCHOR_M0.y) {
    throw new Error(
      `M_0 anchor mismatch (cross-check vs gen-card-table.mts's independent reveal-based ` +
        `derivation) — secret-engine output does not match the pinned 0.3.0 table. Got ` +
        `(${hex32(run1.Ms[0]!.x)}, ${hex32(run1.Ms[0]!.y)}), expected (${hex32(ANCHOR_M0.x)}, ${hex32(ANCHOR_M0.y)}).`,
    )
  }
  const xs = new Set(run1.Ms.map((p) => p.x.toString()))
  if (xs.size !== 52) throw new Error(`x-coordinates not unique: only ${xs.size} of 52 distinct`)

  // Cross-check every M_i against the checked-in CardTable52.sol (independently generated via
  // reveal_card share-subtraction, not raw agg-subtraction) — a fourth independent confirmation.
  const here = dirname(fileURLToPath(import.meta.url))
  const cardTablePath = resolve(here, '../../contracts/contracts/vendor/uzkge/CardTable52.sol')
  const cardTableSrc = readFileSync(cardTablePath, 'utf8')
  const re = /if \(x == (0x[0-9a-fA-F]+)\) \{\s*\n\s*return \(y == (0x[0-9a-fA-F]+), (\d+)\);/g
  const fromCardTable: Point[] = new Array(NUM)
  let match: RegExpExecArray | null
  let count = 0
  while ((match = re.exec(cardTableSrc)) !== null) {
    const idx = Number(match[3])
    fromCardTable[idx] = { x: BigInt(match[1]!), y: BigInt(match[2]!) }
    count++
  }
  if (count !== NUM) throw new Error(`CardTable52.sol parse: found ${count} entries, expected ${NUM}`)
  for (let i = 0; i < NUM; i++) {
    if (fromCardTable[i]!.x !== run1.Ms[i]!.x || fromCardTable[i]!.y !== run1.Ms[i]!.y) {
      throw new Error(`card ${i}: M_i disagrees with checked-in CardTable52.sol — investigate`)
    }
  }

  const outPath = resolve(here, '../../contracts/contracts/zk/DeckConstants.sol')
  writeFileSync(outPath, renderSolidity(run1.Ms))

  // eslint-disable-next-line no-console
  console.log('empirical structure confirmation:')
  console.log('  e1 == G for all 52 cards, both unrelated aggregates: PASS')
  console.log('  M_i identical across two unrelated aggregates (r=1, agg-independent): PASS')
  console.log('  M_0 anchor matches gen-card-table.mts independent derivation: PASS')
  console.log('  all 52 M_i x-coordinates unique: PASS')
  console.log('  M_i matches checked-in CardTable52.sol (4th independent cross-check): PASS')
  console.log(`wrote ${outPath}`)
}

main()

// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review (same posture as
// gen-shuffle-proof.mts / zypherDeck.ts: isolated dev/build script, not shipped in any package
// output). The 52 output points are the uzkge protocol's fixed plaintext-card encoding table —
// intrinsic mathematical constants, not creative content — but flagged here for consistency.
//
// Dumps the 52 canonical Baby-JubJub (ed_on_bn254) plaintext points the uzkge encoding maps
// card indices 0..51 onto, and either:
//   (default)   generates contracts/vendor/uzkge/CardTable52.sol (52 hardcoded points + a
//               linear-scan decode(x,y) -> index), OR
//   (--json)    prints an ABI-encoded `uint256[104]` blob (index i -> words [2i, 2i+1] = x, y)
//               to stdout for the Foundry decode-parity test (CardTable52.t.sol) to `vm.ffi`
//               against the CHECKED-IN library — the tripwire against secret-engine version
//               drift the design calls for: this script re-derives the table from whatever
//               @zypher-game/secret-engine is installed, live, every time it runs.
//
// DERIVATION METHOD. init_masked_cards(joint, 52) returns the 52-card deck in canonical index
// order, each card masked under a single-key "joint" (aggregate_keys([pk]) with one key — so a
// single share fully decrypts it). M_i = e2_i - reveal_i, where reveal_i = sk*e1_i is obtained
// via the FAST Chaum-Pedersen `reveal_card` (not the slow `reveal_card_with_snark` — both derive
// the identical reveal POINT; only the proof scheme differs, and we don't need a proof here).
// The point subtraction uses the same twisted-Edwards addition formula as the vendored Solidity
// EdOnBN254 library (contracts/vendor/uzkge/libraries/EdOnBN254.sol), reimplemented here in
// BigInt so this script has no Solidity/FFI dependency.
//
// Sanity anchor (from the design pass): M_0 must equal
//   (0x23118ac889f6ac9172ea3e80a3741abe2cebce374cc96a6d98bfa132cd2b1e97,
//    0x0e7e20b3cb30785b64cd6972e2ddf919db64d03d6cf01456243c5ef2fb766a65)
// This script asserts that anchor and that all 52 x-coordinates are unique before writing
// anything, so a drifted/broken engine install fails loudly instead of emitting a bad table.
//
// Usage:
//   npx tsx gen-card-table.mts            # writes contracts/vendor/uzkge/CardTable52.sol
//   npx tsx gen-card-table.mts --json     # prints the ABI blob to stdout (no file writes)

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeAbiParameters } from 'viem'

const require = createRequire(import.meta.url)
const z = require('@zypher-game/secret-engine') as ZypherSecretEngine

interface KeyPair { sk: string; pk: string; pkxy: [string, string] }
type ZCard = [string, string, string, string] // [e2X, e2Y, e1X, e1Y]
interface MaskedCardWithProof { card: ZCard; proof: string }
interface Reveal { card: [string, string]; proof: string }
interface ZypherSecretEngine {
  generate_key(): KeyPair
  aggregate_keys(pubs: string[]): string
  init_prover_key(num: number): void
  init_reveal_key(): void
  refresh_joint_key(joint: string, num: number): string[]
  init_masked_cards(joint: string, num: number): MaskedCardWithProof[]
  reveal_card(sk: string, card: ZCard): Reveal
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

/** Derives the 52 canonical plaintext points, in index order, from the installed engine. */
function derivePoints(): Point[] {
  z.init_prover_key(NUM)
  z.init_reveal_key()
  const key = z.generate_key()
  const joint = z.aggregate_keys([key.pk])
  z.refresh_joint_key(joint, NUM)
  const masked = z.init_masked_cards(joint, NUM)

  const points: Point[] = []
  for (let i = 0; i < NUM; i++) {
    const card = masked[i]!.card
    const e2: Point = { x: BigInt(card[0]), y: BigInt(card[1]) }
    const rc = z.reveal_card(key.sk, card)
    const reveal: Point = { x: BigInt(rc.card[0]), y: BigInt(rc.card[1]) }
    points.push(padd(e2, pneg(reveal)))
  }
  return points
}

function renderSolidity(points: Point[]): string {
  const branches = points
    .map((p, i) => {
      return `        if (x == ${hex32(p.x)}) {\n            return (y == ${hex32(p.y)}, ${i});\n        }`
    })
    .join('\n')

  return `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice GENERATED — do not hand-edit. Regenerate via
/// games/zk-core/scripts/gen-card-table.mts (pins the zypher-game secret-engine npm package,
/// version 0.3.0). NOTE: this NatSpec deliberately avoids writing the npm scope name verbatim
/// with its leading at-sign — solc's NatSpec parser treats a leading at-sign as a doc-tag and
/// rejects unknown ones at the contract level (error 6546).
///
/// Fixed 52-point plaintext-card decode table for the uzkge Baby-JubJub (ed_on_bn254) deck
/// encoding. Each entry is the canonical unmasked ElGamal-plaintext point for card index i
/// (0..51), i.e. what \`e2 - (revealA + revealB)\` decrypts to at a fully-revealed slot. This is
/// NOT (i+1)*G — it is a fixed table intrinsic to the uzkge protocol, sourced by dumping
/// secret-engine's own init_masked_cards/reveal_card outputs (see the generator's header for the
/// derivation and its self-checks: all 52 x-coordinates unique, M_0 anchor match).
///
/// decode() matches on x (unique across all 52 entries) then checks the paired y, returning
/// ok=false (NOT reverting) on no match OR a mismatched y. Non-reverting is deliberate: a
/// showdown decrypt can legitimately land on a non-table point (a decoy deck key, or any
/// off-curve garbage a malicious seat's registered key produces) and the caller
/// (ShowdownDecodeLib / ZkTable.finalizeShowdown) must be able to branch on that — fall back to
/// splitting the pot — rather than have the whole finalize revert and strand funds.
library CardTable52 {
    function decode(uint256 x, uint256 y) internal pure returns (bool ok, uint8 card) {
${branches}
        return (false, 0);
    }
}
`
}

function main() {
  const jsonMode = process.argv.includes('--json')
  const points = derivePoints()

  if (points[0]!.x !== ANCHOR_M0.x || points[0]!.y !== ANCHOR_M0.y) {
    throw new Error(
      `M_0 anchor mismatch — secret-engine output does not match the pinned 0.3.0 table. ` +
        `Got (${hex32(points[0]!.x)}, ${hex32(points[0]!.y)}), expected (${hex32(ANCHOR_M0.x)}, ${hex32(ANCHOR_M0.y)}).`,
    )
  }
  const xs = new Set(points.map((p) => p.x.toString()))
  if (xs.size !== 52) throw new Error(`x-coordinates not unique: only ${xs.size} of 52 distinct`)

  if (jsonMode) {
    const words: bigint[] = []
    for (const p of points) words.push(p.x, p.y)
    const blob = encodeAbiParameters([{ type: 'uint256[104]' }], [words as unknown as readonly bigint[]])
    process.stdout.write(blob)
    return
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = resolve(here, '../../contracts/contracts/vendor/uzkge/CardTable52.sol')
  writeFileSync(outPath, renderSolidity(points))
  // eslint-disable-next-line no-console
  console.log(`wrote ${outPath} (52 points, M_0 anchor OK, all x unique)`)
}

main()

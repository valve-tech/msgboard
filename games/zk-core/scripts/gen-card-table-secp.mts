// Generator for the on-chain secp256k1 card-point decode table used by HoldemTableN's
// showdown decode path (CardTableSecp.sol). Mirrors games/zk-core/scripts/gen-card-table.mts
// in shape (self-checked codegen -> a "GENERATED, do not hand-edit" Solidity library with a
// non-reverting matchCard(x,y) linear scan), but this table is NOT the uzkge Baby-JubJub table —
// it is the plain secp256k1 table src/elgamal.ts already defines and uses off-chain:
//   cardPoint(i) = (i+1)*G                              (elgamal.ts :24-25)
//   CARD_TABLE[i] = cardPoint(i).toHex(true)  (compressed, 33-byte hex)   (elgamal.ts :26)
//
// NOTE: the lookup function is named `matchCard`, NOT `match` — `match` is a reserved keyword
// in Solidity (>=0.8.0, held for a future pattern-matching feature) and a library function
// literally named `match` fails to compile (solc error 2314, "Expected identifier but got
// reserved keyword").
//
// This script recomputes the same 52 points independently (via @noble/curves secp256k1, the
// SAME library elgamal.ts uses) and asserts its own output byte-equals elgamal.ts's CARD_TABLE
// before emitting anything — so a future change to elgamal.ts's card-indexing convention (or a
// bug in this generator) fails loudly here instead of silently desyncing the on-chain decode
// table from the off-chain protocol every showdown relies on.
//
// Self-checks (all must pass or the script throws before writing):
//   1. All 52 x-coordinates are pairwise unique (matchCard(x,y) below relies on x alone to
//      locate a candidate row before checking y).
//   2. Each of the 52 computed points' compressed-hex encoding byte-equals elgamal.ts's
//      CARD_TABLE[i], for every i in 0..51.
//
// Usage:
//   npx tsx gen-card-table-secp.mts            # writes contracts/contracts/zk/CardTableSecp.sol
//   npx tsx gen-card-table-secp.mts --json     # prints an ABI-encoded uint256[104] blob to
//                                                stdout (index i -> words [2i, 2i+1] = x, y),
//                                                for a Foundry vm.ffi round-trip test.

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secp256k1 } from '@noble/curves/secp256k1'
import { encodeAbiParameters } from 'viem'
import { cardPoint } from '../src/elgamal.ts'

const NUM = 52

interface AffinePoint {
  x: bigint
  y: bigint
}

/** Recomputes the 52 canonical (i+1)*G points, independently of elgamal.ts's cached table. */
function derivePoints(): AffinePoint[] {
  const points: AffinePoint[] = []
  for (let i = 0; i < NUM; i++) {
    const p = secp256k1.Point.BASE.multiply(BigInt(i + 1)).toAffine()
    points.push({ x: p.x, y: p.y })
  }
  return points
}

function hex32(v: bigint): string {
  return '0x' + v.toString(16).padStart(64, '0')
}

function renderSolidity(points: AffinePoint[]): string {
  const branches = points
    .map((p, i) => {
      return `        if (x == ${hex32(p.x)}) {\n            return (y == ${hex32(p.y)}, ${i});\n        }`
    })
    .join('\n')

  return `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice GENERATED — do not hand-edit. Regenerate via
/// games/zk-core/scripts/gen-card-table-secp.mts. NOTE: this NatSpec deliberately avoids
/// writing the npm scope name of any dependency verbatim with a leading at-sign — solc's
/// NatSpec parser treats a leading at-sign as a doc-tag and rejects unknown ones at the
/// contract level (error 6546); see CardTable52.sol for the precedent this mirrors.
///
/// Fixed 52-point plaintext-card decode table for HoldemTableN's showdown-share decode over
/// secp256k1 — the SAME curve games/zk-core/src/elgamal.ts uses off-chain (NOT the uzkge
/// Baby-JubJub/ed_on_bn254 table in vendor/uzkge/CardTable52.sol, which is a different curve
/// for a different table). Card index i (0..51) maps to point (i+1)*G, matching
/// elgamal.ts's \`cardPoint(i)\`. This is what a showdown slot decrypts to once
/// c2 - sum(decryption shares) is fully unmasked.
///
/// matchCard() finds the row by x (unique across all 52 entries) then checks the paired y,
/// returning ok=false (NOT reverting) on no match OR a mismatched y. Non-reverting is
/// deliberate: a showdown decrypt can legitimately land on a non-table point (a decoy/garbage
/// masking key from a malicious seat, or (0,0) for a missing share) and the caller
/// (HoldemShowdownLib / HoldemTableN's finalize path) must be able to branch on that — fall
/// back to a split/void outcome — rather than have the whole finalize revert and strand funds.
/// (Named \`matchCard\`, not \`match\` — the latter is a reserved Solidity keyword.)
library CardTableSecp {
    function matchCard(uint256 x, uint256 y) internal pure returns (bool ok, uint8 card) {
${branches}
        return (false, 0);
    }
}
`
}

function main() {
  const jsonMode = process.argv.includes('--json')
  const points = derivePoints()

  // Self-check 1: all 52 x-coordinates pairwise unique.
  const xs = new Set(points.map((p) => p.x.toString()))
  if (xs.size !== NUM) {
    throw new Error(`x-coordinates not unique: only ${xs.size} of ${NUM} distinct`)
  }

  // Self-check 2: byte-equal against elgamal.ts's own CARD_TABLE (compressed-hex encoding),
  // recomputed here via cardPoint(i) directly rather than re-deriving compression by hand, so
  // this check is purely "does this script's independent (i+1)*G computation agree with
  // elgamal.ts's cached table" — a genuine cross-check, not a tautology, since the point
  // arithmetic path (raw secp256k1.Point.BASE.multiply + toAffine) differs from cardPoint's
  // (G.multiply then whatever internal representation noble keeps).
  for (let i = 0; i < NUM; i++) {
    const want = cardPoint(i).toHex(true)
    const got = secp256k1.Point.fromAffine(points[i]!).toHex(true)
    if (got !== want) {
      throw new Error(
        `card ${i}: computed point does not byte-match elgamal.ts CARD_TABLE. ` +
          `got 0x${got}, want 0x${want}`,
      )
    }
  }

  if (jsonMode) {
    const words: bigint[] = []
    for (const p of points) words.push(p.x, p.y)
    const blob = encodeAbiParameters([{ type: 'uint256[104]' }], [words as unknown as readonly bigint[]])
    process.stdout.write(blob)
    return
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = resolve(here, '../../contracts/contracts/zk/CardTableSecp.sol')
  writeFileSync(outPath, renderSolidity(points))
  // eslint-disable-next-line no-console
  console.log(`wrote ${outPath} (52 points, byte-match vs elgamal.ts CARD_TABLE OK, all x unique)`)
}

main()

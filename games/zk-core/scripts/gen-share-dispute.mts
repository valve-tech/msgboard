/**
 * Generator for the on-chain SHARE-dispute Foundry test (HoldemShareDispute.t.sol), invoked
 * via `vm.ffi`. Produces a REAL secp256k1 masked deck + a REAL Chaum–Pedersen decryption
 * share proof from the live `@msgboard/zk-cards-core` crypto, bound to a runtime (tableId, slot).
 *
 * Usage: node gen-share-dispute.mts <tableIdHex 0x..32B> <slot> <nSeats> <demandSeat>
 * Prints a single 0x-prefixed ABI blob:
 *   (bytes32 deckCommitment, uint256[2] pk, uint256[2] share, uint256[5] proof, uint256[] deck)
 * where deck is [c1.x,c1.y,c2.x,c2.y] per card and proof is [t1.x,t1.y,t2.x,t2.y,z].
 */
import { encodeAbiParameters, keccak256, concatHex, type Hex } from 'viem'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  maskCard, decryptionShare, pubKeyOf, aggregatePubKeys, serializePoint,
} from '../src/elgamal.ts'
import { proveShare } from '../src/chaumPedersen.ts'

const Pt = secp256k1.Point

// On-chain mirror: HoldemTableN._deckHash hashes the same compressed (c1,c2) wire points.
function deckCommitment(deck: { c1: Hex; c2: Hex }[]): Hex {
  return keccak256(concatHex(deck.flatMap((m) => [m.c1, m.c2])))
}

function ctxFor(tableId: Hex, slot: number): string {
  return `holdem/${tableId}/slot/${slot}`
}

function affine(pHex: Hex): [bigint, bigint] {
  const a = Pt.fromHex(pHex.slice(2)).toAffine()
  return [a.x, a.y]
}

function main() {
  const [tableIdArg, slotArg, nArg, demandArg] = process.argv.slice(2)
  const tableId = tableIdArg as Hex
  const slot = Number(slotArg)
  const nSeats = Number(nArg)
  const demandSeat = Number(demandArg)

  // N seat deck keypairs; deterministic-ish so reruns are reproducible enough.
  const sks = Array.from({ length: nSeats }, (_, i) => (BigInt(i + 1) * 0x9e3779b97f4a7c15n) % secp256k1.Point.Fn.ORDER)
  const pks = sks.map((sk) => pubKeyOf(sk))
  const agg = aggregatePubKeys(pks)

  // A real 52-card masked deck under the joint key.
  const deck = Array.from({ length: 52 }, (_, i) =>
    ((m) => ({ c1: serializePoint(m.c1), c2: serializePoint(m.c2) }))(maskCard(agg, i, (BigInt(i) * 0x1234567n + 0x99n) % secp256k1.Point.Fn.ORDER)),
  )
  const commit = deckCommitment(deck)

  // demandSeat's correct share + proof for `slot`.
  const sk = sks[demandSeat]!
  const pk = pks[demandSeat]!
  const m = { c1: Pt.fromHex(deck[slot]!.c1.slice(2)), c2: Pt.fromHex(deck[slot]!.c2.slice(2)) }
  const d = decryptionShare(sk, m)
  const ctx = ctxFor(tableId, slot)
  const proof = proveShare(sk, m, ctx)

  const pkAff = affine(serializePoint(pk))
  const shareAff = affine(serializePoint(d))
  const t1Aff = affine(proof.t1)
  const t2Aff = affine(proof.t2)
  const z = BigInt(proof.z)

  const deckWords: bigint[] = []
  for (const c of deck) {
    const c1 = affine(c.c1)
    const c2 = affine(c.c2)
    deckWords.push(c1[0], c1[1], c2[0], c2[1])
  }

  const blob = encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint256[2]' },
      { type: 'uint256[2]' },
      { type: 'uint256[5]' },
      { type: 'uint256[]' },
    ],
    [
      commit,
      [pkAff[0], pkAff[1]],
      [shareAff[0], shareAff[1]],
      [t1Aff[0], t1Aff[1], t2Aff[0], t2Aff[1], z],
      deckWords,
    ],
  )
  process.stdout.write(blob)
}

main()

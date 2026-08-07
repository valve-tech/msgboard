// Deck-key binding — the off-chain (TypeScript) half of deckkey-binding-spec.md §B2/§B3 and
// wave2-contract-blueprint.md §3/§8. Two responsibilities:
//
//   1. TRANSCRIPT BUILDER (`buildDealBinding`): given the real shuffle chain (each seat's
//      before/after deck + its verify52 proof), build the ordered `Step[]` and compute the two
//      values that get co-signed into `ChannelState` at DEAL: `jointKeyCommit` and
//      `shuffleRoot`. These are pure encodings — no crypto verification here.
//
//   2. VALIDATE-BEFORE-SIGN GUARD (`verifyDealBinding`): the hard client obligation from spec
//      §B3 — before co-signing a DEAL, a client MUST independently recompute the joint key from
//      the REGISTERED deck keys, recompute the canonical initial deck D0, replay the hash chain
//      D0 → … → deckCommitment, and run verify52 off-chain on every step. ANY mismatch is a
//      clear reject. This is what stands between a client and co-signing a decoy deck.
//
// ENCODING PINS (must match wave2-contract-blueprint.md §8 byte-for-byte — a one-byte drift here
// silently downgrades every honest on-chain challenge to a timeout-split):
//   - `jointKeyCommit = keccak256(abi.encode(aggX, aggY, pkc))`, `pkc` as a FIXED `uint256[24]`
//     (24 inline words — NOT a dynamic `uint256[]`; the ABI encoding differs).
//   - `shuffleRoot = keccak256(abi.encode(steps))`, `steps` as the Solidity tuple array
//     `(uint8,bytes32,bytes32,bytes32)[]`.
//   - deck hashes = `keccak256(abi.encodePacked(uint256[208]))`, matching the on-chain
//     `deckCommitment` (word layout per card: `[e1.x, e1.y, e2.x, e2.y]`).
//
// SCOPE: this module is Zypher/Baby-JubJub (EdOnBN254) specific — `jointKeyCommit` requires
// `uncompressPoint`/`computePkc` from `zypherDeck.ts`, which only make sense for the ZK shuffle
// path bound to ZkTable's on-chain `ShuffleVerifier52`. The secp256k1 `AttestedElGamalDeck` path
// (HoldemTableN et al.) is explicitly OUT OF SCOPE for on-chain deck-key binding (spec §C3) — a
// session running that provider has no `jointKeyCommit`/`shuffleRoot` to compute and should keep
// posting the zero placeholder (see `hilo-war/src/session.ts`'s `ZypherDeckProvider` guard).
import { concatHex, encodeAbiParameters, keccak256, type Hex } from 'viem'
import type { ZypherDeckProvider } from './zypherDeck'
import { computePkc, uncompressPoint } from './zypherDeck'
import type { WireMasked, WireShuffle } from './maskedDeck'

const ZERO32: Hex = `0x${'00'.repeat(32)}`
const ZERO_ADDR: Hex = `0x${'00'.repeat(20)}`

/** Mirrors ZkTable.sol's `Step` struct exactly (wave2-contract-blueprint.md §3/§B2). */
export interface Step {
  authorSeat: number // uint8 — 1 or 2 (ZkTable's seat convention)
  beforeHash: Hex // bytes32
  afterHash: Hex // bytes32
  proofHash: Hex // bytes32
}

/** One shuffle contribution: who shuffled, the deck they started from, and their output+proof. */
export interface ShuffleRound {
  authorSeat: number
  before: WireMasked[]
  after: WireShuffle
}

/** The full off-chain deck-key binding for one DEAL: the transcript + both co-signed commitments. */
export interface DealBinding {
  steps: Step[]
  shuffleRoot: Hex
  jointKeyCommit: Hex
  aggX: bigint
  aggY: bigint
  pkc: bigint[]
}

const STEP_TUPLE_PARAM = {
  type: 'tuple[]',
  components: [
    { name: 'authorSeat', type: 'uint8' },
    { name: 'beforeHash', type: 'bytes32' },
    { name: 'afterHash', type: 'bytes32' },
    { name: 'proofHash', type: 'bytes32' },
  ],
} as const

/**
 * `keccak256(abi.encodePacked(uint256[208]))` for a masked deck — matches ZkTable.sol's
 * `deckCommitment` (:939) and the existing `deckCommitment()` helpers in
 * `hilo-war/src/session.ts` / `holdem/src/dealSeq.ts`. Each `WireMasked` is
 * `{c1: 64-byte hex, c2: 64-byte hex}` = `[e1.x, e1.y]` then `[e2.x, e2.y]`, so
 * `concatHex(deck.flatMap(m => [m.c1, m.c2]))` IS the packed 208-word encoding with no length
 * prefix (every word is already 32-byte aligned) — identical to `abi.encodePacked`.
 */
export function hashDeck(deck: WireMasked[]): Hex {
  return keccak256(concatHex(deck.flatMap((m) => [m.c1, m.c2])))
}

/** `keccak256(proof bytes)` — the verify52 SNARK proof is Zypher's opaque hex-string output. */
export function hashProof(proof: unknown): Hex {
  if (typeof proof !== 'string' || !proof.startsWith('0x')) {
    throw new Error('deckBinding: proof must be a 0x-prefixed hex string (Zypher verify52 SNARK output)')
  }
  return keccak256(proof as Hex)
}

/**
 * `shuffleRoot = keccak256(abi.encode(steps))` with `steps` typed as the Solidity tuple array
 * `(uint8,bytes32,bytes32,bytes32)[]` — see the module header's encoding pins.
 */
export function computeShuffleRoot(steps: readonly Step[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [STEP_TUPLE_PARAM],
      [steps.map((s) => ({ authorSeat: s.authorSeat, beforeHash: s.beforeHash, afterHash: s.afterHash, proofHash: s.proofHash }))],
    ),
  )
}

/**
 * `jointKeyCommit = keccak256(abi.encode(aggX, aggY, pkc))` with `pkc` as a FIXED `uint256[24]`
 * (NOT a dynamic `uint256[]` — the ABI encoding differs: a fixed array is 24 inline words with
 * no offset/length, a dynamic array carries an offset + length word). See the module header.
 */
export function computeJointKeyCommit(aggX: bigint, aggY: bigint, pkc: readonly bigint[]): Hex {
  if (pkc.length !== 24) throw new Error(`deckBinding: pkc must have exactly 24 words, got ${pkc.length}`)
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[24]' }],
      // viem types a fixed-size `uint256[24]` param as an exact 24-tuple; the length check above
      // guarantees that shape at runtime, but TS can't see it from `readonly bigint[]`.
      [aggX, aggY, pkc as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]],
    ),
  )
}

function stepsFromRounds(rounds: readonly ShuffleRound[]): Step[] {
  return rounds.map((r) => ({
    authorSeat: r.authorSeat,
    beforeHash: hashDeck(r.before),
    afterHash: hashDeck(r.after.deck),
    proofHash: hashProof(r.after.proof),
  }))
}

/**
 * Builds the full deck-key binding for a completed shuffle chain: the ordered `Step[]`, the
 * `shuffleRoot` over them, and the `jointKeyCommit` for `agg` (the joint key the deck was
 * actually masked under). Called once per DEAL, before the genesis co-sign — see
 * `hilo-war/src/session.ts::setup()`.
 */
export function buildDealBinding(agg: Hex, rounds: readonly ShuffleRound[]): DealBinding {
  if (rounds.length === 0) throw new Error('deckBinding: buildDealBinding requires at least one shuffle round')
  const steps = stepsFromRounds(rounds)
  const shuffleRoot = computeShuffleRoot(steps)
  const { x: aggX, y: aggY } = uncompressPoint(agg)
  const pkc = computePkc(agg)
  const jointKeyCommit = computeJointKeyCommit(aggX, aggY, pkc)
  return { steps, shuffleRoot, jointKeyCommit, aggX, aggY, pkc }
}

/** The safe "no binding available" genesis value — used by sessions on a non-Zypher provider. */
export const ZERO_DEAL_BINDING = { jointKeyCommit: ZERO32, shuffleRoot: ZERO32 } as const

export type VerifyDealBindingResult = { ok: true } | { ok: false; reason: string }

export interface VerifyDealBindingArgs {
  /** the Zypher provider instance to run `aggregate`/`initialDeck`/`verifyShuffle` through */
  provider: ZypherDeckProvider
  /** the table's REGISTERED deck pubkeys (packed Zypher `pk` hex), in canonical aggregation order */
  registeredKeys: Hex[]
  /** from the ChannelState about to be co-signed */
  jointKeyCommit: Hex
  shuffleRoot: Hex
  deckCommitment: Hex
  /** the full transcript: one entry per shuffle contribution, in order */
  rounds: readonly ShuffleRound[]
}

function reject(reason: string): VerifyDealBindingResult {
  return { ok: false, reason }
}

/**
 * The validate-before-sign guard (spec §B3, hard client obligation). A client MUST call this
 * (and see `{ok: true}`) before co-signing a DEAL's `ChannelState`. Checks, in order:
 *
 *   (a) `agg := aggregate(registeredKeys)` (NEVER a peer-supplied aggregate) and
 *       `pkc := computePkc(agg)` reproduce the claimed `jointKeyCommit`.
 *   (b) the canonical initial deck D0, recomputed from `agg` (not trusted from the transcript),
 *       matches `steps[0].beforeHash` — closes the "poisoned canonical head" attack.
 *   (c) every step's supplied before/after/proof hashes to what `steps[i]` claims, the chain
 *       `steps[i].beforeHash == steps[i-1].afterHash` holds, and the last step's `afterHash`
 *       equals the committed `deckCommitment`.
 *   (d) the rebuilt `Step[]` reproduces the claimed `shuffleRoot` — closes substitution/
 *       reordering/reattribution (a disputant can't swap in a foreign proof or relabel a seat).
 *   (e) `verify52` (off-chain) accepts every step's shuffle proof against the pinned `pkc`.
 *
 * Any failure returns a reject with a specific reason; nothing throws for a garbage/decoy input
 * (only for malformed call arguments, e.g. an empty transcript).
 */
export async function verifyDealBinding(args: VerifyDealBindingArgs): Promise<VerifyDealBindingResult> {
  const { provider, registeredKeys, jointKeyCommit, shuffleRoot, deckCommitment, rounds } = args
  if (rounds.length === 0) return reject('empty shuffle transcript')

  // (a) recompute agg + pkc from the REGISTERED keys only; never trust a peer-supplied aggregate.
  const agg = provider.aggregate(registeredKeys)
  const { x: aggX, y: aggY } = uncompressPoint(agg)
  const pkc = computePkc(agg)
  const recomputedCommit = computeJointKeyCommit(aggX, aggY, pkc)
  if (recomputedCommit !== jointKeyCommit) {
    return reject('jointKeyCommit mismatch: pkc (or the aggregate it was derived from) does not match Σ registered deck keys')
  }

  // (b) canonical D0 — recompute independently; do not trust the transcript's own claimed D0.
  const canonicalD0 = await provider.initialDeck(agg)
  const d0Hash = hashDeck(canonicalD0)

  // (c) rebuild Step[] from the supplied rounds and check the hash chain + tail.
  const steps = stepsFromRounds(rounds)
  if (steps[0]!.beforeHash !== d0Hash) {
    return reject('poisoned canonical head: steps[0].beforeHash does not match the recomputed initial deck D0')
  }
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]!.beforeHash !== steps[i - 1]!.afterHash) {
      return reject(`step ${i}: chain break — beforeHash does not match step ${i - 1}'s afterHash`)
    }
  }
  if (steps[steps.length - 1]!.afterHash !== deckCommitment) {
    return reject('final step afterHash does not match the committed deckCommitment')
  }

  // (d) shuffleRoot binds order + author + proofHash — recompute and compare.
  const recomputedRoot = computeShuffleRoot(steps)
  if (recomputedRoot !== shuffleRoot) {
    return reject('shuffleRoot mismatch: transcript was substituted, reordered, or reattributed')
  }

  // (e) run verify52 (off-chain) on EVERY step against the pinned agg/pkc.
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i]!
    const ok = await provider.verifyShuffle(agg, r.before, r.after, ZERO_ADDR)
    if (!ok) return reject(`step ${i} (authorSeat ${r.authorSeat}): shuffle proof failed verify52`)
  }

  return { ok: true }
}

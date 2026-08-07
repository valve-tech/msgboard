// GPLv3 via @zypher-game/secret-engine — PoC only, pending license review.
//
// Baby-JubJub (ed_on_bn254) deck provider backed by the Zypher uzkge WASM prover, implemented
// behind the existing `MaskedDeckProvider` seam (maskedDeck.ts). This is the P6.3 sibling of the
// shipped secp256k1 `AttestedElGamalDeck`: where that attests the shuffle with a signature, this
// produces a REAL zero-knowledge shuffle argument (verified off-chain by verify_shuffled_cards
// and on-chain by the vendored ShuffleVerifier52 — see P6.2). The secp256k1 path is NOT removed;
// this is selectable alongside it.
//
// PROVENANCE / ISOLATION: the prover is GPLv3-derived (upstream zypher-game/uzkge is GPL-3.0-only;
// the npm package self-tags MIT — a genuine ambiguity deferred to counsel, spec P6.5). It is a
// devDependency and this whole module is gated behind the seam so it can be swapped or removed.
//
// STATEFULNESS CAVEAT: the WASM keeps GLOBAL state (the proving key from init_prover_key, and the
// joint key loaded by refresh_joint_key). One ZypherDeckProvider drives one logical table at a
// time; concurrent decks in the same process would clash on that global state. The shipped seam
// usage is one deck per channel, matching this.
//
// SEAM WIRE MAPPING. The seam's WireMasked is {c1, c2} (two opaque point blobs). A Zypher
// MaskedCard is the 4-tuple [e2X, e2Y, e1X, e1Y] (two affine Baby-JubJub points). We map:
//   c2 = pack(e2X, e2Y)   (the message-bearing component)
//   c1 = pack(e1X, e1Y)   (the ElGamal ephemeral)
// pack(x, y) = 0x ++ hex32(x) ++ hex32(y)  (64 bytes). This is a lossless re-encoding; downstream
// (deckN/revealN/dealSeq) treats c1/c2 as opaque, so it is curve-agnostic over the seam.
//
// LIMITATION vs the secp256k1 path: Zypher's reveal proof binds {pk, card} but NOT the seam's
// external `ctx` (table+slot anti-replay) string. verifyShare therefore checks reveal soundness
// but cannot bind ctx here; the on-chain ctx-bound dispute belongs to the vendored EdOnBN254
// ChaumPedersenDLVerifier (P6.4), which is curve-correct once the deck is Baby-JubJub.

// Node-only: this whole module is the GPL secret-engine prover path, only ever exercised Node-side.
// In the browser bundle, `node:module` is aliased to a stub (see web/vite.config.ts) whose
// `createRequire` throws — harmless because `engine()` is never called in the browser.
import { createRequire } from 'node:module'
import { pad, type Hex } from 'viem'
import type { MaskedDeckProvider, ShuffleSigner, WireMasked, WireShare, WireShuffle } from './maskedDeck'
import { DECK_SIZE } from './cards'

// ---- Zypher WASM surface (recovered from the package .d.ts + empirical shapes) ----
type ZCard = [string, string, string, string] // [e2X, e2Y, e1X, e1Y]
interface ZKeyPair { sk: string; pk: string; pkxy: [string, string] }
interface ZMaskedWithProof { card: ZCard; proof: string }
interface ZShuffleOut { cards: ZCard[]; proof: string }
interface ZReveal { card: [string, string]; proof: string }
interface ZypherEngine {
  generate_key(): ZKeyPair
  aggregate_keys(pubs: string[]): string
  public_uncompress(pk: string): [string, string]
  public_compress(publics: [string, string]): string
  init_prover_key(num: number): void
  init_reveal_key(): void
  refresh_joint_key(joint: string, num: number): string[]
  init_masked_cards(joint: string, num: number): ZMaskedWithProof[]
  shuffle_cards(joint: string, deck: ZCard[]): ZShuffleOut
  verify_shuffled_cards(d1: ZCard[], d2: ZCard[], proof: string): boolean
  reveal_card(sk: string, card: ZCard): ZReveal
  verify_revealed_card(pk: string, card: ZCard, reveal: ZReveal): boolean
  decode_point(card: ZCard, reveals: [string, string][]): number
}

let _engine: ZypherEngine | undefined
let _proverKeyReady = false
function engine(): ZypherEngine {
  if (!_engine) {
    // Dual-mode resolver: under ts-node's CJS compile (the contracts test runner forces this whole
    // package to "cjs" via tsconfig moduleTypes — a literal `import.meta` would be a SyntaxError
    // there), the ambient `require` exists and is used directly. Under real ESM execution it does
    // not, and the DIRECT eval — evaluated only then, so CJS never parses the token — reads
    // import.meta.url from module scope for createRequire. The eval argument is this fixed literal,
    // never data: it exists purely to keep the ESM-only token out of the CJS parse, not to execute
    // anything dynamic. Browser builds never get here at all (node:module is stubbed; see header).
    const req =
      typeof require !== 'undefined'
        ? require
        : // eslint-disable-next-line no-eval
          createRequire(eval('import.meta.url') as string)
    _engine = req('@zypher-game/secret-engine') as ZypherEngine
  }
  return _engine
}
/** init_prover_key(52) is a ~11s one-time global setup; memoize it. */
function ensureProverKey(z: ZypherEngine) {
  if (!_proverKeyReady) {
    z.init_prover_key(DECK_SIZE)
    z.init_reveal_key()
    _proverKeyReady = true
  }
}

// ---- deck-key-binding support (deckkey-binding-spec B1/B3/B4) --------------------------------
//
// Two standalone helpers on top of the raw WASM, used by `deckBinding.ts` to build/verify the
// on-chain-checkable `jointKeyCommit`. Both are exported here (not in deckBinding.ts) because
// they need the module-private `engine()`/`ensureProverKey()` plumbing above.

/**
 * Decompresses a packed Zypher pubkey/aggregate (as returned by `generate_key().pk` or
 * `aggregate_keys(...)`) into its raw EdOnBN254 affine coordinates `(x, y)`.
 *
 * Empirically confirmed (see `deckBinding.test.ts`) that
 * `public_uncompress(aggregate_keys(pubs)) == raw EdOnBN254 point-sum of the individual pubs'
 * own affine coordinates` — i.e. this matches the on-chain `RevealVerifier.aggregateKeys` /
 * `DeckConstants` point-sum semantics exactly, byte-for-byte. That equivalence is what lets
 * `jointKeyCommit` (computed off-chain from this `(aggX, aggY)`) be re-derived on-chain from
 * `Σ registered deckKeys` without reimplementing any WASM logic in Solidity.
 */
export function uncompressPoint(packed: Hex): { x: bigint; y: bigint } {
  const [x, y] = engine().public_uncompress(packed as unknown as string)
  return { x: BigInt(x), y: BigInt(y) }
}

/**
 * The 24-word on-chain public-key commitment (`pkc`) for joint key `agg` — Zypher's
 * `refresh_joint_key(agg, 52)`, which is a PURE function of `(agg, DECK_SIZE)` (empirically
 * confirmed deterministic across repeated calls — see `deckBinding.test.ts`).
 *
 * Exposed standalone (not only as `ZypherDeckProvider.lastPkc`, a side effect of `.shuffle()`)
 * so a validator can recompute `pkc` from an INDEPENDENTLY-derived aggregate (e.g. the
 * aggregate of the table's REGISTERED deck keys) without trusting any peer-supplied pkc and
 * without needing to have already run a shuffle.
 */
export function computePkc(agg: Hex): bigint[] {
  const z = engine()
  ensureProverKey(z)
  return z.refresh_joint_key(agg as unknown as string, DECK_SIZE).map((h) => BigInt(h))
}

/**
 * Compresses raw EdOnBN254 affine coordinates `(x, y)` into the packed Zypher pubkey hex format
 * (the exact shape `generate_key().pk` / `aggregate_keys(...)` produce, and `uncompressPoint`
 * consumes) — the inverse of `uncompressPoint`.
 *
 * Used by a client's on-chain deck-key reader (deckkey-binding-spec §B3, audit gap H-2) to turn
 * `ZkTable.sol`'s `deckKeys[tableId][seat]` — stored as a raw `uint256[2]` affine point, NOT a
 * packed key — back into the packed form `provider.aggregate(...)` (and `verifyDealBinding`'s
 * `registeredKeys`) expects. Sourcing `registeredKeys` from chain (via this + a `deckKeys` read)
 * rather than from the gossiped KEYGEN pubkey is what catches a seat that registers key X
 * on-chain but gossips a different key Y over the wire (the "wrong-agg decoy").
 */
export function compressPoint(x: bigint, y: bigint): Hex {
  // public_compress expects the SAME 32-byte 0x-hex string shape public_uncompress returns
  // (empirically confirmed) — a bare decimal string throws inside the WASM ("Odd number of
  // digits", it tries to hex-decode the string as-is).
  const toHex32 = (v: bigint): Hex => pad(`0x${v.toString(16)}` as Hex, { size: 32 })
  return engine().public_compress([toHex32(x), toHex32(y)]) as unknown as Hex
}

// ---- point (de)serialization between the seam wire and Zypher 4-tuples ----
const hex32 = (v: string): string => pad(v as Hex, { size: 32 }).slice(2)
function pack(x: string, y: string): Hex {
  return `0x${hex32(x)}${hex32(y)}`
}
function unpack(h: Hex): [string, string] {
  const b = h.slice(2)
  if (b.length !== 128) throw new Error(`zypherDeck: packed point must be 64 bytes, got ${b.length / 2}`)
  return [`0x${b.slice(0, 64)}`, `0x${b.slice(64)}`]
}
function cardToWire(card: ZCard): WireMasked {
  return { c2: pack(card[0], card[1]), c1: pack(card[2], card[3]) }
}
function wireToCard(w: WireMasked): ZCard {
  const [e2X, e2Y] = unpack(w.c2)
  const [e1X, e1Y] = unpack(w.c1)
  return [e2X, e2Y, e1X, e1Y]
}

interface ZShareProof {
  reveal: [string, string] // the reveal-token point (x, y)
  proof: string // Zypher reveal proof
}

/**
 * Baby-JubJub deck provider on the real Zypher uzkge ZK shuffle. Sibling to AttestedElGamalDeck;
 * the shuffle is zero-knowledge-proven, not signature-attested. `agg` carries the Zypher joint
 * key; the shuffle proof is the SNARK string. ShuffleSigner is unused (kept for seam parity).
 */
export class ZypherDeckProvider implements MaskedDeckProvider {
  /** The most recent pkc (24-word public-key commitment) from refresh_joint_key — the on-chain input. */
  lastPkc: string[] = []

  async keygen(): Promise<{ secret: Hex; pub: Hex }> {
    const k = engine().generate_key()
    return { secret: k.sk as Hex, pub: k.pk as Hex }
  }

  aggregate(pubs: Hex[]): Hex {
    return engine().aggregate_keys(pubs as unknown as string[]) as Hex
  }

  async initialDeck(agg: Hex): Promise<WireMasked[]> {
    const z = engine()
    ensureProverKey(z)
    const masked = z.init_masked_cards(agg, DECK_SIZE)
    return masked.map((m) => cardToWire(m.card))
  }

  async shuffle(agg: Hex, deck: WireMasked[], _signer: ShuffleSigner): Promise<WireShuffle> {
    const z = engine()
    ensureProverKey(z)
    // refresh_joint_key MUST run before shuffle_cards (loads joint into prover state) and yields
    // the 24-word pkc the on-chain verifier consumes.
    this.lastPkc = z.refresh_joint_key(agg, DECK_SIZE)
    const before = deck.map(wireToCard)
    const out = z.shuffle_cards(agg, before)
    return { deck: out.cards.map(cardToWire), proof: out.proof }
  }

  async verifyShuffle(_agg: Hex, before: WireMasked[], after: WireShuffle, _signerAddr: Hex): Promise<boolean> {
    if (after.deck.length !== before.length) return false
    try {
      return engine().verify_shuffled_cards(
        before.map(wireToCard),
        after.deck.map(wireToCard),
        after.proof as string,
      )
    } catch {
      return false
    }
  }

  // NOTE: `ctx` is not bindable into the Zypher reveal proof (see file header); the on-chain
  // ctx-bound dispute is the EdOnBN254 ChaumPedersenDLVerifier path (P6.4). `secret` is the
  // Zypher sk string; `share` carries the packed reveal-token point, `proof` the reveal proof.
  async share(secret: Hex, card: WireMasked, _ctx: string): Promise<WireShare> {
    const r = engine().reveal_card(secret as unknown as string, wireToCard(card))
    const proof: ZShareProof = { reveal: r.card, proof: r.proof }
    return { share: pack(r.card[0], r.card[1]), proof }
  }

  // `pub` is the revealer's Zypher deck pubkey (== pk), which verify_revealed_card requires.
  async verifyShare(pub: Hex, card: WireMasked, s: WireShare, _ctx: string): Promise<boolean> {
    try {
      const sp = s.proof as ZShareProof
      const reveal: ZReveal = { card: sp.reveal, proof: sp.proof }
      return engine().verify_revealed_card(pub as unknown as string, wireToCard(card), reveal)
    } catch {
      return false
    }
  }

  unmask(card: WireMasked, shares: WireShare[]): number {
    const reveals = shares.map((s) => unpack(s.share))
    return engine().decode_point(wireToCard(card), reveals)
  }
}

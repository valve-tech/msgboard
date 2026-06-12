# ZK Cards Engine (`@gibs/zk-cards-core` + `@gibs/hilo-war`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The off-chain engine for ZK card games — masked-deck crypto behind a swappable interface, the two-party channel state machine, and a fully playable, fully tested heads-up Hi-Lo War over in-process transport.

**Architecture:** Two new workspace packages in `gibsfinance/random` under `examples/games/`. `@gibs/zk-cards-core` holds the game-agnostic rails: card codec, a `MaskedDeckProvider` interface with a v0 reference implementation (real ElGamal masking + real Chaum–Pedersen share proofs over secp256k1; shuffle integrity attested by signature, to be replaced by the spiked SNARK SDK behind the same interface), EIP-712 co-signed channel states, transcript, transport, and dispute-evidence building. `@gibs/hilo-war` holds pure rules and the two-client session driver. No network code, no chain code — everything testable with two in-process clients.

**Tech Stack:** TypeScript (ESM, `src/index.ts` entries), pnpm workspace, vitest, viem ^2.25 (accounts + EIP-712 + keccak + hex utils), @noble/curves (secp256k1 group ops; already in the tree as a viem dependency, declared explicitly).

**Spec:** `docs/superpowers/specs/2026-06-11-zk-card-games-design.md` (msgboard repo). This plan implements the "Off-chain packages" engine items and the engine/edge-case parts of "First build: Hi-Lo War" and "Testing". Contracts, relay/mirror, web, bots, and the SNARK SDK integration are later plans.

**Where the code lives / git:** `~/Documents/gibs-finance/random`, branch `games-platform`. Commits are unsigned in this repo (`commit.gpgsign false` already set locally). Push with `git push ssh://git@ssh.github.com:443/gibsfinance/random.git games-platform`. If push is rejected, `git fetch && git rebase origin/games-platform` first (a concurrent controlling session may also push).

**Conventions that bite:**
- Run package tests from the package dir (`cd examples/games/zk-core && pnpm test`) or filtered from root (`pnpm --filter @gibs/zk-cards-core test`).
- tsx/vitest ESM: never put a top-level `main()` call in a module that is also imported.
- This is the pnpm repo (never npm/yarn here).

**v0 honesty note (carry into code comments):** `AttestedElGamalDeck` gives real hiding (nobody sees a card without the other party's share) and real share soundness (Chaum–Pedersen), but its shuffle proof is only a signature by the shuffler — integrity is attested, not zero-knowledge-proven. The SNARK deck from the spike replaces exactly that, behind `MaskedDeckProvider`. Tests written against the interface must pass for both implementations.

---

## File structure

```
examples/games/zk-core/                  @gibs/zk-cards-core
  package.json  tsconfig.json
  src/index.ts                           re-exports
  src/cards.ts                           card codec + ace-high compare
  src/elgamal.ts                         group ops, mask/remask, shares, card table
  src/chaumPedersen.ts                   share-correctness proofs (Fiat–Shamir/keccak)
  src/maskedDeck.ts                      MaskedDeckProvider interface + wire types
  src/attestedDeck.ts                    v0 provider (ElGamal + attested shuffle)
  src/stateSig.ts                        ChannelState + EIP-712 sign/verify
  src/channel.ts                         co-signed state machine (nonce, invariants)
  src/transcript.ts                      signed message envelopes, hash-chained log
  src/transport.ts                       Transport interface + LocalTransport pair
  src/dispute.ts                         evidence builder + stall detection
  test/*.test.ts                         one file per src module
examples/games/hilo-war/                 @gibs/hilo-war
  package.json  tsconfig.json
  src/index.ts
  src/rules.ts                           pure legality + settlement math
  src/session.ts                         Player/session driver over core
  test/rules.test.ts
  test/session.test.ts                   happy path
  test/adversarial.test.ts               attacks + edge cases + pipelining
```

`ChannelState.gameStateHash` keeps the channel layer game-agnostic: the channel signs a hash; the game package owns the preimage struct. The same split recurs on-chain later (`ZkTable` vs `HiLoWarRules`), so nothing here is Hi-Lo-specific except the `hilo-war` package.

---

### Task 1: Scaffold `@gibs/zk-cards-core`

**Files:**
- Create: `examples/games/zk-core/package.json`
- Create: `examples/games/zk-core/tsconfig.json`
- Create: `examples/games/zk-core/src/index.ts`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@gibs/zk-cards-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@noble/curves": "^1.6.0",
    "viem": "^2.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "~5.8.3",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json** (copy the shape used by `examples/games/core/tsconfig.json` — read that file and mirror it exactly, adjusting only paths if it has any; if it extends a root config, extend the same one)

- [ ] **Step 3: Write a placeholder index**

```ts
// examples/games/zk-core/src/index.ts
export {}
```

- [ ] **Step 4: Install and verify the workspace picks it up**

Run: `cd ~/Documents/gibs-finance/random && pnpm install`
Expected: lockfile updates; `pnpm --filter @gibs/zk-cards-core exec node -e "console.log('ok')"` prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add examples/games/zk-core pnpm-lock.yaml
git commit -m "chore(zk-core): scaffold @gibs/zk-cards-core package"
```

---

### Task 2: Card codec (`cards.ts`)

**Files:**
- Create: `examples/games/zk-core/src/cards.ts`
- Test: `examples/games/zk-core/test/cards.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/cards.test.ts
import { describe, it, expect } from 'vitest'
import { cardFromIndex, rankOf, suitOf, compareRanks, cardName, DECK_SIZE } from '../src/cards'

describe('card codec', () => {
  it('decodes all 52 indices uniquely', () => {
    expect(DECK_SIZE).toBe(52)
    const seen = new Set<string>()
    for (let i = 0; i < 52; i++) {
      const c = cardFromIndex(i)
      expect(c.rank).toBeGreaterThanOrEqual(2)
      expect(c.rank).toBeLessThanOrEqual(14)
      expect(['clubs', 'diamonds', 'hearts', 'spades']).toContain(c.suit)
      seen.add(`${c.rank}-${c.suit}`)
    }
    expect(seen.size).toBe(52)
  })
  it('rank layout: index = (rank-2)*4 + suitIndex', () => {
    expect(rankOf(0)).toBe(2)            // 2 of clubs
    expect(rankOf(51)).toBe(14)          // ace of spades
    expect(suitOf(0)).toBe('clubs')
    expect(suitOf(51)).toBe('spades')
  })
  it('compares ace-high, suits irrelevant', () => {
    expect(compareRanks(51, 0)).toBeGreaterThan(0)   // A > 2
    expect(compareRanks(0, 1)).toBe(0)               // 2c vs 2d tie
    expect(compareRanks(4, 51)).toBeLessThan(0)      // 3 < A
  })
  it('names cards', () => {
    expect(cardName(51)).toBe('A♠')
    expect(cardName(0)).toBe('2♣')
  })
  it('rejects out-of-range indices', () => {
    expect(() => cardFromIndex(52)).toThrow()
    expect(() => cardFromIndex(-1)).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd examples/games/zk-core && pnpm test`
Expected: FAIL — cannot resolve `../src/cards`.

- [ ] **Step 3: Implement**

```ts
// src/cards.ts
export const DECK_SIZE = 52
export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const SUIT_GLYPH: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }
const RANK_GLYPH = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export interface Card { index: number; rank: number; suit: Suit }

function assertIndex(i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= DECK_SIZE) throw new Error(`card index out of range: ${i}`)
}
/** rank 2..14 (ace high); index = (rank-2)*4 + suit */
export function rankOf(i: number): number { assertIndex(i); return Math.floor(i / 4) + 2 }
export function suitOf(i: number): Suit { assertIndex(i); return SUITS[i % 4] }
export function cardFromIndex(i: number): Card { return { index: i, rank: rankOf(i), suit: suitOf(i) } }
/** >0 if a outranks b, <0 if b outranks a, 0 on equal rank (suits never break ties) */
export function compareRanks(a: number, b: number): number { return rankOf(a) - rankOf(b) }
export function cardName(i: number): string { return `${RANK_GLYPH[rankOf(i) - 2]}${SUIT_GLYPH[suitOf(i)]}` }
```

- [ ] **Step 4: Run tests**

Run: `pnpm test` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/games/zk-core
git commit -m "feat(zk-core): card codec with ace-high rank compare"
```

---

### Task 3: ElGamal masking primitives (`elgamal.ts`)

The group layer everything else sits on. Card `i` is encoded as the point `G·(i+1)` (`+1` avoids the identity). A masked card is an ElGamal ciphertext under the *aggregate* public key; re-masking re-randomizes without changing the plaintext; unmasking needs a decryption share from **every** keyholder.

**Files:**
- Create: `examples/games/zk-core/src/elgamal.ts`
- Test: `examples/games/zk-core/test/elgamal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/elgamal.test.ts
import { describe, it, expect } from 'vitest'
import {
  randomScalar, pubKeyOf, aggregatePubKeys, maskCard, remask,
  decryptionShare, unmaskWithShares, serializePoint, deserializePoint,
} from '../src/elgamal'

describe('elgamal masking', () => {
  const skA = randomScalar(), skB = randomScalar()
  const agg = aggregatePubKeys([pubKeyOf(skA), pubKeyOf(skB)])

  it('mask → both shares → unmask round-trips every card', () => {
    for (const i of [0, 7, 51]) {
      const m = maskCard(agg, i)
      const shares = [decryptionShare(skA, m), decryptionShare(skB, m)]
      expect(unmaskWithShares(m, shares)).toBe(i)
    }
  })
  it('remask preserves the plaintext but changes the ciphertext', () => {
    const m = maskCard(agg, 13)
    const r = remask(agg, m)
    expect(serializePoint(r.c1)).not.toBe(serializePoint(m.c1))
    const shares = [decryptionShare(skA, r), decryptionShare(skB, r)]
    expect(unmaskWithShares(r, shares)).toBe(13)
  })
  it('one share is not enough', () => {
    const m = maskCard(agg, 3)
    expect(() => unmaskWithShares(m, [decryptionShare(skA, m)])).toThrow(/not a card point/)
  })
  it('points serialize round-trip', () => {
    const p = pubKeyOf(skA)
    expect(serializePoint(deserializePoint(serializePoint(p)))).toBe(serializePoint(p))
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/elgamal.ts
import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex, hexToBytes, type Hex } from 'viem'

export type Point = InstanceType<typeof secp256k1.ProjectivePoint>
const Pt = secp256k1.ProjectivePoint
export const G: Point = Pt.BASE
export const ORDER = secp256k1.CURVE.n

export interface MaskedCard { c1: Point; c2: Point }

export function randomScalar(): bigint {
  return secp256k1.utils.normPrivateKeyToScalar(secp256k1.utils.randomPrivateKey())
}
export function pubKeyOf(sk: bigint): Point { return G.multiply(sk) }
export function aggregatePubKeys(pks: Point[]): Point {
  return pks.reduce((acc, p) => acc.add(p), Pt.ZERO)
}

/** card i ↦ G·(i+1); +1 keeps the identity out of the table */
export function cardPoint(i: number): Point { return G.multiply(BigInt(i + 1)) }
const CARD_TABLE: string[] = Array.from({ length: 52 }, (_, i) => cardPoint(i).toHex(true))

export function maskCard(agg: Point, cardIndex: number, r: bigint = randomScalar()): MaskedCard {
  return { c1: G.multiply(r), c2: cardPoint(cardIndex).add(agg.multiply(r)) }
}
export function remask(agg: Point, m: MaskedCard, r: bigint = randomScalar()): MaskedCard {
  return { c1: m.c1.add(G.multiply(r)), c2: m.c2.add(agg.multiply(r)) }
}
/** party's partial decryption: d = c1 · sk */
export function decryptionShare(sk: bigint, m: MaskedCard): Point { return m.c1.multiply(sk) }
/** M = c2 − Σ shares; decode against the 52-entry table */
export function unmaskWithShares(m: MaskedCard, shares: Point[]): number {
  const M = shares.reduce((acc, d) => acc.subtract(d), m.c2)
  const idx = CARD_TABLE.indexOf(M.toHex(true))
  if (idx === -1) throw new Error('unmask: result is not a card point (missing/garbage share?)')
  return idx
}

export function serializePoint(p: Point): Hex { return `0x${p.toHex(true)}` }
export function deserializePoint(h: Hex): Point { return Pt.fromHex(h.slice(2)) }
export function serializeScalar(s: bigint): Hex { return bytesToHex(hexToBytes(`0x${s.toString(16).padStart(64, '0')}`)) }
export function deserializeScalar(h: Hex): bigint { return BigInt(h) }
export function serializeMasked(m: MaskedCard): { c1: Hex; c2: Hex } {
  return { c1: serializePoint(m.c1), c2: serializePoint(m.c2) }
}
export function deserializeMasked(w: { c1: Hex; c2: Hex }): MaskedCard {
  return { c1: deserializePoint(w.c1), c2: deserializePoint(w.c2) }
}
```

- [ ] **Step 4: Run tests** — Expected: PASS. (If `Pt.ZERO.add` complains about the identity in noble's API, replace the reduce seed with the first key: `pks.slice(1).reduce((a, p) => a.add(p), pks[0])` and require `pks.length >= 1`.)

- [ ] **Step 5: Commit**

```bash
git add examples/games/zk-core
git commit -m "feat(zk-core): elgamal masking, remasking, decryption shares over secp256k1"
```

---

### Task 4: Chaum–Pedersen share proofs (`chaumPedersen.ts`)

Proves a published share `d` satisfies `log_G(pk) = log_{c1}(d)` — i.e. it really is `c1·sk` for the registered key — without revealing `sk`. Fiat–Shamir challenge via keccak over all transcript points, bound to a context string.

**Files:**
- Create: `examples/games/zk-core/src/chaumPedersen.ts`
- Test: `examples/games/zk-core/test/chaumPedersen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/chaumPedersen.test.ts
import { describe, it, expect } from 'vitest'
import { randomScalar, pubKeyOf, maskCard, decryptionShare, aggregatePubKeys } from '../src/elgamal'
import { proveShare, verifyShare } from '../src/chaumPedersen'

describe('chaum-pedersen share proofs', () => {
  const sk = randomScalar(), pk = pubKeyOf(sk)
  const agg = aggregatePubKeys([pk, pubKeyOf(randomScalar())])
  const m = maskCard(agg, 21)
  const d = decryptionShare(sk, m)

  it('honest proof verifies', () => {
    const proof = proveShare(sk, m, 'table-1/slot-4')
    expect(verifyShare(pk, m, d, proof, 'table-1/slot-4')).toBe(true)
  })
  it('rejects a share for the wrong ciphertext', () => {
    const m2 = maskCard(agg, 22)
    const proof = proveShare(sk, m, 'ctx')
    expect(verifyShare(pk, m2, decryptionShare(sk, m), proof, 'ctx')).toBe(false)
  })
  it('rejects a forged share (wrong sk)', () => {
    const skEvil = randomScalar()
    const forged = decryptionShare(skEvil, m)
    const proof = proveShare(skEvil, m, 'ctx')
    expect(verifyShare(pk, m, forged, proof, 'ctx')).toBe(false) // pk doesn't match skEvil
  })
  it('rejects context swap (no cross-slot replay)', () => {
    const proof = proveShare(sk, m, 'slot-4')
    expect(verifyShare(pk, m, d, proof, 'slot-5')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/chaumPedersen.ts
import { keccak256, stringToHex, concatHex, type Hex } from 'viem'
import {
  G, ORDER, randomScalar, type Point, type MaskedCard,
  serializePoint, deserializePoint, serializeScalar, deserializeScalar,
} from './elgamal'

export interface ShareProof { t1: Hex; t2: Hex; z: Hex }

function challenge(pk: Point, m: MaskedCard, d: Point, t1: Point, t2: Point, ctx: string): bigint {
  const h = keccak256(concatHex([
    stringToHex('zk-cards/chaum-pedersen/v1'),
    serializePoint(pk), serializePoint(m.c1), serializePoint(m.c2),
    serializePoint(d), serializePoint(t1), serializePoint(t2),
    stringToHex(ctx),
  ]))
  return BigInt(h) % ORDER
}

/** prove d = c1·sk for pk = G·sk, bound to ctx */
export function proveShare(sk: bigint, m: MaskedCard, ctx: string): ShareProof {
  const w = randomScalar() // fresh nonce per proof; never reuse w across proofs
  const t1 = G.multiply(w)
  const t2 = m.c1.multiply(w)
  const d = m.c1.multiply(sk)
  const e = challenge(G.multiply(sk), m, d, t1, t2, ctx)
  const z = (w + e * sk) % ORDER
  return { t1: serializePoint(t1), t2: serializePoint(t2), z: serializeScalar(z) }
}

export function verifyShare(pk: Point, m: MaskedCard, d: Point, proof: ShareProof, ctx: string): boolean {
  try {
    const t1 = deserializePoint(proof.t1), t2 = deserializePoint(proof.t2)
    const z = deserializeScalar(proof.z)
    const e = challenge(pk, m, d, t1, t2, ctx)
    const left1 = G.multiply(z), right1 = t1.add(pk.multiply(e))
    const left2 = m.c1.multiply(z), right2 = t2.add(d.multiply(e))
    return left1.equals(right1) && left2.equals(right2)
  } catch { return false }
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/games/zk-core
git commit -m "feat(zk-core): chaum-pedersen decryption-share proofs (fiat-shamir/keccak)"
```

---

### Task 5: `MaskedDeckProvider` interface + v0 attested implementation

The seam the SNARK spike lands behind. Wire types are all hex so they drop straight into transcripts. The v0 `AttestedElGamalDeck` implements it with Task 3/4 primitives; its shuffle "proof" is the shuffler's EIP-191 signature over `keccak(before || after)` — integrity attested, not ZK (comment this in code).

**Files:**
- Create: `examples/games/zk-core/src/maskedDeck.ts`
- Create: `examples/games/zk-core/src/attestedDeck.ts`
- Test: `examples/games/zk-core/test/attestedDeck.test.ts`

- [ ] **Step 1: Write the interface**

```ts
// src/maskedDeck.ts
import type { Hex } from 'viem'

export interface WireMasked { c1: Hex; c2: Hex }
export interface WireShare { share: Hex; proof: unknown }
export interface WireShuffle { deck: WireMasked[]; proof: unknown }

/**
 * The crypto seam. v0 = AttestedElGamalDeck (real hiding + share soundness,
 * signature-attested shuffles). The SNARK SDK from the spike replaces it with
 * ZK shuffle arguments behind this same interface.
 */
export interface MaskedDeckProvider {
  /** party key for the deck crypto (NOT the wallet key) */
  keygen(): Promise<{ secret: Hex; pub: Hex }>
  aggregate(pubs: Hex[]): Hex
  /** canonical 52-card deck masked under agg, order 0..51 */
  initialDeck(agg: Hex): Promise<WireMasked[]>
  /** permute + remask; proof must convince verifyShuffle */
  shuffle(agg: Hex, deck: WireMasked[], signer: ShuffleSigner): Promise<WireShuffle>
  verifyShuffle(agg: Hex, before: WireMasked[], after: WireShuffle, signerAddr: Hex): Promise<boolean>
  /** decryption share for one slot, ctx binds table+slot against replay */
  share(secret: Hex, card: WireMasked, ctx: string): Promise<WireShare>
  verifyShare(pub: Hex, card: WireMasked, s: WireShare, ctx: string): Promise<boolean>
  /** decode with all parties' shares */
  unmask(card: WireMasked, shares: WireShare[]): number
}

export interface ShuffleSigner {
  address: Hex
  signMessage(args: { message: { raw: Hex } }): Promise<Hex>
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/attestedDeck.test.ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { AttestedElGamalDeck } from '../src/attestedDeck'

const walletA = privateKeyToAccount(generatePrivateKey())
const walletB = privateKeyToAccount(generatePrivateKey())

describe('AttestedElGamalDeck', () => {
  const deck = new AttestedElGamalDeck()

  it('full two-party flow: keygen → mask → A shuffles → B shuffles → deal', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    expect(d0).toHaveLength(52)

    const s1 = await deck.shuffle(agg, d0, walletA)
    expect(await deck.verifyShuffle(agg, d0, s1, walletA.address)).toBe(true)
    const s2 = await deck.shuffle(agg, s1.deck, walletB)
    expect(await deck.verifyShuffle(agg, s1.deck, s2, walletB.address)).toBe(true)

    // deal slot 0: both shares, both proofs verify, decodes to a valid card
    const ctx = 'test-table/slot-0'
    const shA = await deck.share(a.secret, s2.deck[0], ctx)
    const shB = await deck.share(b.secret, s2.deck[0], ctx)
    expect(await deck.verifyShare(a.pub, s2.deck[0], shA, ctx)).toBe(true)
    expect(await deck.verifyShare(b.pub, s2.deck[0], shB, ctx)).toBe(true)
    const card = deck.unmask(s2.deck[0], [shA, shB])
    expect(card).toBeGreaterThanOrEqual(0)
    expect(card).toBeLessThan(52)
  })

  it('double shuffle is a permutation: unmasking all 52 yields all 52 cards', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const s1 = await deck.shuffle(agg, await deck.initialDeck(agg), walletA)
    const s2 = await deck.shuffle(agg, s1.deck, walletB)
    const seen = new Set<number>()
    for (let i = 0; i < 52; i++) {
      const ctx = `t/slot-${i}`
      const cards = deck.unmask(s2.deck[i], [
        await deck.share(a.secret, s2.deck[i], ctx),
        await deck.share(b.secret, s2.deck[i], ctx),
      ])
      seen.add(cards)
    }
    expect(seen.size).toBe(52)
  })

  it('rejects a tampered shuffle (card substituted after signing)', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const s1 = await deck.shuffle(agg, d0, walletA)
    const tampered = { ...s1, deck: [...s1.deck] }
    tampered.deck[5] = d0[5] // swap a card back
    expect(await deck.verifyShuffle(agg, d0, tampered, walletA.address)).toBe(false)
  })

  it('rejects a shuffle signed by the wrong party', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const s1 = await deck.shuffle(agg, d0, walletA)
    expect(await deck.verifyShuffle(agg, d0, s1, walletB.address)).toBe(false)
  })

  it('rejects a bad share and unmask explodes on garbage', async () => {
    const a = await deck.keygen(), b = await deck.keygen()
    const evil = await deck.keygen()
    const agg = deck.aggregate([a.pub, b.pub])
    const d0 = await deck.initialDeck(agg)
    const bad = await deck.share(evil.secret, d0[0], 'ctx')
    expect(await deck.verifyShare(a.pub, d0[0], bad, 'ctx')).toBe(false)
    const good = await deck.share(a.secret, d0[0], 'ctx')
    expect(() => deck.unmask(d0[0], [good, bad])).toThrow(/not a card point/)
  })
})
```

- [ ] **Step 3: Run to verify failure** — FAIL (attestedDeck missing).

- [ ] **Step 4: Implement**

```ts
// src/attestedDeck.ts
import { keccak256, concatHex, recoverMessageAddress, type Hex } from 'viem'
import type { MaskedDeckProvider, ShuffleSigner, WireMasked, WireShare, WireShuffle } from './maskedDeck'
import {
  randomScalar, pubKeyOf, aggregatePubKeys, maskCard, remask, decryptionShare,
  unmaskWithShares, serializePoint, deserializePoint, serializeScalar, deserializeScalar,
  deserializeMasked, serializeMasked,
} from './elgamal'
import { proveShare, verifyShare as cpVerify, type ShareProof } from './chaumPedersen'
import { DECK_SIZE } from './cards'

function deckDigest(deck: WireMasked[]): Hex {
  return keccak256(concatHex(deck.flatMap((m) => [m.c1, m.c2])))
}
function shuffleDigest(before: WireMasked[], after: WireMasked[]): Hex {
  return keccak256(concatHex([deckDigest(before), deckDigest(after)]))
}

/**
 * v0 deck provider. Hiding and share soundness are REAL (ElGamal + Chaum–Pedersen).
 * The shuffle proof is only the shuffler's signature over keccak(before||after):
 * integrity is attested, not zero-knowledge-proven. The SNARK provider from the
 * SDK spike replaces exactly this behind MaskedDeckProvider.
 */
export class AttestedElGamalDeck implements MaskedDeckProvider {
  async keygen() {
    const sk = randomScalar()
    return { secret: serializeScalar(sk), pub: serializePoint(pubKeyOf(sk)) }
  }
  aggregate(pubs: Hex[]): Hex {
    return serializePoint(aggregatePubKeys(pubs.map(deserializePoint)))
  }
  async initialDeck(agg: Hex): Promise<WireMasked[]> {
    const A = deserializePoint(agg)
    return Array.from({ length: DECK_SIZE }, (_, i) => serializeMasked(maskCard(A, i)))
  }
  async shuffle(agg: Hex, deck: WireMasked[], signer: ShuffleSigner): Promise<WireShuffle> {
    const A = deserializePoint(agg)
    const out = deck.map((w) => serializeMasked(remask(A, deserializeMasked(w))))
    // Fisher–Yates over crypto-quality randomness
    for (let i = out.length - 1; i > 0; i--) {
      const j = Number(randomScalar() % BigInt(i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    const proof = await signer.signMessage({ message: { raw: shuffleDigest(deck, out) } })
    return { deck: out, proof }
  }
  async verifyShuffle(agg: Hex, before: WireMasked[], after: WireShuffle, signerAddr: Hex): Promise<boolean> {
    if (after.deck.length !== before.length) return false
    try {
      const rec = await recoverMessageAddress({
        message: { raw: shuffleDigest(before, after.deck) },
        signature: after.proof as Hex,
      })
      return rec.toLowerCase() === signerAddr.toLowerCase()
    } catch { return false }
  }
  async share(secret: Hex, card: WireMasked, ctx: string): Promise<WireShare> {
    const sk = deserializeScalar(secret)
    const m = deserializeMasked(card)
    return { share: serializePoint(decryptionShare(sk, m)), proof: proveShare(sk, m, ctx) }
  }
  async verifyShare(pub: Hex, card: WireMasked, s: WireShare, ctx: string): Promise<boolean> {
    try {
      return cpVerify(
        deserializePoint(pub), deserializeMasked(card),
        deserializePoint(s.share), s.proof as ShareProof, ctx,
      )
    } catch { return false }
  }
  unmask(card: WireMasked, shares: WireShare[]): number {
    return unmaskWithShares(deserializeMasked(card), shares.map((s) => deserializePoint(s.share)))
  }
}
```

Note the tamper test: substituting a card changes `shuffleDigest`, so the recovered signer no longer matches — that's the (weak, v0) integrity check working as designed.

- [ ] **Step 5: Run tests** — Expected: PASS (5 tests; the 52-card permutation test takes a few seconds — fine).

- [ ] **Step 6: Commit**

```bash
git add examples/games/zk-core
git commit -m "feat(zk-core): MaskedDeckProvider interface + v0 attested elgamal deck"
```

---

### Task 6: Channel state + EIP-712 signing (`stateSig.ts`)

The exact typed-data layout the `ZkTable` contract will verify later — defining it now is what makes the parity test possible. Balances are `bigint` native-token wei. The struct is game-agnostic; games hash their own state into `gameStateHash`.

**Files:**
- Create: `examples/games/zk-core/src/stateSig.ts`
- Test: `examples/games/zk-core/test/stateSig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/stateSig.test.ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { signState, verifyStateSig, hashState, TEST_DOMAIN, type ChannelState } from '../src/stateSig'

const acct = privateKeyToAccount(generatePrivateKey())
const state: ChannelState = {
  tableId: '0x' + '11'.repeat(32) as `0x${string}`,
  nonce: 7n,
  balanceA: 90n * 10n ** 18n,
  balanceB: 104n * 10n ** 18n,
  pot: 6n * 10n ** 18n,
  deckCommitment: '0x' + '22'.repeat(32) as `0x${string}`,
  phase: 3,
  gameStateHash: '0x' + '33'.repeat(32) as `0x${string}`,
}

describe('channel state signing', () => {
  it('sign → verify round-trip', async () => {
    const sig = await signState(acct, TEST_DOMAIN, state)
    expect(await verifyStateSig(acct.address, TEST_DOMAIN, state, sig)).toBe(true)
  })
  it('rejects on any field change', async () => {
    const sig = await signState(acct, TEST_DOMAIN, state)
    expect(await verifyStateSig(acct.address, TEST_DOMAIN, { ...state, nonce: 8n }, sig)).toBe(false)
    expect(await verifyStateSig(acct.address, TEST_DOMAIN, { ...state, balanceA: state.balanceA + 1n }, sig)).toBe(false)
  })
  it('rejects wrong signer and wrong domain', async () => {
    const other = privateKeyToAccount(generatePrivateKey())
    const sig = await signState(acct, TEST_DOMAIN, state)
    expect(await verifyStateSig(other.address, TEST_DOMAIN, state, sig)).toBe(false)
    expect(await verifyStateSig(acct.address, { ...TEST_DOMAIN, chainId: 369 }, state, sig)).toBe(false)
  })
  it('hashState is stable and field-sensitive', () => {
    expect(hashState(TEST_DOMAIN, state)).toBe(hashState(TEST_DOMAIN, { ...state }))
    expect(hashState(TEST_DOMAIN, state)).not.toBe(hashState(TEST_DOMAIN, { ...state, phase: 4 }))
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/stateSig.ts
import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem'

export interface ChannelState {
  tableId: Hex          // bytes32
  nonce: bigint         // uint64, strictly increasing
  balanceA: bigint      // uint256 wei
  balanceB: bigint
  pot: bigint           // in-flight pot (incl. war carry); invariant: A+B+pot == escrow
  deckCommitment: Hex   // bytes32 keccak of serialized masked deck
  phase: number         // uint8, game-defined
  gameStateHash: Hex    // bytes32, game package owns the preimage
}

export interface ChannelDomain {
  name: 'ZkTable'; version: '1'; chainId: number; verifyingContract: Hex
}
/** anvil chainId + placeholder address; the contracts plan pins the real domain */
export const TEST_DOMAIN: ChannelDomain = {
  name: 'ZkTable', version: '1', chainId: 31337,
  verifyingContract: '0x00000000000000000000000000000000005a6b54',
}

export const CHANNEL_STATE_TYPES = {
  ChannelState: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'balanceA', type: 'uint256' },
    { name: 'balanceB', type: 'uint256' },
    { name: 'pot', type: 'uint256' },
    { name: 'deckCommitment', type: 'bytes32' },
    { name: 'phase', type: 'uint8' },
    { name: 'gameStateHash', type: 'bytes32' },
  ],
} as const

export interface StateSigner {
  address: Hex
  signTypedData(args: any): Promise<Hex>
}

export function hashState(domain: ChannelDomain, state: ChannelState): Hex {
  return hashTypedData({ domain, types: CHANNEL_STATE_TYPES, primaryType: 'ChannelState', message: state as any })
}
export async function signState(signer: StateSigner, domain: ChannelDomain, state: ChannelState): Promise<Hex> {
  return signer.signTypedData({ domain, types: CHANNEL_STATE_TYPES, primaryType: 'ChannelState', message: state })
}
export async function verifyStateSig(expected: Hex, domain: ChannelDomain, state: ChannelState, sig: Hex): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({
      domain, types: CHANNEL_STATE_TYPES, primaryType: 'ChannelState', message: state as any, signature: sig,
    })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch { return false }
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/games/zk-core
git commit -m "feat(zk-core): EIP-712 channel state signing (ZkTable domain)"
```

---

### Task 7: Channel co-signing machine (`channel.ts`)

Each party runs a `Channel`. One side proposes the next state (signed); the other validates against channel invariants + a game-supplied legality callback, then countersigns. `latestCoSigned` only ever advances on a fully co-signed state with `nonce == previous + 1`.

**Files:**
- Create: `examples/games/zk-core/src/channel.ts`
- Test: `examples/games/zk-core/test/channel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/channel.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { Channel, type CoSignedState } from '../src/channel'
import { TEST_DOMAIN, type ChannelState } from '../src/stateSig'

const A = privateKeyToAccount(generatePrivateKey())
const B = privateKeyToAccount(generatePrivateKey())
const ESCROW = 200n
const base: ChannelState = {
  tableId: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  nonce: 0n, balanceA: 100n, balanceB: 100n, pot: 0n,
  deckCommitment: ('0x' + '00'.repeat(32)) as `0x${string}`,
  phase: 0, gameStateHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
}
const next = (s: ChannelState, patch: Partial<ChannelState>): ChannelState =>
  ({ ...s, ...patch, nonce: s.nonce + 1n })

let chA: Channel, chB: Channel
beforeEach(async () => {
  chA = new Channel({ domain: TEST_DOMAIN, me: A, peer: B.address, role: 'A', escrow: ESCROW })
  chB = new Channel({ domain: TEST_DOMAIN, me: B, peer: A.address, role: 'B', escrow: ESCROW })
  const genesis = await chA.propose(base) // nonce 0 allowed only as genesis
  const counter = await chB.accept(genesis)
  await chA.finalize(counter)
})

describe('channel co-signing', () => {
  it('advances on propose → accept → finalize', async () => {
    const p = await chA.propose(next(chA.latest!.state, { pot: 2n, balanceA: 99n, balanceB: 99n }))
    const c = await chB.accept(p)
    await chA.finalize(c)
    expect(chA.latest!.state.nonce).toBe(1n)
    expect(chB.latest!.state.nonce).toBe(1n)
    expect(chA.latest!.sigA && chA.latest!.sigB).toBeTruthy()
  })
  it('rejects non-incrementing nonce', async () => {
    const p = await chA.propose(next(chA.latest!.state, {}))
    const c = await chB.accept(p); await chA.finalize(c)
    const stale = { ...p } // nonce 1 again
    await expect(chB.accept(stale)).rejects.toThrow(/nonce/)
  })
  it('rejects conservation violation', async () => {
    await expect(
      chA.propose(next(chA.latest!.state, { balanceA: 150n })) // A+B+pot > escrow
    ).rejects.toThrow(/conservation/)
  })
  it('rejects bad proposer signature', async () => {
    const p = await chA.propose(next(chA.latest!.state, { pot: 2n, balanceA: 99n, balanceB: 99n }))
    p.sigA = (p.sigA!.slice(0, -2) + (p.sigA!.endsWith('00') ? '01' : '00')) as `0x${string}`
    await expect(chB.accept(p)).rejects.toThrow(/signature/)
  })
  it('rejects when game legality callback vetoes', async () => {
    chB.setLegality(() => 'illegal: phase skip')
    const p = await chA.propose(next(chA.latest!.state, { phase: 9 }))
    await expect(chB.accept(p)).rejects.toThrow(/illegal: phase skip/)
  })
  it('negative balances are impossible', async () => {
    await expect(
      chA.propose(next(chA.latest!.state, { balanceA: -1n as unknown as bigint, pot: 101n }))
    ).rejects.toThrow(/negative/)
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/channel.ts
import type { Hex } from 'viem'
import {
  signState, verifyStateSig, type ChannelDomain, type ChannelState, type StateSigner,
} from './stateSig'

export interface CoSignedState { state: ChannelState; sigA?: Hex; sigB?: Hex }
export type Legality = (prev: ChannelState | null, proposed: ChannelState) => string | null

export interface ChannelConfig {
  domain: ChannelDomain
  me: StateSigner
  peer: Hex
  role: 'A' | 'B'
  escrow: bigint            // total locked on-chain for this table
}

export class Channel {
  latest: CoSignedState | null = null
  private legality: Legality = () => null
  constructor(private cfg: ChannelConfig) {}

  setLegality(fn: Legality): void { this.legality = fn }

  private validate(proposed: ChannelState): void {
    const prev = this.latest?.state ?? null
    if (proposed.balanceA < 0n || proposed.balanceB < 0n || proposed.pot < 0n)
      throw new Error('channel: negative amount')
    if (proposed.balanceA + proposed.balanceB + proposed.pot !== this.cfg.escrow)
      throw new Error('channel: conservation violated (A+B+pot != escrow)')
    if (prev === null) {
      if (proposed.nonce !== 0n) throw new Error('channel: genesis nonce must be 0')
    } else if (proposed.nonce !== prev.nonce + 1n) {
      throw new Error(`channel: nonce must be ${prev.nonce + 1n}, got ${proposed.nonce}`)
    }
    const veto = this.legality(prev, proposed)
    if (veto) throw new Error(veto)
  }

  private mySigSlot(): 'sigA' | 'sigB' { return this.cfg.role === 'A' ? 'sigA' : 'sigB' }
  private peerSigSlot(): 'sigA' | 'sigB' { return this.cfg.role === 'A' ? 'sigB' : 'sigA' }

  /** I author the next state and sign it */
  async propose(state: ChannelState): Promise<CoSignedState> {
    this.validate(state)
    const sig = await signState(this.cfg.me, this.cfg.domain, state)
    return { state, [this.mySigSlot()]: sig } as CoSignedState
  }

  /** peer proposed; validate, countersign, adopt */
  async accept(proposal: CoSignedState): Promise<CoSignedState> {
    this.validate(proposal.state)
    const peerSig = proposal[this.peerSigSlot()]
    if (!peerSig || !(await verifyStateSig(this.cfg.peer, this.cfg.domain, proposal.state, peerSig)))
      throw new Error('channel: bad peer signature on proposal')
    const mine = await signState(this.cfg.me, this.cfg.domain, proposal.state)
    const full: CoSignedState = { ...proposal, [this.mySigSlot()]: mine }
    this.latest = full
    return full
  }

  /** proposer adopts the countersigned state */
  async finalize(countersigned: CoSignedState): Promise<void> {
    const { state } = countersigned
    const expectedNonce = this.latest === null ? 0n : this.latest.state.nonce + 1n
    if (state.nonce !== expectedNonce && !(this.latest && state.nonce === this.latest.state.nonce && !this.fullySigned(this.latest)))
      if (state.nonce !== expectedNonce) throw new Error('channel: finalize nonce mismatch')
    const peerSig = countersigned[this.peerSigSlot()]
    const mySig = countersigned[this.mySigSlot()]
    if (!peerSig || !(await verifyStateSig(this.cfg.peer, this.cfg.domain, state, peerSig)))
      throw new Error('channel: bad peer countersignature')
    if (!mySig || !(await verifyStateSig(this.cfg.me.address, this.cfg.domain, state, mySig)))
      throw new Error('channel: my signature missing on finalize')
    this.latest = countersigned
  }

  fullySigned(s: CoSignedState): boolean { return Boolean(s.sigA && s.sigB) }
}
```

Then simplify `finalize`'s nonce guard — the double-check above is overwrought. Replace the first four lines of `finalize` body with:

```ts
    const { state } = countersigned
    const expectedNonce = this.latest === null ? 0n : this.latest.state.nonce + 1n
    if (state.nonce !== expectedNonce) throw new Error('channel: finalize nonce mismatch')
```

- [ ] **Step 4: Run tests** — Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/games/zk-core
git commit -m "feat(zk-core): co-signed channel state machine with conservation + nonce invariants"
```

---

### Task 8: Transcript + transport (`transcript.ts`, `transport.ts`)

Every protocol message rides a signed, hash-chained envelope — that chain is what the MsgBoard mirror posts and what the verify panel replays. Transport is a dumb interface; `LocalTransport` is an in-process pair with injectable delay/drop for adversarial tests.

**Files:**
- Create: `examples/games/zk-core/src/transcript.ts`
- Create: `examples/games/zk-core/src/transport.ts`
- Test: `examples/games/zk-core/test/transcript.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/transcript.test.ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { Transcript, makeEnvelope, verifyEnvelope } from '../src/transcript'
import { LocalTransport } from '../src/transport'

const A = privateKeyToAccount(generatePrivateKey())
const B = privateKeyToAccount(generatePrivateKey())
const tableId = ('0x' + 'cd'.repeat(32)) as `0x${string}`

describe('transcript', () => {
  it('appends signed envelopes, hash-chained, and verifies end to end', async () => {
    const t = new Transcript(tableId)
    const e1 = await makeEnvelope(A, tableId, 0, t.head, 'KEYGEN', { pub: '0x01' })
    t.append(e1)
    const e2 = await makeEnvelope(B, tableId, 1, t.head, 'KEYGEN', { pub: '0x02' })
    t.append(e2)
    expect(t.entries).toHaveLength(2)
    expect(await t.verify({ A: A.address, B: B.address })).toBe(true)
  })
  it('rejects out-of-order seq and broken chain', async () => {
    const t = new Transcript(tableId)
    const e1 = await makeEnvelope(A, tableId, 0, t.head, 'X', {})
    t.append(e1)
    const wrongSeq = await makeEnvelope(B, tableId, 5, t.head, 'X', {})
    expect(() => t.append(wrongSeq)).toThrow(/seq/)
    const wrongPrev = await makeEnvelope(B, tableId, 1, ('0x' + 'ee'.repeat(32)) as `0x${string}`, 'X', {})
    expect(() => t.append(wrongPrev)).toThrow(/chain/)
  })
  it('verify fails if a body is tampered after the fact', async () => {
    const t = new Transcript(tableId)
    t.append(await makeEnvelope(A, tableId, 0, t.head, 'X', { v: 1 }))
    ;(t.entries[0].body as any).v = 2
    expect(await t.verify({ A: A.address, B: B.address })).toBe(false)
  })
  it('round-trips through JSON', async () => {
    const t = new Transcript(tableId)
    t.append(await makeEnvelope(A, tableId, 0, t.head, 'X', { v: 1 }))
    const t2 = Transcript.fromJSON(t.toJSON())
    expect(await t2.verify({ A: A.address, B: B.address })).toBe(true)
  })
})

describe('local transport', () => {
  it('delivers both directions; drop injection loses messages', async () => {
    const [ta, tb] = LocalTransport.pair()
    const got: string[] = []
    tb.onMessage((m) => got.push(m as string))
    await ta.send('one')
    ta.dropNext()
    await ta.send('two')
    await ta.send('three')
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual(['one', 'three'])
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement transcript**

```ts
// src/transcript.ts
import { keccak256, stringToHex, recoverMessageAddress, type Hex } from 'viem'

export interface Envelope {
  tableId: Hex
  seq: number
  prev: Hex            // head hash before this entry (chain link)
  kind: string         // 'KEYGEN' | 'SHUFFLE' | 'DEAL_SHARE' | game moves...
  body: unknown        // JSON-serializable; hex blobs inside
  from: Hex            // signer address
  sig: Hex             // EIP-191 over the entry digest
}

export interface EnvelopeSigner { address: Hex; signMessage(a: { message: { raw: Hex } }): Promise<Hex> }

const GENESIS: Hex = `0x${'00'.repeat(32)}`

export function entryDigest(e: Omit<Envelope, 'sig' | 'from'>): Hex {
  return keccak256(stringToHex(JSON.stringify({
    tableId: e.tableId, seq: e.seq, prev: e.prev, kind: e.kind, body: e.body,
  })))
}

export async function makeEnvelope(
  signer: EnvelopeSigner, tableId: Hex, seq: number, prev: Hex, kind: string, body: unknown,
): Promise<Envelope> {
  const partial = { tableId, seq, prev, kind, body }
  const sig = await signer.signMessage({ message: { raw: entryDigest(partial) } })
  return { ...partial, from: signer.address, sig }
}

export async function verifyEnvelope(e: Envelope): Promise<boolean> {
  try {
    const rec = await recoverMessageAddress({ message: { raw: entryDigest(e) }, signature: e.sig })
    return rec.toLowerCase() === e.from.toLowerCase()
  } catch { return false }
}

export class Transcript {
  entries: Envelope[] = []
  head: Hex = GENESIS
  constructor(public tableId: Hex) {}

  append(e: Envelope): void {
    if (e.tableId !== this.tableId) throw new Error('transcript: wrong table')
    if (e.seq !== this.entries.length) throw new Error(`transcript: seq must be ${this.entries.length}`)
    if (e.prev !== this.head) throw new Error('transcript: chain break (prev != head)')
    this.entries.push(e)
    this.head = keccak256(`${this.head}${entryDigest(e).slice(2)}` as Hex)
  }

  /** full re-verification: chain links, seqs, signatures, signer membership */
  async verify(parties: { A: Hex; B: Hex }): Promise<boolean> {
    let head: Hex = GENESIS
    const ok = new Set([parties.A.toLowerCase(), parties.B.toLowerCase()])
    for (const [i, e] of this.entries.entries()) {
      if (e.seq !== i || e.prev !== head || e.tableId !== this.tableId) return false
      if (!ok.has(e.from.toLowerCase())) return false
      if (!(await verifyEnvelope(e))) return false
      head = keccak256(`${head}${entryDigest(e).slice(2)}` as Hex)
    }
    return head === this.head
  }

  toJSON(): string { return JSON.stringify({ tableId: this.tableId, head: this.head, entries: this.entries }) }
  static fromJSON(s: string): Transcript {
    const o = JSON.parse(s)
    const t = new Transcript(o.tableId)
    t.entries = o.entries
    t.head = o.head
    return t
  }
}
```

- [ ] **Step 4: Implement transport**

```ts
// src/transport.ts
export type MessageHandler = (msg: unknown) => void

export interface Transport {
  send(msg: unknown): Promise<void>
  onMessage(handler: MessageHandler): void
}

/** in-process pair with injectable faults, for engine tests */
export class LocalTransport implements Transport {
  private handler: MessageHandler = () => {}
  private peer!: LocalTransport
  private drops = 0
  delayMs = 0

  static pair(): [LocalTransport, LocalTransport] {
    const a = new LocalTransport(), b = new LocalTransport()
    a.peer = b; b.peer = a
    return [a, b]
  }
  dropNext(n = 1): void { this.drops += n }
  async send(msg: unknown): Promise<void> {
    if (this.drops > 0) { this.drops--; return }
    const deliver = () => this.peer.handler(structuredClone(msg))
    if (this.delayMs > 0) setTimeout(deliver, this.delayMs)
    else queueMicrotask(deliver)
  }
  onMessage(handler: MessageHandler): void { this.handler = handler }
}
```

- [ ] **Step 5: Run tests** — Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add examples/games/zk-core
git commit -m "feat(zk-core): signed hash-chained transcript + local transport with fault injection"
```

---

### Task 9: Dispute evidence builder (`dispute.ts`)

What a client hands to `ZkTable.openDispute(...)` later: the latest fully co-signed state plus the signed messages after it, and a machine-readable statement of what the counterparty owes next. No chain code here — just the evidence shape and stall detection.

**Files:**
- Create: `examples/games/zk-core/src/dispute.ts`
- Test: `examples/games/zk-core/test/dispute.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/dispute.test.ts
import { describe, it, expect } from 'vitest'
import { buildEvidence, type DisputeEvidence } from '../src/dispute'
import { Transcript, makeEnvelope } from '../src/transcript'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import type { CoSignedState } from '../src/channel'
import { TEST_DOMAIN, type ChannelState } from '../src/stateSig'

const A = privateKeyToAccount(generatePrivateKey())
const tableId = ('0x' + 'ef'.repeat(32)) as `0x${string}`
const coSigned: CoSignedState = {
  state: {
    tableId, nonce: 4n, balanceA: 90n, balanceB: 100n, pot: 10n,
    deckCommitment: ('0x' + '11'.repeat(32)) as `0x${string}`,
    phase: 2, gameStateHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
  },
  sigA: '0xaa', sigB: '0xbb',
}

describe('dispute evidence', () => {
  it('packages latest co-signed state + post-state messages + the demand', async () => {
    const t = new Transcript(tableId)
    t.append(await makeEnvelope(A, tableId, 0, t.head, 'BET_COMMIT', { c: '0x01' }))
    const ev: DisputeEvidence = buildEvidence({
      coSigned, transcript: t, sinceSeq: 0,
      demand: { from: 'B', kind: 'DEAL_SHARE', detail: 'share for slot 9' },
    })
    expect(ev.state.nonce).toBe(4n)
    expect(ev.messages).toHaveLength(1)
    expect(ev.demand.from).toBe('B')
    expect(JSON.parse(ev.serialized).demand.kind).toBe('DEAL_SHARE')
  })
  it('refuses to build evidence from a half-signed state', () => {
    expect(() => buildEvidence({
      coSigned: { ...coSigned, sigB: undefined }, transcript: new Transcript(tableId),
      sinceSeq: 0, demand: { from: 'A', kind: 'X', detail: '' },
    })).toThrow(/co-signed/)
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/dispute.ts
import type { CoSignedState } from './channel'
import type { ChannelState } from './stateSig'
import type { Envelope, Transcript } from './transcript'

export interface Demand { from: 'A' | 'B'; kind: string; detail: string }

export interface DisputeEvidence {
  state: ChannelState
  sigA: string
  sigB: string
  messages: Envelope[]   // signed protocol messages after the co-signed state
  demand: Demand         // what the counterparty owes next (drives the chess clock)
  serialized: string     // JSON for transport/mirroring (bigints as strings)
}

export function buildEvidence(args: {
  coSigned: CoSignedState
  transcript: Transcript
  sinceSeq: number
  demand: Demand
}): DisputeEvidence {
  const { coSigned, transcript, sinceSeq, demand } = args
  if (!coSigned.sigA || !coSigned.sigB)
    throw new Error('dispute: latest state must be fully co-signed')
  const messages = transcript.entries.filter((e) => e.seq >= sinceSeq)
  const body = {
    state: coSigned.state, sigA: coSigned.sigA, sigB: coSigned.sigB, messages, demand,
  }
  return {
    state: coSigned.state, sigA: coSigned.sigA, sigB: coSigned.sigB, messages, demand,
    serialized: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  }
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Export everything and commit**

```ts
// src/index.ts
export * from './cards'
export * from './elgamal'
export * from './chaumPedersen'
export * from './maskedDeck'
export * from './attestedDeck'
export * from './stateSig'
export * from './channel'
export * from './transcript'
export * from './transport'
export * from './dispute'
```

Run: `pnpm test && pnpm typecheck` — Expected: all green.

```bash
git add examples/games/zk-core
git commit -m "feat(zk-core): dispute evidence builder + package exports"
```

---

### Task 10: Scaffold `@gibs/hilo-war`

**Files:**
- Create: `examples/games/hilo-war/package.json`
- Create: `examples/games/hilo-war/tsconfig.json`
- Create: `examples/games/hilo-war/src/index.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "@gibs/hilo-war",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@gibs/zk-cards-core": "workspace:*",
    "viem": "^2.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "~5.8.3",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: tsconfig.json** — same shape as zk-core's (Task 1 Step 2).

- [ ] **Step 3: placeholder `src/index.ts`** (`export {}`), then:

Run: `cd ~/Documents/gibs-finance/random && pnpm install`
Expected: workspace link resolves.

- [ ] **Step 4: Commit**

```bash
git add examples/games/hilo-war pnpm-lock.yaml
git commit -m "chore(hilo-war): scaffold @gibs/hilo-war package"
```

---

### Task 11: Hi-Lo War rules (`rules.ts`)

Pure functions only — this module is the off-chain twin of the future `HiLoWarRules` contract, so zero IO, zero crypto, zero randomness. It models exactly the spec's flip:

deal (both antes → pot) → simultaneous bet commit → bet open → if exactly one RAISE: call-or-fold → showdown (or fold resolution) → tie carries pot (war), else pot pays out → next flip or reshuffle boundary or stop.

Phases (the `ChannelState.phase` byte): `0 SETUP, 1 DEAL, 2 BET_COMMIT, 3 BET_OPEN, 4 CALL_OR_FOLD, 5 SHOWDOWN, 6 FLIP_DONE, 7 SETTLED`.

**Files:**
- Create: `examples/games/hilo-war/src/rules.ts`
- Test: `examples/games/hilo-war/test/rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/rules.test.ts
import { describe, it, expect } from 'vitest'
import {
  initialFlipState, applyMove, hashGameState, Phase, type HiLoState, type Move,
} from '../src/rules'

const ANTE = 5n
function freshState(): HiLoState {
  return initialFlipState({ ante: ANTE, deckIndex: 0, warPot: 0n })
}
// helper: run a list of moves, returning the final state
function run(s: HiLoState, moves: Move[]): HiLoState {
  return moves.reduce((acc, m) => {
    const r = applyMove(acc, m, ANTE)
    if ('error' in r) throw new Error(r.error)
    return r.state
  }, s)
}
const commitA: Move = { kind: 'BET_COMMIT', by: 'A', commitment: '0x' + 'a1'.repeat(32) }
const commitB: Move = { kind: 'BET_COMMIT', by: 'B', commitment: '0x' + 'b1'.repeat(32) }

describe('hilo-war rules', () => {
  it('full showdown path: deal → commits → opens(hold,hold) → showdown', () => {
    let s = freshState()
    expect(s.phase).toBe(Phase.DEAL)
    s = run(s, [
      { kind: 'DEAL_DONE' },                               // both shares exchanged off rules
      commitA, commitB,
      { kind: 'BET_OPEN', by: 'A', bet: 'HOLD', salt: '0x01' },
      { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: '0x02' },
    ])
    expect(s.phase).toBe(Phase.SHOWDOWN)
    s = run(s, [{ kind: 'SHOWDOWN', cardA: 51, cardB: 0 }]) // A♠ vs 2♣
    expect(s.phase).toBe(Phase.FLIP_DONE)
    expect(s.result).toEqual({ winner: 'A', amount: 2n * ANTE })
    expect(s.warPot).toBe(0n)
  })
  it('raise/call doubles the pot; raise/fold pays raiser without showdown', () => {
    let s = run(freshState(), [
      { kind: 'DEAL_DONE' }, commitA, commitB,
      { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: '0x01' },
      { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: '0x02' },
    ])
    expect(s.phase).toBe(Phase.CALL_OR_FOLD)
    const folded = run(s, [{ kind: 'FOLD', by: 'B' }])
    expect(folded.phase).toBe(Phase.FLIP_DONE)
    expect(folded.result).toEqual({ winner: 'A', amount: 3n * ANTE }) // 2 antes + A's raise
    expect(folded.foldedCardHidden).toBe(true)

    const called = run(s, [{ kind: 'CALL', by: 'B' }])
    expect(called.phase).toBe(Phase.SHOWDOWN)
    expect(called.pot).toBe(4n * ANTE) // 2 antes + raise + call
  })
  it('tie carries the war pot into the next flip', () => {
    let s = run(freshState(), [
      { kind: 'DEAL_DONE' }, commitA, commitB,
      { kind: 'BET_OPEN', by: 'A', bet: 'HOLD', salt: '0x01' },
      { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: '0x02' },
      { kind: 'SHOWDOWN', cardA: 0, cardB: 1 },            // 2♣ vs 2♦ — tie
    ])
    expect(s.result).toBeNull()
    expect(s.warPot).toBe(2n * ANTE)
    const next = initialFlipState({ ante: ANTE, deckIndex: s.deckIndex + 2, warPot: s.warPot })
    expect(next.pot).toBe(0n)
    expect(next.warPot).toBe(2n * ANTE)
  })
  it('both raise → showdown with both raises in the pot, no call phase', () => {
    const s = run(freshState(), [
      { kind: 'DEAL_DONE' }, commitA, commitB,
      { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: '0x01' },
      { kind: 'BET_OPEN', by: 'B', bet: 'RAISE', salt: '0x02' },
    ])
    expect(s.phase).toBe(Phase.SHOWDOWN)
    expect(s.pot).toBe(4n * ANTE)
  })
  it('rejects out-of-phase and duplicate moves', () => {
    let s = freshState()
    expect(applyMove(s, commitA, ANTE)).toHaveProperty('error')      // commit before deal done
    s = run(s, [{ kind: 'DEAL_DONE' }, commitA])
    expect(applyMove(s, commitA, ANTE)).toHaveProperty('error')      // duplicate commit
    expect(applyMove(s, { kind: 'SHOWDOWN', cardA: 0, cardB: 1 }, ANTE)).toHaveProperty('error')
  })
  it('bet open must match its commitment', () => {
    const realCommit = hashBetCommit('RAISE', '0xfeed')
    let s = run(freshState(), [
      { kind: 'DEAL_DONE' },
      { kind: 'BET_COMMIT', by: 'A', commitment: realCommit }, commitB,
    ])
    expect(applyMove(s, { kind: 'BET_OPEN', by: 'A', bet: 'HOLD', salt: '0xfeed' }, ANTE)).toHaveProperty('error')
    const ok = applyMove(s, { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: '0xfeed' }, ANTE)
    expect(ok).not.toHaveProperty('error')
  })
  it('pot accounting conserves: antes+raises in == result out (+war carry)', () => {
    const s = run(freshState(), [
      { kind: 'DEAL_DONE' }, commitA, commitB,
      { kind: 'BET_OPEN', by: 'A', bet: 'RAISE', salt: '0x01' },
      { kind: 'BET_OPEN', by: 'B', bet: 'HOLD', salt: '0x02' },
      { kind: 'CALL', by: 'B' },
      { kind: 'SHOWDOWN', cardA: 4, cardB: 51 },
    ])
    expect(s.result!.amount).toBe(s.contributed.A + s.contributed.B)
  })
  it('hashGameState is stable & sensitive', () => {
    const s = freshState()
    expect(hashGameState(s)).toBe(hashGameState({ ...s }))
    expect(hashGameState(s)).not.toBe(hashGameState({ ...s, deckIndex: 2 }))
  })
})
import { hashBetCommit } from '../src/rules'
```

(Move the last import up top when writing the real file.)

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/rules.ts
import { keccak256, stringToHex, concatHex, type Hex } from 'viem'

export enum Phase { SETUP = 0, DEAL = 1, BET_COMMIT = 2, BET_OPEN = 3, CALL_OR_FOLD = 4, SHOWDOWN = 5, FLIP_DONE = 6, SETTLED = 7 }
export type Seat = 'A' | 'B'
export type Bet = 'RAISE' | 'HOLD'

export interface HiLoState {
  phase: Phase
  deckIndex: number            // next undealt slot; this flip uses deckIndex (A) and deckIndex+1 (B)
  pot: bigint                  // this flip's pot (antes + raises), excludes warPot until showdown
  warPot: bigint               // carried from tied flips
  contributed: { A: bigint; B: bigint }
  commits: Partial<Record<Seat, Hex>>
  bets: Partial<Record<Seat, Bet>>
  raiser: Seat | null          // set when exactly one raised
  result: { winner: Seat; amount: bigint } | null
  foldedCardHidden: boolean    // true iff flip ended by fold (loser's card never revealed)
}

export type Move =
  | { kind: 'DEAL_DONE' }                                   // session layer attests both private deals completed
  | { kind: 'BET_COMMIT'; by: Seat; commitment: Hex }
  | { kind: 'BET_OPEN'; by: Seat; bet: Bet; salt: Hex }
  | { kind: 'CALL'; by: Seat }
  | { kind: 'FOLD'; by: Seat }
  | { kind: 'SHOWDOWN'; cardA: number; cardB: number }      // session layer supplies unmasked indices

export type MoveResult = { state: HiLoState } | { error: string }

export function hashBetCommit(bet: Bet, salt: Hex): Hex {
  return keccak256(concatHex([stringToHex(`hilo-war/bet/${bet}/`), salt]))
}

export function initialFlipState(args: { ante: bigint; deckIndex: number; warPot: bigint }): HiLoState {
  return {
    phase: Phase.DEAL, deckIndex: args.deckIndex, pot: 0n, warPot: args.warPot,
    contributed: { A: 0n, B: 0n }, commits: {}, bets: {}, raiser: null,
    result: null, foldedCardHidden: false,
  }
}

const rankOf = (i: number) => Math.floor(i / 4) + 2  // duplicated tiny helper keeps rules dependency-free

export function applyMove(s: HiLoState, m: Move, ante: bigint): MoveResult {
  const err = (e: string): MoveResult => ({ error: `hilo-war: ${e}` })
  switch (m.kind) {
    case 'DEAL_DONE': {
      if (s.phase !== Phase.DEAL) return err(`DEAL_DONE in phase ${s.phase}`)
      return { state: { ...s, phase: Phase.BET_COMMIT, pot: 2n * ante, contributed: { A: ante, B: ante } } }
    }
    case 'BET_COMMIT': {
      if (s.phase !== Phase.BET_COMMIT) return err(`BET_COMMIT in phase ${s.phase}`)
      if (s.commits[m.by]) return err(`duplicate commit from ${m.by}`)
      const commits = { ...s.commits, [m.by]: m.commitment }
      const phase = commits.A && commits.B ? Phase.BET_OPEN : Phase.BET_COMMIT
      return { state: { ...s, commits, phase } }
    }
    case 'BET_OPEN': {
      if (s.phase !== Phase.BET_OPEN) return err(`BET_OPEN in phase ${s.phase}`)
      if (s.bets[m.by]) return err(`duplicate open from ${m.by}`)
      if (s.commits[m.by] !== hashBetCommit(m.bet, m.salt)) return err(`open does not match commitment from ${m.by}`)
      const bets = { ...s.bets, [m.by]: m.bet }
      let next: HiLoState = { ...s, bets }
      if (m.bet === 'RAISE') {
        next = { ...next, pot: next.pot + ante, contributed: { ...next.contributed, [m.by]: next.contributed[m.by] + ante } }
      }
      if (!(bets.A && bets.B)) return { state: next }
      // both open
      if (bets.A === 'RAISE' && bets.B === 'RAISE') return { state: { ...next, phase: Phase.SHOWDOWN, raiser: null } }
      if (bets.A === 'HOLD' && bets.B === 'HOLD') return { state: { ...next, phase: Phase.SHOWDOWN, raiser: null } }
      const raiser: Seat = bets.A === 'RAISE' ? 'A' : 'B'
      return { state: { ...next, phase: Phase.CALL_OR_FOLD, raiser } }
    }
    case 'CALL': {
      if (s.phase !== Phase.CALL_OR_FOLD) return err(`CALL in phase ${s.phase}`)
      if (m.by === s.raiser) return err('raiser cannot call own raise')
      return { state: {
        ...s, phase: Phase.SHOWDOWN,
        pot: s.pot + ante, contributed: { ...s.contributed, [m.by]: s.contributed[m.by] + ante },
      } }
    }
    case 'FOLD': {
      if (s.phase !== Phase.CALL_OR_FOLD) return err(`FOLD in phase ${s.phase}`)
      if (m.by === s.raiser) return err('raiser cannot fold own raise')
      const winner = s.raiser!
      return { state: {
        ...s, phase: Phase.FLIP_DONE, foldedCardHidden: true,
        result: { winner, amount: s.pot + s.warPot }, warPot: 0n,
      } }
    }
    case 'SHOWDOWN': {
      if (s.phase !== Phase.SHOWDOWN) return err(`SHOWDOWN in phase ${s.phase}`)
      const ra = rankOf(m.cardA), rb = rankOf(m.cardB)
      if (ra === rb) {
        return { state: { ...s, phase: Phase.FLIP_DONE, result: null, warPot: s.warPot + s.pot, pot: 0n } }
      }
      const winner: Seat = ra > rb ? 'A' : 'B'
      return { state: { ...s, phase: Phase.FLIP_DONE, result: { winner, amount: s.pot + s.warPot }, warPot: 0n } }
    }
  }
}

export function hashGameState(s: HiLoState): Hex {
  return keccak256(stringToHex(JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? v.toString() : v))))
}
```

- [ ] **Step 4: Run tests** — Expected: PASS (8 tests). The conservation test passes because fold pays `pot + warPot` where `pot == contributed.A + contributed.B` and the test's war pot is 0; showdown pays the same sum.

- [ ] **Step 5: Commit**

```bash
git add examples/games/hilo-war
git commit -m "feat(hilo-war): pure flip rules — commit/open betting, fold, war pot, conservation"
```

---

### Task 12: Session driver (`session.ts`) + happy-path test

Wires everything: deck provider + channel + transcript + transport + rules. Each `Player` is symmetric; messages drive a small per-flip protocol. The session driver is the part the web client and bots will reuse verbatim.

Design notes the implementer needs:
- **Private deal:** for slot `2k` (A's card), B computes and sends *his* share with proof; A combines with her own (local, never sent) share to unmask. Symmetric for B. A share you never send is a card the other side cannot see — and a folded card means the winning side's share for it is simply never requested.
- **Showdown:** each player sends the share for *their own* card slot (the one they withheld), making both cards publicly computable; both feed `SHOWDOWN` with the unmasked indices into rules and must agree.
- **Channel sync:** after each rules-visible step, A proposes the next `ChannelState` (phase from rules, `gameStateHash = hashGameState`, balances unchanged until `FLIP_DONE`, where the pot result moves balances), B accepts, A finalizes. Genesis (nonce 0) carries the post-shuffle `deckCommitment`.
- **Reshuffle:** when `deckIndex + 1 >= 52`, run the Task 5 shuffle flow again over a fresh `initialDeck` (v1 remasks a fresh 52 per spec), new deckCommitment in the next co-signed state.

**Files:**
- Create: `examples/games/hilo-war/src/session.ts`
- Test: `examples/games/hilo-war/test/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/session.test.ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { AttestedElGamalDeck, LocalTransport, TEST_DOMAIN } from '@gibs/zk-cards-core'
import { Player, openSession } from '../src/session'

const ANTE = 5n, ESCROW_EACH = 100n

async function freshPair() {
  const [ta, tb] = LocalTransport.pair()
  const wa = privateKeyToAccount(generatePrivateKey())
  const wb = privateKeyToAccount(generatePrivateKey())
  const deck = new AttestedElGamalDeck()
  const tableId = ('0x' + '77'.repeat(32)) as `0x${string}`
  const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH })
  const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain: TEST_DOMAIN, tableId, ante: ANTE, escrowEach: ESCROW_EACH })
  return { a, b }
}

describe('hilo-war session', () => {
  it('setup co-signs genesis with a deck commitment', async () => {
    const { a, b } = await freshPair()
    await openSession(a, b)
    expect(a.channel.latest!.state.nonce).toBe(0n)
    expect(a.channel.latest!.state.deckCommitment).toBe(b.channel.latest!.state.deckCommitment)
    expect(a.channel.fullySigned(a.channel.latest!)).toBe(true)
  })

  it('plays three hold/hold flips to completion; balances move by rank', async () => {
    const { a, b } = await freshPair()
    await openSession(a, b)
    for (let k = 0; k < 3; k++) {
      const res = await Promise.all([
        a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }),
        b.playFlip({ bet: 'HOLD', onRaise: 'CALL' }),
      ])
      expect(res[0].flip).toEqual(res[1].flip) // both sides agree on the outcome
      // each saw their own card during the flip
      expect(res[0].myCard).toBeGreaterThanOrEqual(0)
      expect(res[1].myCard).toBeGreaterThanOrEqual(0)
    }
    const s = a.channel.latest!.state
    expect(s.balanceA + s.balanceB + s.pot).toBe(2n * ESCROW_EACH)
    expect(s.nonce).toBeGreaterThanOrEqual(3n)
    // outcome matches rank comparison of the revealed cards
  })

  it('raise/fold: folder pays, folded card share never sent', async () => {
    const { a, b } = await freshPair()
    await openSession(a, b)
    const [ra, rb] = await Promise.all([
      a.playFlip({ bet: 'RAISE', onRaise: 'CALL' }),
      b.playFlip({ bet: 'HOLD', onRaise: 'FOLD' }),
    ])
    expect(ra.flip.foldedCardHidden).toBe(true)
    expect(ra.flip.result!.winner).toBe('A')
    // A never received B's own-card share: A cannot unmask B's card
    expect(ra.opponentCard).toBeNull()
    const s = a.channel.latest!.state
    // pot at fold = 2 antes + A's raise = 3·ante, of which A contributed 2·ante,
    // so A nets exactly one ante
    expect(s.balanceA).toBe(ESCROW_EACH + ANTE)
  })

  it('cooperative settle produces a fully co-signed SETTLED state', async () => {
    const { a, b } = await freshPair()
    await openSession(a, b)
    await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    const [fa, fb] = await Promise.all([a.requestSettle(), b.acceptSettle()])
    expect(fa.state.phase).toBe(7) // SETTLED
    expect(fa.sigA && fa.sigB).toBeTruthy()
    expect(fa.state.balanceA + fa.state.balanceB).toBe(2n * ESCROW_EACH)
    expect(fa.state.pot).toBe(0n)
  })
})
```

**Fold-payout arithmetic, for the record:** on `raise → fold`, the pot at fold time is `2·ante (antes) + ante (A's raise) = 3·ante`, of which A contributed `2·ante`. Winner takes the pot: A's balance = `escrow − contributed + pot = 100 − 10 + 15 = 105 = ESCROW_EACH + ANTE` — which is what the test asserts.

- [ ] **Step 2: Run to verify failure** — FAIL (session missing).

- [ ] **Step 3: Implement the session driver**

The full file is long; its skeleton and every non-obvious part:

```ts
// src/session.ts
import { keccak256, concatHex, type Hex } from 'viem'
import {
  Channel, Transcript, makeEnvelope, buildEvidence, hashState,
  type MaskedDeckProvider, type WireMasked, type WireShare, type Transport,
  type ChannelDomain, type ChannelState, type CoSignedState, type Envelope,
} from '@gibs/zk-cards-core'
import {
  Phase, initialFlipState, applyMove, hashGameState, hashBetCommit,
  type HiLoState, type Seat, type Bet, type Move,
} from './rules'

export interface PlayerConfig {
  role: Seat
  wallet: { address: Hex; signMessage(a: any): Promise<Hex>; signTypedData(a: any): Promise<Hex> }
  peer: Hex
  transport: Transport
  deck: MaskedDeckProvider
  domain: ChannelDomain
  tableId: Hex
  ante: bigint
  escrowEach: bigint
}

export interface FlipChoices { bet: Bet; onRaise: 'CALL' | 'FOLD' }
export interface FlipOutcome { flip: HiLoState; myCard: number; opponentCard: number | null }

export class Player {
  channel: Channel
  transcript: Transcript
  flip: HiLoState | null = null
  private deckKeys!: { secret: Hex; pub: Hex }
  private peerPub!: Hex
  private agg!: Hex
  private maskedDeck!: WireMasked[]
  private inbox: Envelope[] = []
  private waiters: Array<{ kind: string; resolve: (e: Envelope) => void }> = []

  constructor(public cfg: PlayerConfig) {
    this.channel = new Channel({
      domain: cfg.domain, me: cfg.wallet, peer: cfg.peer, role: cfg.role,
      escrow: 2n * cfg.escrowEach,
    })
    this.transcript = new Transcript(cfg.tableId)
    cfg.transport.onMessage((m) => this.receive(m as Envelope))
  }

  private receive(e: Envelope): void {
    this.inbox.push(e)
    const i = this.waiters.findIndex((w) => w.kind === e.kind)
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(e)
  }
  /** await the next message of a kind (already-arrived messages count) */
  private waitFor(kind: string): Promise<Envelope> {
    const i = this.inbox.findIndex((e) => e.kind === kind && !(e as any).__consumed)
    if (i >= 0) { (this.inbox[i] as any).__consumed = true; return Promise.resolve(this.inbox[i]) }
    return new Promise((resolve) => this.waiters.push({ kind, resolve: (e) => { (e as any).__consumed = true; resolve(e) } }))
  }
  private async post(kind: string, body: unknown): Promise<void> {
    const e = await makeEnvelope(this.cfg.wallet, this.cfg.tableId, this.transcript.entries.length, this.transcript.head, kind, body)
    this.transcript.append(e)            // my own hash-chained send log
    await this.cfg.transport.send(e)
  }
  /**
   * Received peer envelopes are NOT re-chained into my transcript (re-stamping
   * seq/prev would break the peer's signature binding). Each party hash-chains
   * only what they SENT; received envelopes are signature-verified on receipt
   * (verifyEnvelope inside receive(); reject on failure) and kept in arrival
   * order in `inbox`, which doubles as the received log. The merged global
   * transcript — for dispute evidence and the future MsgBoard mirror — is
   * assembled deterministically from both logs (the per-flip protocol strictly
   * alternates, so the merge is unambiguous).
   */
}
```

…and the protocol methods (complete logic, write them exactly):

```ts
  /** SETUP: keygen ↔, aggregate, initial deck, A shuffles, B shuffles, genesis co-sign */
  async setup(): Promise<void> {
    this.deckKeys = await this.cfg.deck.keygen()
    await this.post('KEYGEN', { pub: this.deckKeys.pub })
    const peerKey = await this.waitFor('KEYGEN')
    this.peerPub = (peerKey.body as any).pub
    // canonical aggregation order: A's key first
    const pubs = this.cfg.role === 'A' ? [this.deckKeys.pub, this.peerPub] : [this.peerPub, this.deckKeys.pub]
    this.agg = this.cfg.deck.aggregate(pubs)

    if (this.cfg.role === 'A') {
      const d0 = await this.cfg.deck.initialDeck(this.agg)
      const s1 = await this.cfg.deck.shuffle(this.agg, d0, this.cfg.wallet)
      await this.post('SHUFFLE_A', { before: d0, after: s1 })
      const sb = await this.waitFor('SHUFFLE_B')
      const { before, after } = sb.body as any
      if (JSON.stringify(before) !== JSON.stringify(s1.deck)) throw new Error('B shuffled the wrong deck')
      if (!(await this.cfg.deck.verifyShuffle(this.agg, before, after, this.cfg.peer))) throw new Error('bad shuffle proof from B')
      this.maskedDeck = after.deck
    } else {
      const sa = await this.waitFor('SHUFFLE_A')
      const { before, after } = sa.body as any
      if (!(await this.cfg.deck.verifyShuffle(this.agg, before, after, this.cfg.peer))) throw new Error('bad shuffle proof from A')
      const s2 = await this.cfg.deck.shuffle(this.agg, after.deck, this.cfg.wallet)
      await this.post('SHUFFLE_B', { before: after.deck, after: s2 })
      this.maskedDeck = s2.deck
    }
    await this.coSign(this.genesisState())
    this.flip = initialFlipState({ ante: this.cfg.ante, deckIndex: 0, warPot: 0n })
  }

  private deckCommitment(): Hex {
    return keccak256(concatHex(this.maskedDeck.flatMap((m) => [m.c1, m.c2])))
  }
  private genesisState(): ChannelState {
    return {
      tableId: this.cfg.tableId, nonce: 0n,
      balanceA: this.cfg.escrowEach, balanceB: this.cfg.escrowEach, pot: 0n,
      deckCommitment: this.deckCommitment(), phase: Phase.SETUP,
      gameStateHash: ('0x' + '00'.repeat(32)) as Hex,
    }
  }

  /** A proposes/B accepts — role-symmetric helper */
  private async coSign(state: ChannelState): Promise<void> {
    if (this.cfg.role === 'A') {
      const p = await this.channel.propose(state)
      await this.post('STATE_PROPOSE', { coSigned: serializeCo(p) })
      const c = await this.waitFor('STATE_ACCEPT')
      await this.channel.finalize(deserializeCo((c.body as any).coSigned))
    } else {
      const p = await this.waitFor('STATE_PROPOSE')
      const full = await this.channel.accept(deserializeCo((p.body as any).coSigned))
      await this.post('STATE_ACCEPT', { coSigned: serializeCo(full) })
    }
  }
```

`serializeCo`/`deserializeCo` are 6-line JSON helpers converting the bigint fields (`nonce`, `balanceA`, `balanceB`, `pot`) to/from strings — put them at the bottom of session.ts.

`playFlip(choices)` (both sides call it concurrently; the internal messages keep them in lockstep):

```ts
  async playFlip(choices: FlipChoices): Promise<FlipOutcome> {
    const f0 = this.flip!
    const mySlot = f0.deckIndex + (this.cfg.role === 'A' ? 0 : 1)
    const theirSlot = f0.deckIndex + (this.cfg.role === 'A' ? 1 : 0)

    // 1. private deal: send MY share of THEIR card; receive THEIR share of MY card
    const ctxTheirs = `${this.cfg.tableId}/slot-${theirSlot}`
    const myShareOfTheirs = await this.cfg.deck.share(this.deckKeys.secret, this.maskedDeck[theirSlot], ctxTheirs)
    await this.post('DEAL_SHARE', { slot: theirSlot, share: myShareOfTheirs })
    const got = await this.waitFor('DEAL_SHARE')
    const { slot, share } = got.body as { slot: number; share: WireShare }
    if (slot !== mySlot) throw new Error('deal share for wrong slot')
    const ctxMine = `${this.cfg.tableId}/slot-${mySlot}`
    if (!(await this.cfg.deck.verifyShare(this.peerPub, this.maskedDeck[mySlot], share, ctxMine)))
      throw new Error('bad deal share from peer')   // dispute evidence in adversarial task
    const myOwnShare = await this.cfg.deck.share(this.deckKeys.secret, this.maskedDeck[mySlot], ctxMine)
    const myCard = this.cfg.deck.unmask(this.maskedDeck[mySlot], [share, myOwnShare])
    this.flip = mustApply(this.flip!, { kind: 'DEAL_DONE' }, this.cfg.ante)
    await this.syncFlipState()   // co-sign post-deal state (antes into pot)

    // 2. simultaneous bet: commit, then open only after both commits are in
    const salt = randomSalt()
    await this.post('BET_COMMIT', { commitment: hashBetCommit(choices.bet, salt) })
    const theirCommit = await this.waitFor('BET_COMMIT')
    this.flip = mustApply(this.flip!, { kind: 'BET_COMMIT', by: this.cfg.role, commitment: hashBetCommit(choices.bet, salt) }, this.cfg.ante)
    this.flip = mustApply(this.flip!, { kind: 'BET_COMMIT', by: other(this.cfg.role), commitment: (theirCommit.body as any).commitment }, this.cfg.ante)
    await this.post('BET_OPEN', { bet: choices.bet, salt })
    const theirOpen = await this.waitFor('BET_OPEN')
    // apply opens in seat order (A first) so both sides compute identical states
    const opens: Array<{ by: Seat; bet: Bet; salt: Hex }> = [
      { by: this.cfg.role, bet: choices.bet, salt },
      { by: other(this.cfg.role), bet: (theirOpen.body as any).bet, salt: (theirOpen.body as any).salt },
    ].sort((x) => (x.by === 'A' ? -1 : 1))
    for (const o of opens) this.flip = mustApply(this.flip!, { kind: 'BET_OPEN', ...o }, this.cfg.ante)

    // 3. call-or-fold if exactly one raised
    let folded = false
    if (this.flip!.phase === Phase.CALL_OR_FOLD) {
      if (this.flip!.raiser === this.cfg.role) {
        const resp = await this.waitFor('CALL_OR_FOLD')
        const move = (resp.body as any).move as 'CALL' | 'FOLD'
        this.flip = mustApply(this.flip!, { kind: move, by: other(this.cfg.role) }, this.cfg.ante)
        folded = move === 'FOLD'
      } else {
        await this.post('CALL_OR_FOLD', { move: choices.onRaise })
        this.flip = mustApply(this.flip!, { kind: choices.onRaise, by: this.cfg.role }, this.cfg.ante)
        folded = choices.onRaise === 'FOLD'
      }
    }

    // 4. showdown (skipped on fold): reveal own-card shares both ways
    let opponentCard: number | null = null
    if (!folded) {
      const myReveal = await this.cfg.deck.share(this.deckKeys.secret, this.maskedDeck[mySlot], ctxMine)
      await this.post('REVEAL_SHARE', { slot: mySlot, share: myReveal })
      const theirs = await this.waitFor('REVEAL_SHARE')
      const tb = theirs.body as { slot: number; share: WireShare }
      if (tb.slot !== theirSlot) throw new Error('reveal for wrong slot')
      if (!(await this.cfg.deck.verifyShare(this.peerPub, this.maskedDeck[theirSlot], tb.share, ctxTheirs)))
        throw new Error('bad reveal share from peer')
      opponentCard = this.cfg.deck.unmask(this.maskedDeck[theirSlot], [tb.share, myShareOfTheirs])
      const cardA = this.cfg.role === 'A' ? myCard : opponentCard
      const cardB = this.cfg.role === 'A' ? opponentCard : myCard
      this.flip = mustApply(this.flip!, { kind: 'SHOWDOWN', cardA, cardB }, this.cfg.ante)
    }

    // 5. settle the flip into channel balances and co-sign
    const done = this.flip!
    await this.syncFlipState()
    // 6. roll to the next flip (war pot carries; reshuffle if deck exhausted)
    const nextIndex = done.deckIndex + 2
    if (nextIndex + 1 >= this.maskedDeck.length) await this.reshuffle()
    this.flip = initialFlipState({
      ante: this.cfg.ante,
      deckIndex: nextIndex + 1 >= 52 ? 0 : nextIndex,
      warPot: done.warPot,
    })
    return { flip: done, myCard, opponentCard }
  }
```

Balance settlement inside `syncFlipState` (the only place balances change):

```ts
  private async syncFlipState(): Promise<void> {
    const prev = this.channel.latest!.state
    let { balanceA, balanceB } = prev
    let pot = this.flip!.pot + this.flip!.warPot
    if (this.flip!.phase === Phase.BET_COMMIT) {
      balanceA -= this.cfg.ante; balanceB -= this.cfg.ante       // antes entered the pot at DEAL_DONE
    } else if (this.flip!.phase === Phase.FLIP_DONE) {
      // pull raise/call contributions made since the post-deal state
      const extraA = this.flip!.contributed.A - this.cfg.ante
      const extraB = this.flip!.contributed.B - this.cfg.ante
      balanceA -= extraA; balanceB -= extraB
      if (this.flip!.result) {
        const amt = this.flip!.result.amount
        if (this.flip!.result.winner === 'A') balanceA += amt
        else balanceB += amt
        pot = this.flip!.warPot                                  // 0 unless tie carried
      } else {
        pot = this.flip!.warPot                                  // tie: pot became war carry
      }
    }
    await this.coSign({
      tableId: this.cfg.tableId, nonce: this.channel.latest!.state.nonce + 1n,
      balanceA, balanceB, pot,
      deckCommitment: this.deckCommitment(), phase: this.flip!.phase,
      gameStateHash: hashGameState(this.flip!),
    })
  }
```

Plus: `reshuffle()` (rerun the Task-5 shuffle flow over `initialDeck(this.agg)` with the same message kinds suffixed `_R${n}`), `requestSettle()`/`acceptSettle()` (propose/accept a `Phase.SETTLED` state with `pot` folded back: war carry at settle splits evenly per spec, odd unit to A — document it), `openSession(a, b) = Promise.all([a.setup(), b.setup()])`, `mustApply` (throws on rules error), `other(seat)`, `randomSalt()` (32 random bytes via `crypto.getRandomValues`, hex).

- [ ] **Step 4: Run the session test**

Run: `pnpm --filter @gibs/hilo-war test`
Expected: PASS (4 tests). These are concurrency-sensitive; if a test hangs, the bug is almost always one side awaiting a message kind the other never posts in that branch (check the fold path: the **raiser** must NOT wait for `REVEAL_SHARE`).

- [ ] **Step 5: Commit**

```bash
git add examples/games/hilo-war
git commit -m "feat(hilo-war): two-client session driver — setup, flips, settle over local transport"
```

---

### Task 13: Adversarial + edge-case suite

**Files:**
- Test: `examples/games/hilo-war/test/adversarial.test.ts`

Each test builds the standard pair, then sabotages one side. Sabotage by subclassing `Player` (export the internals it needs) or by injecting a wrapped `MaskedDeckProvider` / `Transport`.

- [ ] **Step 1: Write the suite**

```ts
// test/adversarial.test.ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { AttestedElGamalDeck, LocalTransport, TEST_DOMAIN, buildEvidence } from '@gibs/zk-cards-core'
import type { MaskedDeckProvider, WireShare, WireMasked } from '@gibs/zk-cards-core'
import { Player, openSession } from '../src/session'

// ... freshPair helper as in session.test.ts, but accepting a deck override per side

class GarbageShareDeck extends AttestedElGamalDeck {
  async share(secret: `0x${string}`, card: WireMasked, ctx: string): Promise<WireShare> {
    const good = await super.share(secret, card, ctx)
    return { ...good, share: ('0x02' + 'ab'.repeat(32)) as `0x${string}` } // valid point, wrong share
  }
}

describe('adversarial', () => {
  it('bad deal share is rejected with a thrown error naming the peer', async () => {
    const { a, b } = await freshPair({ deckB: new GarbageShareDeck() })
    await openSession(a, b)
    await expect(Promise.all([
      a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }),
      b.playFlip({ bet: 'HOLD', onRaise: 'CALL' }),
    ])).rejects.toThrow(/bad deal share/)
  })

  it('stall mid-flip yields dispute evidence with the right demand', async () => {
    const { a, b, tb } = await freshPair({})
    await openSession(a, b)
    tb.dropNext(99) // B's transport black-holes: B never delivers anything again
    const flip = a.playFlip({ bet: 'HOLD', onRaise: 'CALL' })
    const timeout = new Promise((r) => setTimeout(() => r('TIMEOUT'), 200))
    expect(await Promise.race([flip.then(() => 'DONE'), timeout])).toBe('TIMEOUT')
    const ev = buildEvidence({
      coSigned: a.channel.latest!, transcript: a.transcript, sinceSeq: 0,
      demand: { from: 'B', kind: 'DEAL_SHARE', detail: 'share owed for the open flip' },
    })
    expect(ev.state.nonce).toBe(0n)        // stall before any flip completed
    expect(ev.demand.from).toBe('B')
  })

  it('replayed stale co-signed state is rejected by the channel', async () => {
    const { a, b } = await freshPair({})
    await openSession(a, b)
    await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    const stale = a.channel.latest! // nonce N
    await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    await expect(b.channel.accept(stale)).rejects.toThrow(/nonce/)
  })

  it('tie carries the war pot and the next flip pays it out', async () => {
    // deterministic deck: stack a tie then a decisive flip by overriding shuffle
    // to the identity permutation (cards 0,1 tie at rank 2; cards 2,3 tie too —
    // use slots [0,1] = 2♣/2♦ tie, then [4,5] = 3♣/3♦... so stack manually:
    // override initialDeck order to [0, 1, 51, 0+8...] — simplest: subclass
    // AttestedElGamalDeck.shuffle to permute nothing (remask only), then play
    // flips until a tie occurs naturally on slots (0,1): rank(0)==rank(1).
    const { a, b } = await freshPair({ deckA: new IdentityShuffleDeck(), deckB: new IdentityShuffleDeck() })
    await openSession(a, b)
    const [r1] = await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    expect(r1.flip.result).toBeNull()                 // 2♣ vs 2♦: tie
    expect(r1.flip.warPot).toBe(10n)                  // 2 antes carried
    const [r2] = await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    expect(r2.flip.result).not.toBeNull()             // 2♥ vs 2♠ ties again? NO —
    // slots 2,3 are 2♥,2♠: same rank → another tie. Slots 4,5 are 3♣,3♦ → tie again.
    // With identity shuffle EVERY pair ties. That's the point: assert warPot keeps
    // growing across 3 flips, proving carry math, then stop.
    expect(r2.flip.warPot).toBe(20n)
  })

  it('session pipelining: a second table opens while the first is unsettled', async () => {
    const { a, b } = await freshPair({})
    await openSession(a, b)
    await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    // no settle for table 1 — open table 2 immediately
    const second = await freshPair({}) // distinct tableId inside freshPair
    await openSession(second.a, second.b)
    expect(second.a.channel.latest!.state.nonce).toBe(0n)
    expect(a.channel.latest!.state.nonce).toBeGreaterThan(0n) // table 1 untouched, unsettled, independent
  })

  it('reshuffle: 26 flips exhaust the deck and play continues', async () => {
    // escrowEach 1000n: 27 flips swing ±10 each — 100n escrow could go bust
    // mid-run on an unlucky deck and flake the test on a negative-balance throw
    const { a, b } = await freshPair({ escrowEach: 1000n })
    await openSession(a, b)
    for (let k = 0; k < 27; k++) {
      await Promise.all([a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }), b.playFlip({ bet: 'HOLD', onRaise: 'CALL' })])
    }
    const s = a.channel.latest!.state
    expect(s.balanceA + s.balanceB + s.pot).toBe(2000n) // conservation across reshuffle
  }, 60_000)
})
```

`IdentityShuffleDeck` subclasses `AttestedElGamalDeck`, overriding `shuffle` to remask every card but skip the Fisher–Yates loop (still signs — it's a *valid* attested shuffle that happens to be identity; both clients use it so the test is deterministic).

Adjust the tie test expectations to the identity layout: slots (0,1) = 2♣ vs 2♦ → tie; (2,3) = 2♥ vs 2♠ → tie; warPot after two flips = 20n. The decisive-payout half of the carry math is already covered by rules.test.ts (`tie carries...` + `SHOWDOWN` with distinct ranks); here we prove the *session* carries it between flips.

- [ ] **Step 2: Run to verify the right failures, then make it pass**

Run: `pnpm --filter @gibs/hilo-war test`
Most failures will be missing exports (`tb` from freshPair, `IdentityShuffleDeck`, deck overrides). Add the small affordances:
- `freshPair(opts: { deckA?, deckB?, escrowEach? })` returns `{ a, b, ta, tb }` and generates a fresh random `tableId` per call.
- Export `IdentityShuffleDeck` from the test file itself (it's test-only).
Expected end state: PASS (6 tests; the 27-flip test runs tens of seconds — keep the 60s timeout).

- [ ] **Step 3: Full workspace check**

Run: `cd ~/Documents/gibs-finance/random && pnpm --filter '@gibs/zk-cards-core' --filter '@gibs/hilo-war' test && pnpm --filter '@gibs/zk-cards-core' --filter '@gibs/hilo-war' typecheck`
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add examples/games/hilo-war
git commit -m "test(hilo-war): adversarial suite — bad shares, stalls, replay, war carry, pipelining, reshuffle"
```

---

### Task 14: Exports, README notes, push, progress entry

**Files:**
- Modify: `examples/games/hilo-war/src/index.ts`
- Create: `examples/games/zk-core/README.md`
- Create: `examples/games/hilo-war/README.md`
- Modify (msgboard repo): `progress.txt`

- [ ] **Step 1: Final exports**

```ts
// examples/games/hilo-war/src/index.ts
export * from './rules'
export * from './session'
```

- [ ] **Step 2: READMEs** — short, factual; each states what the package is, the v0 honesty note (attested shuffle, SNARK replaces it behind `MaskedDeckProvider`), and how to run tests. No marketing copy; branding rules apply (no authorship credits).

- [ ] **Step 3: Push**

```bash
cd ~/Documents/gibs-finance/random
git push ssh://git@ssh.github.com:443/gibsfinance/random.git games-platform
# on rejection: git fetch && git rebase origin/games-platform && retry
```

- [ ] **Step 4: Progress entry** — append a dated entry to `~/Documents/valve-tech/github/msgboard/progress.txt` (top of file, demote the previous "latest"): packages landed, test counts, the v0 attested-shuffle caveat, and what's next (SDK spike addendum, contracts plan). Commit + push msgboard master.

---

## Self-review checklist (run after writing, fix inline)

1. **Spec coverage:** engine items of "Off-chain packages" ✓ (core, hilo-war; relay/mirror/web/bots are later plans). "First build: Hi-Lo War" rules ✓ (Tasks 11–12) incl. hidden folds, war pot, reshuffle, simultaneity via commit/open; top-up and the on-chain refund path are contracts-plan scope. "Testing — engine" ✓ (Task 13). Session pipelining requirement ✓ (Task 13 test). 3-tx session and dispute *resolution* are contracts scope; dispute *evidence* ✓ (Task 9).
2. **Known deliberate gaps for later plans:** chess-clock timing, `ZkTable`, real domain values (TEST_DOMAIN placeholder), SNARK provider, transcript merge for the mirror (single-merged-log design noted in Task 12's `adopt` note).
3. **Type consistency check:** `MaskedDeckProvider` method names used in session.ts match maskedDeck.ts (`keygen/aggregate/initialDeck/shuffle/verifyShuffle/share/verifyShare/unmask`) ✓; `ChannelState` fields in stateSig/channel/session agree ✓; `Phase` values in rules vs `ChannelState.phase` usage agree ✓.

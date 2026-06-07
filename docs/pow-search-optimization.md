# Faster proof-of-work search: scalar multiplication → point addition

This note explains the optimization in `packages/core/src/utils.ts` (`createChallengeSearch`)
that lets a grinder find a valid nonce roughly **4–6× faster** in practice, and — importantly —
why it stays **bit-for-bit consensus-compatible** with the canonical verifier. Share it with
anyone working on a msgboard grinder or node.

## The proof-of-work scheme

A message is valid when its work hash is divisible by the message's difficulty. The work hash is
built from an elliptic-curve "challenge" point plus the message bytes (`checkWork` /
`getChallenge` in `core/src/utils.ts`):

```
digest    = difficultyDigest(message)              # constant for a given message (from its factors)
scalar    = nonce · digest + blockHash             # the only part that changes while grinding
challenge = g · scalar                             # secp256k1 scalar multiplication; take its X coord
workHash  = sha256( challenge.x ‖ category(32) ‖ data )
valid     ⇔ workHash mod difficulty == 0
```

`g` is the secp256k1 generator. To grind, you try nonce = 1, 2, 3, … until `workHash` clears the
difficulty. At a difficulty around 173k that is, on average, ~173k attempts per message.

## The bottleneck

The naive loop recomputes `challenge = g · scalar` **from scratch every nonce**. That is a full
**elliptic-curve scalar multiplication** — in JavaScript (elliptic/bn.js) about **0.6 ms each**,
which dominates everything else in the loop and caps the grind near **~1.5k hashes/s**. At
difficulty ~173k that is ~110 s per message — longer than the 60 s spam interval, so a single
grinder can never keep a board full. (This, not any per-chain difficulty difference, was the real
cause of the "spammers are down" report: difficulty is identical on every chain.)

## The insight: consecutive nonces step by a constant

While grinding, only `nonce` changes, and it increments by exactly 1 each step. So from one nonce
to the next the **scalar** grows by a constant — `digest`:

```
scalar(nonce+1) − scalar(nonce) = (nonce+1)·digest − nonce·digest = digest
```

By the group homomorphism of scalar multiplication, the **challenge point** therefore advances by
a constant point on every step:

```
challenge(nonce+1) = g·(scalar + digest) = g·scalar + g·digest = challenge(nonce) + D
where   D = g · digest   (computed once per grind)
```

So instead of one **scalar multiplication per nonce**, we do one **point addition per nonce** —
much cheaper than a multiply — after a single multiply to compute `D` and to anchor the first
point.

```
point ← g·scalar            # one scalar multiply to start (or to rebase, see below)
loop:
  nonce ← nonce + 1
  point ← point + D          # one point ADDITION, not a multiply
  workHash ← sha256(point.x ‖ category ‖ data)
  if workHash mod difficulty == 0: done
```

## Why it is still consensus-safe (bit-identical)

The node verifies submitted work with `checkWork`, which calls `getChallenge` — the **unchanged**
canonical path that computes `g · (nonce·digest + blockHash)` directly. The fast search must
produce the *exact same* challenge for a given nonce, and it does:

- **Homomorphism:** `g·a + g·b = g·(a+b)`. After `k` additions of `D = g·digest` onto an anchored
  `g·scalar₀`, the running point equals `g·(scalar₀ + k·digest)` = `g·scalar(nonce)` exactly.
- **Reduction mod n:** `g·x` depends only on `x mod n` (n = curve order), and bn.js point addition
  reduces correctly, so there is no drift even as the scalar grows past `n`.

The result is the same point, the same X coordinate, the same `sha256`, the same work hash. The
search only changes **how** a winning nonce is found, never **what** counts as valid. `checkWork`
and `getChallenge` remain the single source of truth; if you ever change one, the search must
change in lockstep.

## Block re-anchoring

The challenge also includes `blockHash`, and `doPoW` polls block heads and updates
`message.blockHash` mid-grind (work must be rooted to a recent block). When the block changes, the
running point is no longer on the right track, so `createChallengeSearch` **rebases**: it does a
single scalar multiply to re-anchor `point = g·(nonce·digest + blockHash)` at the new block, then
resumes stepping by `D`. Rebases are rare (once per ~10 s block) versus ~hundreds of thousands of
additions, so they are negligible.

## What actually got faster (and what didn't)

Eliminating the per-nonce scalar multiply removes the single dominant cost. In practice this is a
**~4–6× end-to-end speedup** in finding a valid nonce. It is not larger because once the multiply
is gone, the remaining per-iteration work becomes the new floor: the point **addition** itself, the
`sha256`, the big-integer `mod`, and the bn.js ↔ byte conversions. The theoretical ceiling (just
the multiply vs. just the addition) is higher, but those fixed per-iteration costs cap the
real-world gain.

Two micro-optimizations in the same function help the constant factor:
- `D = g·digest` is computed **once** per grind, not per nonce.
- The constant message suffix (`category ‖ data`) is concatenated **once**, not rebuilt each
  iteration; only the changing `point.x` is prepended before hashing.

## Where it lives

- `createChallengeSearch(message)` in `packages/core/src/utils.ts` — the stateful fast search;
  `next(msgDifficulty)` advances the nonce by one, steps (or rebases) the point, and returns the
  work hash or `null`.
- `checkWork` / `getChallenge` in the same file — the unchanged canonical verifier. Treat these as
  the spec; the search must stay byte-for-byte equivalent to them.
- `MsgBoardClient.doPoW` drives the search and updates `blockHash` as new blocks arrive.

For a node implementation, none of this changes verification: a node still recomputes the challenge
with a single scalar multiply per *submitted* message. The optimization only matters to the
*searcher*, which evaluates hundreds of thousands of candidate nonces per message.

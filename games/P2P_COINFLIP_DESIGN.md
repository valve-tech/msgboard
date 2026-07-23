# P2P coin flip — a two-sided guessing game (design spec)

Status: agreed direction 2026-07-20 (v2 — reframed from symmetric commit-reveal to a
maker/taker guessing game). No validators, no house, no joint entropy: **one side commits a
hidden choice, the other side tries to guess it.** Matching pennies with stakes.

## The core insight

A coin flip between two parties doesn't need a random *beacon* at all — it needs a *guessing
game*:

- **Maker** commits `commit = keccak(offerId, choice, salt)` for a hidden `choice ∈ {0,1}` and
  posts it with a signed stake authorization as a standing **offer**.
- **Taker** picks the offer up by staking and stating a `guess ∈ {0,1}`. The guess IS the
  taker's entire move — there is nothing for the taker to reveal later.
- Maker reveals `(choice, salt)`; taker wins iff `guess == choice`.

Fairness needs **no trusted randomness anywhere**: a taker who guesses uniformly at random wins
exactly 50% against *any* maker strategy, and a maker who chooses uniformly concedes exactly
50% against any taker. Each side's EV is protected by their own coin, not the counterparty's.
(This is the mixed-strategy equilibrium of matching pennies.) msgboard carries the offer book;
every offer, take, and reveal is a PoW-stamped, publicly auditable post.

It also changes the product shape: instead of a negotiated session, the flip becomes an
**order book** — makers post standing offers, takers browse and pick up. A maker is a
mini-house by choice.

## The load-bearing trap: the free option

If offers can be withdrawn *selectively*, the maker gets a last look: see a losing guess
coming (in the mempool or on msgboard), kill the offer (via 3009 `cancelAuthorization`, or by
draining the balance so the authorization pull reverts), and let only winning guesses land.
A maker with a free option plays only flips they have already won. **Every pickup-style design
must close this.** Two sound closures:

### Variant A — escrowed offers (preferred)
Maker locks `stake + bond` in `FlipBook` when posting the offer. The offer physically cannot
be yanked after a take:

1. **POST** (1 tx, maker): `post(commit, stake, bond, takeDeadline)` — escrow `stake + bond`.
   Offer mirrored to msgboard for discovery. Maker may `cancel()` any time **before** a take
   (free withdrawal of an untaken offer is fine — it can't be selective, nothing has happened).
2. **TAKE** (1 tx, taker): `take(offerId, guess)` — taker stakes `stake` in the same tx, guess
   is public calldata. Atomic: once this lands the maker is locked in.
3. **REVEAL** (1 tx, maker): `reveal(offerId, choice, salt)` within `revealWindow` — contract
   checks the commit, pays the winner `2·stake`, refunds the maker's bond.
4. **FORFEIT** (1 tx, taker): after `revealWindow` with no reveal, `claim(offerId)` pays the
   taker `2·stake + bond`. No challenge window needed — the reveal was due **on-chain**, so
   absence is directly observable. (Contrast the symmetric design in v1, which needed an
   optimistic counter-reveal window because reveals lived off-chain.)

Liveness is **one-sided**: only the maker ever reveals, so only the maker posts a bond. The
taker cannot grief at all — their move completes atomically at take time.

Bond math (the even-money indifference trap): a maker who sees a losing take must strictly
prefer revealing (cost: `stake`) over bailing (cost: `stake + bond`) — any `bond > 0` breaks
the tie; size it ≥ the taker's claim gas plus a margin (e.g. 10–20% of stake).

### Variant B — fully off-chain offers, hidden guesses
No escrow at post time (offers are free to spray): maker's offer = commit + a 3009/7598
`receiveWithAuthorization` on msgboard. To close the free option, the **taker's guess is
hidden too**: take = `hash(guess, salt2)` + taker's authorization. Killing an offer now can't
be selective — the maker doesn't know whether they're dodging a loss, so cancellation is just
noise, not an option. Cost: the taker must reveal later, so reveal-liveness and bonds become
two-sided again (maker reveals `choice`, then taker reveals `guess`; either bail forfeits to
the other via the v1 challenge-window machinery).

**Trade-off summary:** A = 3 on-chain txs and locked capital per open offer, but one-sided
liveness and directly-observable forfeit. B = zero-cost standing offers, but two-sided bonds
and an optimistic forfeit path. Ship A first; B is the scaling refinement if offer-spray
matters.

## Why this doesn't generalize to the raffle

The guessing game is inherently two-sided. An N-party draw still needs entropy no participant
controls (or per-entrant bonds that scale with the pot to deter the last-revealer grind —
withholding as a choice between `outcome(with me)` and `outcome(without me)`). The Numbers
keeps its validator set; its badge stays 🛡️. The coinflip's badge flips 🛡️ → 🤝.

## Where ZK does and doesn't enter

No ZK is load-bearing here: the maker's secret is one-shot and revealed at the end, so a
transparent hash commit is a complete proof, and the taker's move (variant A) is public by
construction. This is the same shape as the Wordle protocol — commit, opposing move, reveal —
the coinflip is a 1-bit Wordle. ZK remains reserved for state that must stay hidden *while
being proven about* (the Hold'em / mental-poker track), and optionally for compressing
settlement transcripts (`settleWithProof`).

## Token / contract notes

- **Variant A needs no authorization standard at all** — plain escrow (`transferFrom` after a
  one-time approve, or native value). This drops the Chips-token change from the critical path
  entirely.
- Variant B needs signed transfer authorizations: implement **ERC-3009 with the ERC-7598
  extension** (the upgraded form — authorization functions take a generic `bytes signature`
  validated via ERC-1271 instead of only ECDSA `(v,r,s)`; live in USDC v2.2, fully
  backward-compatible). 7598 is not optional for us: **cosign is Safe-first, and a Safe signs
  via ERC-1271, not ECDSA** — plain 3009 would lock every Safe/smart account out of making or
  taking offers. MUST use `receiveWithAuthorization` (payee-only execution — a mempool
  observer can't burn the auth) with the authorization nonce bound to the offer id.
- `FlipBook` state per offer: `{maker, commit, stake, bond, taker, guess, takenAt}` — one
  struct, deleted on settle. All histories live on msgboard + logs.

## Migration

1. `FlipBook` (variant A) contract + tests: commit binding (offerId-domain-separated), the
   free-option closures (cancel-after-take must be impossible), bond-indifference math,
   reveal-window boundary conditions.
2. Web: coinflip screen becomes an offer book — post / browse / take / reveal, msgboard as
   the discovery + audit layer (reuse the wordle screens' msgboard transport).
3. Badge: coinflip 🛡️ → 🤝. The Numbers stays 🛡️.
4. Later, if offer-spray matters: Chips + 3009/7598 and the variant-B path.

# Coin Flip on MsgBoard — Design Spec

Date: 2026-06-08
Status: Draft for review

## Summary

A two-person coin flip game, played with on-chain randomness from the
gibsfinance/random protocol and coordinated over MsgBoard. Players stake tokens,
pick a side (heads or tails), and are matched against someone taking the opposite
side. A pool of "always on" validator nodes supplies the entropy and guarantees the
game can always be finalized. The winner is decided by a verifiable random seed, and
takes the escrowed pot.

This document specifies the first of three sub-projects — the periphery coin-flip
contract — in full, and sketches the other two (the validator node service and the
user interface) at a high level. Each sub-project gets its own implementation plan.

## Goals

- Let many people enter coin flips with real stake, matched by side.
- Keep the wager pot separate from the randomness protocol's own economics, in a
  dedicated periphery contract, so core `Random` is never bent to carry player funds.
- Make the game always finalizable: even if a player walks away, a validator can
  finalize and settle.
- Give the winner a direct incentive to publish the reveal on-chain, with the
  validators as a fallback if the winner stalls.

## Non-goals (for this version)

- Outcomes other than a fair, binary, fifty-fifty flip.
- Multi-token pots in a single flip (a flip is settled in one token).
- A custom on-chain order book with arbitrary stake sizes (we match equal stakes).

## Background: the randomness lifecycle

The gibsfinance/random protocol works in three steps. The "invisible ink" analogy is
exact — a secret is written down hidden, then revealed later.

- **ink** — a provider publishes a batch of hashed secrets (preimages) on-chain.
  `ink(info, data)` writes a contract full of preimages (stored with SSTORE2). This is
  the commit step. The validators are the providers; they ink.
- **heat** — a consumer requests randomness by selecting a number of preimages from the
  inked pool, marking them used, emitting a `Start` event, and returning a `key`. This
  is consumption. The coin-flip contract heats on behalf of a matched pair.
- **cast** — anyone holding the secrets reveals them. `cast(key, info, revealed)` checks
  that each revealed secret hashes to its committed preimage, then sets the final
  `seed = hash(revealed)` and emits `Cast`. This is the reveal step. The winner casts to
  claim; a validator casts as a fallback.

The seed is unknowable until the secrets are revealed, and is verifiable by anyone after.

### Settlement economics already verified

Core `Random.cast` already settles its own provider economics: each revealed preimage
returns its stake to its provider, and the seed selects one participating provider via
a pseudo-random draw to receive the consumer's heat payment as a bonus. This is covered
by a test added during design (`test/random` — "assert winner takes the pot bonus"). The
coin-flip contract does **not** rely on this to pay players; it uses this only to pay the
validators for supplying entropy. The player pot is escrowed and settled separately in the
periphery contract.

## Architecture: three pieces

1. **The periphery coin-flip contract** (this spec). Holds player stakes, matches by
   side, drives the ink and heat for each matched pair, and pays the winner from the
   escrowed pot when the seed is finalized.
2. **The validator node service** (follow-on spec). Three "always on" nodes that keep the
   inked entropy pool topped up, watch for consumption, reveal their secrets over
   MsgBoard, and cast on-chain as a fallback if the winner stalls.
3. **The user interface** (follow-on spec). Where a person enters a flip, watches the
   board, and sees the result.

Core `Random` (and `Consumer`, for the reveal and undermine incentive) are unchanged. The
periphery contract composes them.

## Sub-project 1: the periphery coin-flip contract

### Composition

A new periphery contract — working name `CoinFlip` — holding references to the core
`Random` contract (and `Consumer` if the reveal-and-undermine path is used). It is the
natural fleshing-out of the existing `FundedConsumer` stub, which already holds both
references and is payable for exactly this purpose. Core stays untouched.

### State

- `nextEntrant` — an incrementing counter, the identifier for each entry.
- Per side, a first-in-first-out queue of waiting entries, keyed by stake amount, so an
  entry waits only behind others wanting the same side at the same stake.
- An `Entry` record per waiting entrant: the entrant's address, side, stake amount, token,
  the supplied preimage, and the escrowed funds.
- A `Flip` record per matched pair: the two players and their stakes, the randomness `key`,
  the token, a status, and (after settlement) the resolved winner.

### Matching by side

Each entry chooses a side (heads or tails) and a stake amount, and is matched against the
oldest waiting entry on the **opposite** side at the **same** stake.

- If an opposite-side entry at that stake is already waiting, the two are paired
  immediately in the entering transaction.
- If none is waiting, the entry joins its own side's queue and waits.

This handles the "five want heads, nobody wants tails" case directly: the five heads
entries sit in the heads queue, and each is paired in order as tails entries arrive. Stake
matching is exact-equal for this version; variable stakes (an order book) are out of scope.

### Entry and escrow (escrow-on-entry)

`enter(side, stake, preimage)` (payable, or pulling an ERC-20 with `transferFrom`):

- The wager is taken at entry. The funds are guaranteed present from that moment, so no
  later step can find the money missing.
- `preimage` is the hash of the player's own secret, or the well-known `hash(0)` if the
  player does not want to manage a secret and may walk away (see the walk-away path).
- If a match exists, pairing proceeds in this same transaction; otherwise the entry is
  queued.

This is chosen over an allowance-pulled-at-pairing design, which would push a funding
failure to the worst possible moment — pairing — and strand the ready counterparty.

### Pairing: dual-ink and heat

When two opposite-side entries are matched, the entering transaction:

1. Inks both players' preimages (the dual-ink) into the protocol — one shot for the pair,
   so players never each pay for a separate ink.
2. Heats a small number of validator preimages (default three) from the always-on pool,
   plus the two player preimages, producing the flip's randomness `key`.
3. Registers the coin-flip contract as the heat's owner with the change-callback flag set,
   so the protocol calls back into the contract when the seed is finalized.
4. Records the `Flip` and emits an event the validators and the interface watch.

The three validator inputs are what keep the seed unpredictable even when a player supplies
`hash(0)`. Three (rather than one) gives redundancy: any one validator can finalize, so the
game survives an individual validator being offline.

### Settlement: cast then callback

The seed is finalized when the secrets behind the consumed preimages are revealed via
`cast` — by the winning player claiming, or by a validator as a fallback. On a successful
cast, the protocol fires the change callback `onCast(key, seed)` into the coin-flip
contract, which:

1. Computes the outcome from the seed — its parity (even or odd) selects heads or tails,
   a provably fair fifty-fifty result.
2. Pays the escrowed pot (both stakes, less any fee) to the winning side.
3. Marks the flip settled.

There is no separate claim step: settlement happens as a side effect of the cast. The
winner's only job is to make the cast happen, which is exactly the incentive below.

### The walk-away path (hash of zero)

A player who does not want to keep a secret supplies `hash(0)` as their preimage — the
preimage of the publicly known zero secret. Because that secret is public, anyone (a
validator) can reveal it on the player's behalf. The flip therefore still finalizes and
settles even after such a player has left. A player who supplies their own secret keeps the
option to reveal first and claim; a walk-away player simply delegates that to the validators.

### Incentives and the validator fallback

- The winner is incentivized to cast promptly: casting finalizes the seed and pays them.
- If the winner stalls, any of the three validators publishes the cast, so the loser is
  never able to stall the game by inaction, and the winner is still paid.
- The protocol's undermine-after-expiry behavior discourages waiting too long: a party who
  sits on a secret past the expiry window risks the request being re-rolled, which removes
  any edge from stalling.

### Recovery and error handling

With escrow-on-entry, the recovery surface is small:

- **Unmatched entrant** — a lone entry still waiting in a side queue can `cancel` for a full
  refund, or be auto-refunded after a timeout.
- **Paired but never finalized** — if a matched flip is never cast within a window (for
  example, all validators are offline), `refundStale(key)` times out and refunds both
  players. The walk-away sub-case does not reach here, because the validator fallback cast
  finalizes the flip regardless.
- **Funding** — cannot fail after entry, because the stake was taken at entry.

### Parameters and chosen defaults

- **Token**: native tPLS for the first version; ERC-20 support is a later addition. A flip
  settles in a single token.
- **Outcome**: seed parity selects the winning side — fifty-fifty and verifiable.
- **Fee**: a configurable protocol fee on the pot, default zero.
- **Validator inputs per flip**: three, for redundant entropy and fallback liveness.
- **Timeouts**: a queue-wait cancel window and a post-pairing finalize window, both
  configurable.

### Testing

- Unit tests for matching: opposite-side pairing, same-side queueing, the five-on-one-side
  case, exact-stake matching, and rejection of mismatched stakes.
- Escrow tests: funds taken at entry, refunds for cancelled and stale entries, no double
  spend, no settlement before the seed exists.
- Settlement tests: parity maps to the correct winner, the pot (less fee) reaches the
  winner, and a walk-away flip still settles via a validator cast.
- Incentive tests: the winner can cast and is paid; a validator fallback cast pays the
  same winner; a stale flip refunds both.
- These extend the existing hardhat test suite in the contracts package, reusing its
  fixtures for inking validator preimages and heating.

## Sub-project 2: the validator node service (follow-on)

Three server-side nodes, run alongside MsgBoard, that:

- Keep the always-on entropy pool full by inking fresh preimage batches before the pool runs
  low.
- Watch for consumption (the coin-flip contract's pairing and the protocol's `Start`
  events).
- Reveal their secrets for a consumed flip over MsgBoard, so the outcome becomes computable
  off-chain and the winner can claim.
- Cast on-chain as a fallback when the winner has not done so within the finalize window.

This builds on the existing relayer package (a poll, filter, act loop with observe and live
modes) and the existing message posting and reading in the software development kit.

## Sub-project 3: the user interface (follow-on)

Where a person:

- Enters a flip — picks a side and a stake, approves and deposits, supplies a secret or
  chooses the walk-away option.
- Watches the board — sees their queue position, their match, the validators' revealed
  secrets, and the result.
- Claims — when they win, publishes the cast to finalize and be paid (the interface can do
  this for them), or lets a validator finalize.

This builds on the existing provably-fair dice example and the Svelte interface package.

### The interface must teach, cite, and let the user verify

A provably fair game is only as trustworthy as the user's ability to understand and check
it. The interface is therefore citation-rich and explanatory by design, not a bare betting
form. Concretely:

- **Cite every step to its on-chain artifact.** Each stage of a flip — the validators'
  ink, the pairing, the heat, each revealed secret, the cast, and the final seed — links to
  its transaction and to the entropy indexer, so a user can follow the whole life of a flip
  from commitment to settlement on independent sources rather than taking the interface's
  word for it.
- **Explain the nuance inline.** Short, plain-language explanations sit next to the thing
  they describe: why a commit-then-reveal scheme is fair, what the walk-away (`hash(0)`)
  option really means and gives up, why there are validators at all, why three, what the
  re-roll-after-expiry risk is, and where the player's funds are at each moment. No jargon
  goes unexpanded.
- **Make the trust model checkable, not asserted.** The interface lets the user verify the
  pieces themselves — that each revealed secret hashes to its committed preimage, that the
  seed is the hash of the revealed secrets, and that the parity of the seed produced the
  stated winner — so "provably fair" is demonstrated in front of them, not merely claimed.
- **Be honest about what is trusted.** Where trust does rest on the validators (liveness,
  keeping the pool funded) or on the contract, the interface says so plainly, rather than
  implying more trustlessness than the system has.

The tone is closer to an explained, audit-friendly walkthrough than a casino: the player
should leave understanding exactly how the result was produced and able to prove it to a
skeptic.

## Open questions

- The exact preimage layout per flip: how the two player preimages and the three validator
  preimages are arranged in the heat selection, and whether the `Consumer` chain-and-tell
  path is used or the contract casts directly.
- Pool sizing and refill cadence for the validators, and how the contract discovers which
  validator preimages are free to heat.
- Whether the queue is keyed by a fixed set of allowed stake denominations or any exact
  amount.
- Fee destination and governance, if the fee is ever non-zero.

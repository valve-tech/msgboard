# Player-Run Tables — Slice 1: Permissionless Coin-Flip Vault

**Date:** 2026-07-31
**Branch (target):** TBD off `master` (design only; no code until approved)
**Status:** Design — awaiting user review

## The idea

Today every game has one house: a single `Ownable` contract with one `houseKey` and one
`housePool` that the platform funds and operates. This spec turns that singleton into an open
market. **Anyone** can spin up a table, fund it with their own Chips, and earn the house edge on
it. The platform stops being the house and becomes only the *validation*: the randomness that
decides every flip, and the guarantee that the table runs the real game.

This is "Approach A — bankroll-only operators." An operator is **pure capital**. They run no
server, hold no keys that touch a game outcome, and sign nothing per round. They deposit Chips and
withdraw profit; that is the whole job. The trust that used to live in "the house is honest" is
replaced by two things that already exist in this codebase:

1. **Validator randomness** (`IRandom`) decides the flip — never the operator, never the player,
   never this website. Same set the current Coin Flip already uses.
2. **Per-round escrow** — the moment a player opens a round, the table's bankroll reserves the full
   payout on-chain. A winning player is paid from money already locked. The operator *cannot* rig
   the coin and *cannot* stiff a winner.

Because of (1) and (2), a bankroll-only operator is **trustless by construction**. This reframes
what "trust tiers / reputation" are for (see below): not safety of funds — that's guaranteed — but
**discovery**. Is this table liquid? Is it live? Does it hold enough bankroll to cover the bet I
want to make? That's what staking and ranking answer.

### Scope of THIS spec

One game (**Coin Flip**), one token (**Chips**, for both bankroll and stake), the full operator +
player loop on-chain, and the frontend surface to browse/create/join tables sorted by activity and
stake. Slices 2–5 (factory abstraction, multi-game, richer reputation, remaining ports) are scoped
at the end as follow-on specs and are explicitly **out of scope here**.

## Trust story (what changes for the player)

The live tables today are "co-signed, replayed by your browser." Coin Flip is different — it's
already **validator randomness** (the `validator` trust model in `TrustBanner.tsx`: "safe as long as
one of the N validators is honest"). Player-run tables inherit that model unchanged. The only new
sentence the player needs is:

> This table's bankroll is put up by an independent operator, not the house. The operator can't touch
> the coin (validators decide it) and can't dodge a payout (your winnings are escrowed the instant
> you bet). Every table runs the identical on-chain game — the operator only supplies the money.

No new trust assumption is introduced. The operator is strictly *less* trusted than today's house,
not more.

## Architecture

### What exists and is reused as-is

- **`IRandom`** — validator entropy (`heat`, `randomness(key)`, `latest`, `expired`). Untouched.
- **`GameBase`** — the `_heatBound` / `onCast` / `choppedInstance` / `_isStale` machinery Coin Flip
  already rides. Reused; the new contract extends it exactly like `CoinFlip.sol`.
- **`Chips`** ERC-20 — bankroll deposits and stakes.
- **`PreimageLocation`**, validator-subset validation (`_validateSubset`) — reused verbatim.
- The games-web client's Coin Flip surface, receipts, and the `validator` trust banner.

### What is new

A single contract for the MVP:

**`CoinFlipTables.sol`** (`extends GameBase`) — Coin Flip against a chosen operator bankroll, with
the per-operator vault accounting folded in. It is `CoinFlip.sol` with the opposite side replaced by
a table's pooled Chips instead of a matched heads/tails player.

> **Design decision — one contract, not TableVault + Factory + Game (yet).** The end vision has a
> reusable `TableVault` primitive and a `TableFactory`. For ONE game that is premature abstraction
> (YAGNI): there is no second consumer to justify the generic interface, and splitting it adds
> cross-contract Chips approvals and call surface for zero MVP benefit. The vault accounting lives as
> a clearly-bounded section of `CoinFlipTables` (its own structs + funcs, no game logic mixed in), so
> extracting it into a standalone `TableVault` in Slice 2 — when a second game needs it — is a
> mechanical lift, not a rewrite. Flagged here for the reviewer to veto if they'd rather build the
> abstraction now.

### Data model

```solidity
struct Table {
    address operator;        // who funds and profits; set once at creation
    uint256 bankroll;        // free (withdrawable) Chips; the operator's un-reserved balance
    uint256 escrowed;        // Chips locked by live (unsettled) rounds; the full payout of each
    uint256 stake;           // Chips the operator locked purely as a ranking/skin-in-game signal
    uint16  maxMultiplierX100; // payout multiple ×100 (e.g. 196 = 1.96×, a 2% house edge)
    uint256 maxStake;        // per-round cap the operator will cover (bounds `escrowed` growth)
    bool    open;            // operator can pause new rounds without withdrawing
}

struct Round {
    bytes32 tableId;
    address player;
    uint8   side;            // HEADS=0 / TAILS=1
    uint256 stake;           // player's Chips in
    uint256 payout;          // escrowed at open = stake * maxMultiplierX100/100
    bytes32 key;             // IRandom key for this round's validator subset
    uint256 openedAtBlock;
    Status  status;          // Pending / Settled / Refunded
}

mapping(bytes32 tableId => Table) public tables;
mapping(bytes32 roundId => Round) public rounds;
uint256 internal _tableNonce;
uint256 internal _roundNonce;
```

`tableId = keccak256(abi.encode(address(this), operator, ++_tableNonce))`.

### Flows

**Create a table (permissionless).**
`createTable(uint16 maxMultiplierX100, uint256 maxStake) → tableId`. Anyone. Records
`operator = msg.sender`, `open = true`, zero balances. `maxMultiplierX100` must be `≤ 200` (can't
promise more than 2×, i.e. no negative house edge that would let an operator be drained by design)
and `≥` a floor (e.g. 150) so tables can't advertise a predatory edge. Emits `TableCreated`.

**Fund / withdraw bankroll.**
`fundBankroll(tableId, amount)` — `chips.transferFrom(operator → contract)`, `bankroll += amount`.
`withdrawBankroll(tableId, amount)` — operator only; revert if `amount > bankroll`. Because `bankroll`
holds only the *free* balance and every live round's payout has already been moved into `escrowed`
(see `open`), this single check is the load-bearing invariant: **escrowed Chips are never
withdrawable**, so a live round's payout can't be pulled out from under the player.

**Stake for ranking.**
`stakeForRank(tableId, amount)` / `unstake(tableId, amount)` — operator only. `stake` is separate
from `bankroll`, freely withdrawable, and never touched by settlement. It exists solely as a
sorting/skin-in-the-game signal (see "Ranking"). **No slashing** in the MVP — under full on-chain
settle there is nothing to slash for; the escrow already guarantees payout and validators already
guarantee fairness. (Slashing only becomes meaningful if a future slice adds off-chain co-signed
settlement, where an operator *could* withhold a signature. Noted, out of scope.)

**Open a round.**
`open(tableId, uint8 side, uint256 stake, address[] validatorSubset, PreimageLocation.Info[] locations) → roundId`.
- Validate: table `open`, `stake ≤ maxStake`, `side ≤ TAILS`, subset valid.
- `payout = stake * maxMultiplierX100 / 100`. The operator only needs to cover winnings beyond the
  player's own returned stake, so require the free bankroll covers that exposure:
  `bankroll ≥ payout - stake`. Pull the player's stake in
  (`chips.transferFrom(player → contract, stake)`), then lock the **full** payout:
  `bankroll -= (payout - stake); escrowed += payout`. The `payout - stake` came from the operator's
  bankroll; the remaining `stake` is the player's own money now held in escrow. So `escrowed` always
  equals the exact amount owed to the player if they win, fully funded.
- Heat the validator subset (`_heatBound`, exactly as `CoinFlip._pairAndHeat`), store `key`, set
  `status = Pending`. Emit `RoundOpened`.

**Settle.**
Parity of the validator seed decides, identical to `CoinFlip._settle`:
- `_settle(roundId, seed)` (called by `onCast` push or `claim` pull): guard `Pending`; set
  `Settled`; `won = (uint8(seed & 1) == round.side)`. Either branch first releases the reservation
  (`escrowed -= payout`), then:
  - **Win:** `chips.transfer(player, payout)`. The payout leaves the contract; bankroll is untouched
    here (the operator's `payout - stake` exposure was already debited at `open`). Net bankroll over
    the round: `-(payout - stake)`.
  - **Loss:** `bankroll += payout` (the whole reservation — the operator's exposure *plus* the
    player's now-forfeited stake — becomes free bankroll; nothing leaves the contract). Net bankroll
    over the round: `+stake`.
- `claim(roundId)` pull-fallback and `refundStale(roundId)` (seed genuinely missing + chopped or
  liveness timeout) are copied from `CoinFlip` almost verbatim; refund does
  `escrowed -= payout; chips.transfer(player, stake); bankroll += (payout - stake)` — the player gets
  their stake back and the operator's exposure returns to free bankroll.

Accounting invariant (asserted in tests): for every table,
`contract Chips attributable to table == bankroll + escrowed + stake`, and
`escrowed == Σ payout over Pending rounds`.

### Randomness — no operator in the loop

Every round heats a validator subset through `IRandom`, exactly as Coin Flip does today. The seed is
produced by validator preimages; the operator contributes nothing and signs nothing. The player
picks the subset (or the frontend defaults it to the deployment's canonical set), so "don't trust
this set? contribute your own randomness" holds unchanged.

### Ranking / discovery (frontend + indexer)

The frontend already lists games. Player-run tables add a second axis: for a given game, list the
**live tables** sorted by a composite of **recent activity** (rounds settled in a window) and
**operator stake**. Concretely:

- The indexer subscribes to `TableCreated` / `RoundOpened` / `Settled` / bankroll + stake events and
  maintains, per table: `stake`, `bankroll - escrowed` (free liquidity), rounds in the last N blocks,
  and last-active block. No consensus needed — it's a read model over public events.
- Sort key (MVP): `(open AND freeLiquidity ≥ someMin)` desc, then `activity` desc, then `stake` desc.
  Tables that can't cover a meaningful bet or are paused sink. This is the user's
  "34 games / x tables" — the catalog shows 34 game *types*; each expands to the live *tables*
  running it, best-funded and busiest first.
- The games-web UI gets: a table list under Coin Flip, a "Create a table" flow (create + fund +
  stake in one guided step), and "join this table" wiring `open()` to the chosen `tableId`. The
  existing Coin Flip felt surface is reused for play; only the table-selection chrome is new.

## What we are NOT building in this slice

- **`TableFactory` + standalone `TableVault`** — extract in Slice 2 once a second game exists.
- **Multiple games on vaults** — Slice 5 ports the rest after the pattern is proven on Coin Flip.
- **Reputation beyond stake + activity** (attestations, dispute history, slashing) — Slice 3.
- **Off-chain co-signed settlement for vaults** — not needed; on-chain per-round settle is the MVP.
  (This is the fork that would reintroduce operator signatures and thus slashing; deliberately avoided.)
- **Native-PLS bankrolls** — Chips only for the MVP.

## Follow-on slices (roadmap, each its own spec)

1. **This spec** — permissionless `CoinFlipTables` + validator round + escrow + bankroll/stake + UI.
2. Extract `TableVault` primitive + `TableFactory`; prove the "runs canonical code" guarantee via a
   factory-blessed game-code registry so a table can't advertise a rigged variant.
3. Reputation: activity/volume history, optional operator attestations, dispute surfacing. Slashing
   only if off-chain settle is ever added.
4. Frontend depth: richer browse/filter, operator dashboards, create-a-table for any game.
5. Port remaining games onto vaults.

## Testing

- **Accounting invariants** (Foundry/Hardhat, matching the repo's existing game tests): after any
  sequence of create/fund/open/win/loss/refund/withdraw/stake, assert
  `bankroll + escrowed + stake == tracked Chips` and `escrowed == Σ Pending payout`.
- **Escrow safety:** `withdrawBankroll` can never reduce `bankroll` below `escrowed`; a Pending
  round always has its full payout covered.
- **No double-settle / double-refund:** status guard before every transfer (checks-effects-
  interactions, no reentrancy guard — same reasoning as `CoinFlip._settle`, so the `claim` retry
  after a swallowed `onCast` still works).
- **Fairness parity:** seed parity → winner matches `CoinFlip` semantics; ported refundStale gates
  (seed missing AND chopped/stale) hold.
- **Multi-table isolation:** rounds and balances on table A never move table B's Chips.
- **Bounds:** `maxMultiplierX100` clamped; `stake ≤ maxStake`; insufficient free bankroll reverts
  `open` (never a partial escrow).

## Open decisions for review

1. **One contract vs. TableVault+Factory now** — spec recommends one contract for the MVP; reviewer
   may prefer building the abstraction immediately.
2. **`maxMultiplierX100` floor** — proposed `[150, 200]` (0–25% edge). Confirm the range.
3. **Subset default** — frontend defaults the validator subset to the deployment's canonical set, or
   force the player to choose? (Recommend default-with-override, matching today's Coin Flip.)
4. **`maxStake` — per-table operator choice (proposed) vs. a global cap.**

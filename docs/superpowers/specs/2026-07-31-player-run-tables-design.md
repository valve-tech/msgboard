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
> mechanical lift, not a rewrite. **Approved by the user 2026-07-31 — one contract for the MVP.**

### Data model

```solidity
struct Table {
    address operator;        // who funds and profits; set once at creation
    // --- hot/cold bankroll (see "Risk constraints & hot/cold bankroll") ---
    uint256 hot;             // ARMED free Chips — the ONLY balance a new round can escrow against
    uint256 cold;            // reserve; never backs a round until promoted to hot; always withdrawable
    uint256 escrowed;        // Chips locked by live (unsettled) rounds; the full payout of each
    uint256 stake;           // Chips the operator locked purely as a ranking/skin-in-game signal
    // --- risk constraints the table defines ---
    uint16  maxMultiplierX100; // payout multiple ×100 (e.g. 196 = 1.96×, a 2% house edge)
    uint256 maxStake;        // per-round stake cap the operator will cover
    uint256 hotTarget;       // desired armed level; refillHot tops `hot` up to this from `cold`
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

### Risk constraints & hot/cold bankroll

A table **defines its own risk envelope**, and its bankroll is split into two tiers so a bad run
can't drain the operator's whole reserve automatically:

- **`hot`** — the *armed* balance. It is the **only** balance a new round can escrow against. Its
  size is the operator's cap on automated exposure: no matter how many rounds open, the contract can
  never arm more than `hot` currently holds, so the most an unattended losing streak can cost is
  `hot` (+ whatever is already `escrowed`). `hot` never exceeds what the operator chose to arm.
- **`cold`** — the *reserve*. It never backs a round directly and is never at risk; it is always
  fully withdrawable. To put it to work the operator (or a permissionless top-up, below) must
  **promote** it into `hot`.
- **Risk constraints** the operator sets at creation and can tighten later: `maxMultiplierX100` (the
  edge), `maxStake` (biggest bet accepted), and `hotTarget` (the level `refillHot` arms `hot` up
  to). `hot` itself is the aggregate-exposure cap; `maxStake` bounds any single round.

Refill: **`refillHot(tableId)`** moves `min(cold, hotTarget − hot)` from `cold` to `hot`. Callable by
the operator anytime; also **permissionless when `hot` has fallen below `hotTarget`**, so a keeper or
the frontend can keep a live table armed without the operator babysitting it — but only ever up to
the operator's own `hotTarget`, never beyond, and only from that operator's own `cold`. This is the
"hot/cold resources to pull from": the operator parks the bulk in cold and the table re-arms itself
to the ceiling they set.

### Flows

**Create a table (permissionless).**
`createTable(uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget) → tableId`. Anyone.
Records `operator = msg.sender`, `open = true`, zero balances. `maxMultiplierX100` must be within
`[150, 200]` (≤ 2× so no negative house edge that would let an operator be drained by design; ≥ 1.5×
so tables can't advertise a predatory edge). Emits `TableCreated`.

**Operator can change any param at will.** `setParams(tableId, maxMultiplierX100, maxStake, hotTarget)`
and `setOpen(tableId, bool)` — operator only. Every table parameter is freely editable anytime
(`maxMultiplierX100` still clamped to `[150,200]`). Crucially, **param changes bind only NEW rounds**:
a `Round` snapshots its `payout` (hence its multiplier) and escrows against it at `open`, so a live
round is settled on the terms it was opened under — an operator lowering the multiplier or pausing
the table can never retroactively cut a bet already in flight. Emits `ParamsSet`.

**Fund / withdraw bankroll (two tiers).**
- `fundHot(tableId, amount)` / `fundCold(tableId, amount)` — `chips.transferFrom(operator → contract)`
  into the chosen tier.
- `promote(tableId, amount)` (cold→hot) / `demote(tableId, amount)` (hot→cold) — operator moves
  funds between tiers without an external transfer. `demote` banks profit out of harm's way.
- `withdrawHot(tableId, amount)` — operator only; revert if `amount > hot`. Because `hot` holds only
  the *free armed* balance and every live round's payout has already been moved into `escrowed` (see
  `open`), this one check is the load-bearing invariant: **escrowed Chips are never withdrawable**.
- `withdrawCold(tableId, amount)` — operator only; revert if `amount > cold`. Cold is never at risk,
  so it is always fully withdrawable.

**Stake for ranking.**
`stakeForRank(tableId, amount)` / `unstake(tableId, amount)` — operator only. `stake` is separate
from the bankroll tiers, freely withdrawable, and never touched by settlement. It exists solely as a
sorting/skin-in-the-game signal (see "Ranking"). **No slashing** in the MVP — under full on-chain
settle there is nothing to slash for; the escrow already guarantees payout and validators already
guarantee fairness. (Slashing only becomes meaningful if a future slice adds off-chain co-signed
settlement, where an operator *could* withhold a signature. Noted, out of scope.)

**Open a round.**
`open(tableId, uint8 side, uint256 stake, address[] validatorSubset, PreimageLocation.Info[] locations) → roundId`.
- Validate: table `open`, `stake ≤ maxStake`, `side ≤ TAILS`, subset valid.
- `payout = stake * maxMultiplierX100 / 100`. The operator only needs to cover winnings beyond the
  player's own returned stake, so require the **armed** balance covers that exposure:
  `hot ≥ payout - stake` (revert otherwise — never a partial arm; the player can `refillHot` and
  retry, or pick a better-funded table). Pull the player's stake in
  (`chips.transferFrom(player → contract, stake)`), then lock the **full** payout:
  `hot -= (payout - stake); escrowed += payout`. The `payout - stake` came from the operator's armed
  balance; the remaining `stake` is the player's own money now held in escrow. So `escrowed` always
  equals the exact amount owed to the player if they win, fully funded.
- Heat the validator subset (`_heatBound`, exactly as `CoinFlip._pairAndHeat`), store `key`, set
  `status = Pending`. Emit `RoundOpened`.

**Settle.**
Parity of the validator seed decides, identical to `CoinFlip._settle`:
- `_settle(roundId, seed)` (called by `onCast` push or `claim` pull): guard `Pending`; set
  `Settled`; `won = (uint8(seed & 1) == round.side)`. Either branch first releases the reservation
  (`escrowed -= payout`), then:
  - **Win:** `chips.transfer(player, payout)`. The payout leaves the contract; `hot` is untouched
    here (the operator's `payout - stake` exposure was already debited at `open`). Net `hot` over the
    round: `-(payout - stake)`.
  - **Loss:** `hot += payout` (the whole reservation — the operator's exposure *plus* the player's
    now-forfeited stake — returns to the armed balance; nothing leaves the contract). Net `hot` over
    the round: `+stake`. The operator can `demote` accumulated winnings to cold at will.
- `claim(roundId)` pull-fallback and `refundStale(roundId)` (seed genuinely missing + chopped or
  liveness timeout) are copied from `CoinFlip` almost verbatim; refund does
  `escrowed -= payout; chips.transfer(player, stake); hot += (payout - stake)` — the player gets
  their stake back and the operator's exposure returns to the armed balance.

Accounting invariant (asserted in tests): for every table,
`contract Chips attributable to table == hot + cold + escrowed + stake`, and
`escrowed == Σ payout over Pending rounds`. `cold` moves only via explicit fund/withdraw/promote/
demote/refill — **settlement never touches `cold`**, which is what makes the reserve safe by
construction.

### Randomness — no operator in the loop

Every round heats a validator subset through `IRandom`, exactly as Coin Flip does today. The seed is
produced by validator preimages; the operator contributes nothing and signs nothing. The player
picks the subset (or the frontend defaults it to the deployment's canonical set), so "don't trust
this set? contribute your own randomness" holds unchanged.

**The subset must clear `GameBase._validateSubset` before it is heated** — `MIN_SUBSET` (3) distinct,
all-allowlisted validators, exactly as `CoinFlip.enterAndMatch` does. `_heatBound` alone enforces
binding + per-member allowlist but NOT the distinct-count floor, so `open` must call
`_validateSubset(validatorSubset)` first. This is the load-bearing anti-grinding guarantee: a
degenerate 1-element or duplicate-validator subset would collapse "one honest validator defeats any
cartel" to "trust this one validator." Never heat an unvalidated subset.

### Historical verifiability — validate past rounds from immutable chain data

The platform's whole pitch is "we only provide the validation." That validation has to hold *after*
the fact and *without* trusting the platform's server or the contract's current getters (a getter
returns present state; an audit needs what was true at settlement). So the round record must be
reconstructable purely from **immutable on-chain history — event logs anchored to the block they
were mined in, plus the finalized seed the validators produced.**

Concretely:

- **Open and settle emit the full round, not just a pointer.** `RoundOpened` carries
  `roundId, tableId, player, side, stake, payout, subsetHash, key, openedAtBlock`; `RoundSettled`
  carries `roundId, seed, won, payout, settledAtBlock`. Everything needed to recompute the outcome is
  in the logs — no reliance on mutable storage that a later transaction could overwrite.
- **The seed is chain-anchored and permanent.** The winning parity is `seed & 1`, where `seed` is the
  validator-produced value in `IRandom` for the round's `key`. `IRandom` retains finalized seeds
  (settled Coin Flips already read them back), and the seed is echoed in `RoundSettled`, so a verifier
  can confirm it two independent ways: from the settle log and from `IRandom.randomness(key).seed`.
- **A standalone verifier replays any past round from logs alone.** Given a `roundId`, read its
  `RoundOpened` + `RoundSettled` logs (by block range / topic filter), recompute
  `winner = (seed & 1 == side) ? player : house`, recompute `payout = stake * maxMultiplierX100/100`
  using the multiplier snapshotted in the open log, and assert the settle log agrees. This is the
  "replayed by your browser" receipt, now anchored to block-mined logs rather than a live server —
  and any third party can run it against an archive/RPC node without the platform's cooperation.
- **Block values anchor liveness, too.** `openedAtBlock` (and `GameBase`'s `STALE_BLOCKS` /
  `block.number` timeout) let a verifier confirm a `refundStale` was legitimate: the round's seed was
  genuinely absent for the required number of blocks after `openedAtBlock`.
- **Tamper-evidence of the sequence (design note, MVP-optional):** because each round's identity is
  `roundId = keccak(contract, tableId, ++roundNonce)` and every open/settle is logged, the settled
  history of a table is an append-only, gap-detectable log — a missing nonce is visible. A running
  per-table settlement hash (each settle folds `keccak(prev, roundId, seed, playerDelta)`) would make
  the sequence a single verifiable commitment; **noted as optional for the MVP**, added in the
  reputation slice if a stronger cross-round guarantee is wanted.

This section imposes one hard rule on the implementation: **emit complete round data in events**, and
ship an off-chain verifier (in the games client) that reconstructs outcomes from logs, not getters.

### Ranking / discovery (frontend + indexer)

The frontend already lists games. Player-run tables add a second axis: for a given game, list the
**live tables** sorted by a composite of **recent activity** (rounds settled in a window) and
**operator stake**. Concretely:

- The indexer subscribes to `TableCreated` / `RoundOpened` / `Settled` / fund/withdraw/promote/stake
  events and maintains, per table: `stake`, `hot` (armed liquidity — the bet-backing capacity a
  player actually cares about), `cold` (reserve depth), rounds in the last N blocks, and last-active
  block. No consensus needed — it's a read model over public events.
- Sort key (MVP): `(open AND hot ≥ someMin)` desc, then `activity` desc, then `stake` desc. A table
  whose `hot` can't cover a meaningful bet sinks even if its `cold` is deep — armed liquidity is what
  a player can bet against right now (the frontend can surface "deep reserve, tap to arm" via the
  permissionless `refillHot`). Paused tables sink too. This is the user's "34 games / x tables" —
  the catalog shows 34 game *types*; each expands to the live *tables* running it, best-armed and
  busiest first.
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
  sequence of create/fund(hot|cold)/promote/demote/open/win/loss/refund/withdraw/stake/refill, assert
  `hot + cold + escrowed + stake == tracked Chips` and `escrowed == Σ Pending payout`.
- **Cold is never at risk:** no settlement/open/refund path ever reads or writes `cold`; a losing
  streak drains at most `hot + escrowed`, and `cold` is always fully withdrawable.
- **Escrow safety:** `withdrawHot` can never leave a Pending round's payout uncovered (payout already
  moved into `escrowed`, so `hot` only ever holds free funds).
- **Refill bounds:** `refillHot` moves at most `min(cold, hotTarget − hot)`, only from that table's
  own `cold`, never above `hotTarget`; permissionless caller can't exceed the operator's ceiling.
- **No double-settle / double-refund:** status guard before every transfer (checks-effects-
  interactions, no reentrancy guard — same reasoning as `CoinFlip._settle`, so the `claim` retry
  after a swallowed `onCast` still works).
- **Fairness parity:** seed parity → winner matches `CoinFlip` semantics; ported refundStale gates
  (seed missing AND chopped/stale) hold.
- **Multi-table isolation:** rounds and balances on table A never move table B's Chips.
- **Bounds:** `maxMultiplierX100` clamped to `[150,200]`; `stake ≤ maxStake`; `hot < payout − stake`
  reverts `open` (never a partial arm).

## Decisions

- **RESOLVED — one contract.** MVP is a single `CoinFlipTables` (user approved 2026-07-31);
  `TableVault`/`TableFactory` extraction deferred to Slice 2.
- **RESOLVED — Chips for both bankroll and stake; Coin Flip is the MVP game** (user approved).
- **RESOLVED — tables define their own risk envelope + two-tier hot/cold bankroll** (user directive
  2026-07-31): `maxMultiplierX100`, `maxStake`, `hotTarget`; only `hot` arms rounds, `cold` is a
  safe reserve promoted on demand.

### Resolved with defaults (user: "go with the defaults", 2026-07-31)

1. **`maxMultiplierX100` range = `[150, 200]`** (0–25% edge), enforced on create and on every
   `setParams`.
2. **Validator subset = default-with-override** — the frontend defaults to the deployment's canonical
   set; the player may substitute their own (matches today's Coin Flip).
3. **`maxStake` = per-table operator choice**, editable at will (no global cap).
4. **Every table param is operator-editable at will** (user directive 2026-07-31); changes apply to
   future rounds only, never to a round already open.

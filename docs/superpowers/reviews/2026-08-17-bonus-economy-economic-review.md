# Bonus economy — economic soundness review (369 gate)

Status: REVIEW, 2026-08-17. Scope: the operator "bonus economy" (System 2) as a
gate before any chain-369 (mainnet) launch. The design is testnet-943-only today.
Method: read-only. I read the specs, the contracts, and the invariant tests. I did
NOT run forge/hardhat (concurrent builds corrupt `out/`).

Sources read:
- Specs: `docs/superpowers/specs/2026-08-12-operator-bankroll-management-design.md`,
  `2026-08-12-validator-inclusion-policy-design.md`,
  `2026-08-13-operator-assets-program-design.md`,
  `2026-08-13-operator-assets-system2-accounting.md`,
  `2026-08-14-operator-assets-s2c-price-vesting-accounting.md`.
- Contracts under `games/contracts/contracts/games/operator/`: `OperatorCoinFlip.sol`,
  `GameEscrow.sol`, `EscrowLib.sol`, `BackingPool.sol`, `BonusChips1155.sol`,
  `MintSale.sol`, `Marketplace.sol`, `BurnFeePolicy.sol`, `IFeePolicy.sol`,
  `IBackingPool.sol`, `OperatorRegistry.sol`.
- Tests: `OperatorAssetsE2E.t.sol` (P1/P2/V1/V2 asserted after every terminal),
  `OperatorCoinFlipBoosted.t.sol`, `BackingPool.t.sol`, `MintSale.t.sol`.

Bottom line: the accounting is sound and fully collateralized. The boost cannot make
a player's expected value positive. The operator edge survives every outcome. There
is ONE load-bearing economic dependency that is not enforced on-chain — a reliable
chop-bot — and it must be a hard, monitored 369 gate. Details below.

---

## 1. The money-flow model

Each boosted round runs two escrow bets under one `roundId` (the paired-bet model,
accounting doc F-A). `GameEscrow` is byte-identical to the plain game (invariant I1).

Notation, per round of stake `σ` on a table with base multiplier `b` and a series of
bonus points `bp` (`setBonusSeries` enforces `b + bp ≤ 200`, so the effective
multiplier `eff = b + bp` is never clamped):
- `P_b = ⌊σ·b/100⌋` (base payout), `P_t = ⌊σ·eff/100⌋` (total payout).
- `x = P_b − σ` (operator base exposure), `d = P_t − P_b` (the boost delta).
- `w = ⌈maxStake·bp/100⌉` (per-charge backing, a CEIL by F-B), `r = w − d` (residual).
- `P` = the immutable charge price the buyer pays; `f = ⌊P·bps/10000⌋` (platform fee,
  `bps ≤ 1000`).

The four money pots:
- **Operator bankroll** (in `GameEscrow`) funds bet A exposure `x`. The operator earns
  the house edge and rake.
- **Backing pool** (`BackingPool`, its own `GameEscrow` bucket) funds bet B payout `d`.
  The operator funds this pot too, `w` per charge, at mint time.
- **Mint-sale escrow** (`MintSale`'s own balance, never a `GameEscrow` bucket) holds the
  buyer's price `P` until the charge burns.
- **Fee sink** (`IFeePolicy` → `BurnFeePolicy`) receives the validator forfeit (100%
  burn) and the platform fee (burn today; buyback is a future policy).

Genesis (buy `n` charges): the buyer pays `n·P` into the mint-sale escrow; the operator
pays `n·w` backing into the pool; `n` charges mint to the buyer. Minted supply can
never exceed funded backing, because the pool is the only minter and it deposits `n·w`
first (`BackingPool.fundEarmark`).

Open (T2): bet A locks `P_b` (operator exposure `x` + player stake `σ`); bet B locks
`d` from the pool bucket; the pool moves `w` out of `earmark` into `d` (bet B) plus
`r` (held). One charge moves player→game by exact pull.

Terminals (all fully pre-funded, so no settle can be short):
- **Win (T3):** player receives `P_t = P_b + d` from escrow. Pool returns residual `r`
  to operator credit. Charge burns; `P − f` vests to the operator, `f` accrues to the
  platform.
- **Loss (T4):** operator recovers `P_b` (stake + exposure) minus rake. Pool returns
  the full `w` (= `d + r`) to operator credit (the operator recovers its own backing;
  it is not a gain). Charge burns; `P − f` vests, `f` accrues.
- **Plain timeout (T5):** player refunded `σ`; the charge returns to the player; `P`
  stays escrowed (the claim rides the unit). Pool re-earmarks the full `w`, funded
  exactly by the returned `d + r`.
- **Chop / withheld reveal (T6):** player refunded `σ`; the withheld validator stake
  routes to the burn sink; the charge BURNS with the player as price beneficiary, so
  `P` refunds to the player and the operator vests NOTHING (the chop-harvest fix).
- **Expiry (T7):** a keeper burns unused charges; `w` returns to operator credit and
  `P` refunds to the current holder.

Conservation holds at every step. The tests assert it directly: P1 (`pool bankroll ==
Σearmark + Σhold + credit`), P2 (`earmark == circ·w`), V1 (`escrowed == alive·P`), V2
(`sale balance == Σescrowed + vested + refundable + fee`). `BackingPool._assertBacked`
reverts any transition that would break P2, so a corrupt state cannot commit.

I traced the full per-token ledger by hand across all seven transitions, plus the
cross-series case (one shared pool bucket, many series). The pool bucket is always
sufficient for a new bet B, because each series' own `earmark ≥ w ≥ d` and every locked
`d` is matched by an equal `earmark`-to-`hold` move (P1 stays exact). No cross-series
starvation.

---

## 2. Per-actor incentive analysis

**Operator (the house).** Profit-maximizing play: run tables with `eff < 200`, price
charges above the round's operating cost, keep bankroll funded, and run an honest
chop-bot. Operator expected value per settled boosted round:

    EV_operator = σ·(200 − eff)/200 + (P − f)

The first term is the bet edge (zero only at `eff = 200`); the second is the charge
price net of fee. EV_operator > 0 whenever `P > f`, which always holds (`f ≤ P`, and
`f < P` for `bps < 10000`). So the operator edge is preserved at every boost level,
including the fair-coin point `eff = 200`, where the entire edge is the charge price.
The operator cannot be made insolvent by adversarial play: every payout is pre-funded
in escrow at open, and bet B's `d` is the operator's own pre-posted backing.

**Player.** Profit-maximizing play: there is no positive-EV play. Player expected value
per settled boosted round:

    EV_player = σ·(eff − 200)/200 − P  ≤  −P  <  0   (for eff ≤ 200)

The player cannot selectively abort after seeing the outcome: the seed is hidden until
reveal, and once revealed the round settles through `claim` (`refundStale` reverts with
`TooEarly` while a seed exists). So there is no free option value in opening a round.

**Charge-holder.** Can never extract more than `P` from the price side, and can never
reach the backing `w` (it is operator capital; V3 keeps it unreachable). Refund/expiry
returns exactly `P` (fee-inclusive). A rugged holder loses nothing — the O4 vesting
model refunds the price when a charge is never used.

**Relayer.** The gasless x402 path is outside these contracts; no new incentive here.

**Arbitrageur.** Near expiry, buy a charge listed below `P` and expire it for `P`. This
is zero-sum against a naive seller, not a protocol loss (see leak L4). The expiry floor
is `P`, not the resale ask.

**Market-maker.** Profits from the resale spread; downside floored at `P`. Can extract
monopoly rent only if the operator closes the primary sale, which the operator can
reopen — a market dynamic, not a protocol leak.

---

## 3. Leaks and exploits, ranked by expected loss

### L1 — HIGH — Win-denial is free without a live chop-bot

The forfeit that makes a selective abort negative-EV bites ONLY if a chop lands before
the stale timeout. Read `OperatorCoinFlip.refundStale`: if `chopCredit == 0` (nobody
chopped), it takes the plain-timeout branch — it refunds the player and RETURNS the
charge, and the withheld validator stakes are never touched. The punitive forfeit
happens only in `chopAndRoute` or in `refundStale`'s chopped branch, i.e. only after a
chop has been recorded.

An operator can force its own validator into every subset (`DefaultValidatorPolicy`
`requireOperator = true`). If no chop-bot chops the withheld reveal, the operator
withholds on any round it is about to lose (a player win), the round plain-times-out,
and the operator pays nothing while denying the player the win.

Worked example. Table `b = 199`, `bp = 1`, so `eff = 200`; `σ = 1,000` tokens.
- `P_b = 1,990`, `x = 990`. The operator's bet-A exposure on a player win is 990.
- Player is about to win `P_t = 2,000` (profit 1,000). The operator withholds.
- WITH a chop-bot: the chop lands, the operator's validator forfeits `tierPrice ≥ σ =
  1,000` to the burn sink, saving only `x = 990`. Net −10 or worse. Negative-EV. Hole
  closed.
- WITHOUT a chop-bot: plain timeout. The operator saves `x = 990`, forfeits nothing,
  and the player only gets the stake back. Risk-free +990 per denied win.

The spec already names this: "an operator/keeper chop-bot that lands the chop within
`STALE_BLOCKS` is a HARD rollout gate for real-money bonus tables." The point of this
review is to rank it: this is THE economic assumption the whole forfeit design rests
on, and it is not enforceable on-chain (the forfeit needs a caller). Expected loss at
scale is unbounded (one denied max-stake win per round on a busy table).

Required for 369: a reliable, low-latency, redundant chop-bot; on-chain-visible proof
that chops land inside `STALE_BLOCKS`; alerting when they do not; and — recommended —
raise the third-party incentive to chop (today the forfeit burns, so no one but the
house is paid to chop; a small keeper bounty out of the forfeit would make chopping
self-sustaining rather than house-dependent). Note the boost does not widen this hole
versus a plain round; it is the base forfeit mechanism. But real money touches it here.

### L2 — MEDIUM — Fair-table + cheap charge drains the operator's own fee pool

A series can set `b + bp = 200` (a fair-coin bet, zero bet edge) with a tiny price `P`
(`MintSale.createSeries` only rejects `P == 0`). At `eff = 200` the operator edge is
`P − f` per round, but the operator still pays validator heat `F` per round out of its
fee pool.

Worked example. `eff = 200`, `P = 5`, `bps = 250` → `f = 0`. Three validators, tier
price 1,000 → `F = 3,000` per round metered from the operator's fee pool. The operator
collects 5 per round and spends 3,000 of its own pre-funded fee capital per round. It
bleeds its own pool.

This is not third-party theft — the player still loses `P` per round, so no one profits
at the operator's expense; the validators earn the heat as normal. It is an operator
footgun. Rank it MEDIUM because at `eff = 200` the product is a zero-bet-edge coin flip
whose only house margin is `P`, and an operator can price `P` below cost by mistake.
Required for 369: disclosure UI that shows the operator its per-round fee share versus
`P − f`, and a recommended floor that `P − f` covers the expected fee share. Consider a
platform-level minimum `P` relative to `maxStake`.

### L3 — MEDIUM — O4 holder protection depends entirely on exact role wiring

The price-refund guarantee (a rugged buyer loses nothing) is structural ONLY if the
roles are wired exactly: `chips.creator = MintSale`, `chips.minter = pool`,
`pool.minter = MintSale`, `chips` burners = exactly `{game, pool}`, and
`chips.priceLedger = MintSale`. No single on-chain check binds all of these together.

Failure modes and blast radius:
- `priceLedger` unset → burns release no price → holders never get refunds → a rugged
  buyer loses `P` (the F5 rug reopens).
- An extra burner added → that burner can burn charges with an arbitrary beneficiary →
  it can redirect price refunds. High impact.
- `minter` loose → under-backed supply → I4 breaks.

`OperatorCoinFlip.setBonusInfra` cross-checks the pool/chips pair (good), but the
mint-sale and chips role wiring is not asserted anywhere on-chain at deploy. The spec
flags this as "governance-critical, must be QA-asserted or O4 voids." Likelihood is low
if the runbook is followed; impact is high. Required for 369: a deploy-time assertion
script that reads back every role and reverts the rollout on any mismatch, run before
the first real-money series.

### L4 — LOW — Secondary sales below `P` leak to arbitrageurs; no protocol loss

The expiry floor is the mint price `P`, not the resale ask `Q`. A seller who lists below
`P` near expiry hands `P − Q` to an arbitrageur who buys and expires. This is zero-sum
against the naive seller and creates no value from nothing (the `P` paid out was funded
by the original buyer). Rank LOW: it is a user-education/disclosure item, already noted
in the S2c spec ("the new holder's expiry floor is `P` not their ask `Q`; disclose in
UI"). No fix needed beyond the disclosure.

### L5 — LOW — Backing capital lockup (efficiency, not a leak)

The operator posts `w = ⌈maxStake·bp/100⌉` per charge, but a small-stake round only uses
`d = ⌊σ·bp/100⌋ ≪ w`; the residual stays locked until the charge is used or expires. This
is capital inefficiency, not a fund-safety issue. No action required; note it in operator
docs so operators size `maxStake` sensibly.

### What is NOT a leak (checked and cleared)

- **No bleak.** `EV_player ≤ −P < 0` at every `eff ≤ 200`. The boost narrows the bet
  edge toward zero but the charge price keeps player EV negative. Even at the fair-coin
  point the player still pays `P`.
- **Every boosted payout is fully backed.** `P_t` sits in escrow `locked` at open (bet A
  `P_b` + bet B `d`). A win pays from pre-locked capital. I4 holds.
- **No payout exceeds collateral.** `d ≤ w` (CEIL, F-B; `consume` reverts `BoostTooLarge`
  otherwise). The residual returns to the operator; it is never over-credited.
- **Fee routing balances.** All routing is zero-sum plus intended burns (forfeit 100%
  burn; platform fee burn). No value is created from nothing.
- **Operator stays solvent under adversarial play.** Confirmed by the EV above and by
  the pre-funded escrow model.
- **Chop-harvest is closed.** Chop refunds `P` to the player; the operator vests nothing
  on an abort. A player-forced chop is non-profitable (loses the charge, worth ≥ `P`,
  plus the validator stake).
- **Cross-series pool solvency holds.** Proven by the per-token ledger trace in §1.

---

## 4. Go / no-go for 369

**Conditional GO.** The bonus economy is economically sound: the accounting is
conservative and test-asserted, the boost cannot flip player EV positive, and the
operator edge is preserved at every boost level. Ship to 369 ONLY after these gates:

1. **L1 (blocking).** A reliable, redundant, low-latency chop-bot is live, its chop
   latency is monitored against `STALE_BLOCKS`, and it alerts on any miss. Strongly
   recommended: add a keeper bounty out of the forfeit so chopping is self-sustaining,
   not house-dependent. Without this, win-denial is free and the whole forfeit design is
   moot.
2. **L3 (blocking).** A deploy-time role-wiring assertion reads back every role
   (`creator`/`minter`/`priceLedger`/burner allowlist across chips, pool, mint-sale,
   game) and refuses the rollout on any mismatch.
3. **L2 (required, non-blocking to code).** Disclosure UI shows the operator its
   per-round fee share versus `P − f`; add a platform floor on `P` relative to
   `maxStake`, or at least a hard warning at series creation.
4. **L4/L5 (disclosure).** UI states the expiry floor is `P` (not the resale ask) and
   documents backing lockup for operators.

No fund-safety defect blocks 369. The one true economic hole (L1) is an off-chain
liveness dependency the design already identified; treat it as a launch gate, not an
open item.

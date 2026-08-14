# System 2 — collateralization accounting (verified model)

Status: VERIFIED DESIGN (2026-08-13), from a fable accounting pass traced against the
live `GameEscrow`/`EscrowLib`/`OperatorCoinFlip` bytecode. This SUPERSEDES the
pinned single-inject flow in the program spec §5.3 — see F-A. It governs
fund-handling contracts, so it is the authority for the S2a/S2b plans.

## The three structural findings

- **F-A — paired-bet model (supersedes §5.3's inject flow).** The pinned flow
  (`pool.consume → depositBankroll(operator, d) → lockExposure`) is unimplementable:
  on refund, `refundExposure` credits the OPERATOR's escrow bucket
  (`EscrowLib.sol:54-57`), and only the operator can withdraw it
  (`GameEscrow.sol:126-130`), so the game cannot return the boost to the pool. The
  sound construction: the boost is a SECOND escrow bet, owned by the BackingPool
  (which calls `GameEscrow.authorizeGame(game,true)` on itself — permissionless,
  `GameEscrow.sol:135-138`). Escrow then structurally returns the boost to the pool's
  own bucket on every non-win terminal. `GameEscrow` is unmodified (I1 holds).
- **F-B — earmark must be a CEIL.** Per-charge backing `w = ⌈maxStake·bp/100⌉`
  (not floor). Counterexample where floor under-backs by 1: `maxStake=999, bp=25`
  gives floor `249` but a max boost delta of `250`. Proof `w ≥ d` for all `σ ≤ M`
  and `eff ≤ b+bp` is in the fable transcript.
- **F-C — series pins its token.** `BonusSeries` gains `token`. `setBonusSeries`
  requires `tables[tableId].token == series.token` AND `b + bp ≤ MULT_MAX` (no
  multiplier clamp at attach). Otherwise backing sits in the wrong token.

## Notation (per token τ, series s)

`b` = table base multiplier ∈[150,200]; `bp` = series bonusPoints; `eff = b+bp`
(≤200 by F-C); `M` = series.maxStake; `w = ⌈M·bp/100⌉`. For a round of stake σ:
`P_b = ⌊σ·b/100⌋`, `P_t = ⌊σ·eff/100⌋`, **boost `d = P_t − P_b`** (define as the
difference so the split is exact), base exposure `x = P_b − σ`, residual
`r = w − d ≥ 0`. `circ(s)` = minted − burned − game-held (game-held tracked by an
EXACT-PULL counter, one per open boosted round, never a balance read).

## The model — pool-as-co-operator, paired bets

`BackingPool` is a new contract that owns a `(pool, τ)` escrow bucket. All collateral
lives INSIDE `GameEscrow`, deposited at mint. The pool's internal ledger partitions
its escrow balance per token: `earmark[s]` (backs circulating charges), `hold[round]`
(a round's residual `r`), `credit[op][τ]` (released, operator-withdrawable through the
pool), `holderPot[s]` (expired-series redemption).

A boosted round opens TWO escrow bets under one game roundId:
- **Bet A** (`betId = roundId`): operator bucket, player, stake σ, payout `P_b` —
  byte-identical to today's `open()`.
- **Bet B** (`betId = keccak(roundId,"boost")`): POOL bucket, same player, stake 0,
  payout `d`. Passes all `lockExposure` checks (`d≥0`; zero-stake pull measures 0;
  `rakeBps(pool)=0` never reverts).

`tableLocked`/`tableCap` count BASE exposure `x` only (the operator's marginal risk;
the boost is pre-funded and can't bankrupt the operator). The Round struct stores the
split (`seriesId, d, w, effMult`) as APPENDED fields (the established appended-index
rule), and `_releaseTableExposure` reads the same field it incremented.

## Per-transition ledger (deltas; every transition is one atomic tx)

- **T1 MINT (n units):** mint-sale pulls `n·w` (measured; revert unless exact) →
  `depositBankroll(pool, τ, n·w)` → `earmark[s] += n·w` → mint n to buyer LAST.
  ΔPoolBank +n·w; supply +n.
- **T2 OPEN (σ):** checks (incl. `now<expiry`, token match, `eff≥minEffMult`,
  `eff>b`, **`d>0`** dust guard, `x>0`, fee, cap) → effects → heat → pull 1 charge
  (counter+1) → `pool.consume`{`earmark −= w`; `hold[round]=r`} → `lockExposure(B:
  pool, 0, d)` → `lockExposure(A: operator, σ, P_b)` LAST. ΔOpBank −x; Locked +P_t;
  PoolBank −d; feeBalance −F; tableLocked +x.
- **T3 SETTLE-WIN:** status first → release tableLocked → `settleWin(A)` pays `P_b` +
  `settleWin(B)` pays `d` (=P_t, fully liquid) → pool `hold −r → credit[op] +r` →
  burn LAST. Player +P_t; supply −1.
- **T4 SETTLE-LOSS:** `settleLoss(A)`: OpBank +(P_b−ρ), rake +ρ. `settleLoss(B)`:
  **PoolBank +d**, rake 0. pool: `hold −r`, **`credit[op] += w`** (=d+r). burn LAST.
  **Decision (item 3): the operator OWNS `d` after a settled loss** — released as
  `credit[op]` through the pool, never left in a withdrawable escrow bucket.
- **T5 PLAIN-REFUND (timeout):** status → release → `refund(A)` (player +σ, OpBank
  +x) → `refund(B)` (**PoolBank +d**) → pool `hold −r`, **`earmark += w`** (funded
  exactly by returned d+r — no external liquidity, ever) → RETURN charge to player
  LAST via try/catch (park in `parkedCharge` + permissionless `claimParked` on
  receiver failure). Fee NOT restored (matches today). supply unchanged (circ +1).
- **T6 CHOP-REFUND:** as built today (fee restore → refunds before sink route →
  forfeit measured → routed/parked) PLUS `refund(B)` returns d to pool, pool
  `credit[op] += w`, and **BURN the charge** (never return — removes the tier-
  boundary selective-abort profit, F4). supply −1.
- **T7 EXPIRY (immediate settlement — revised per owner, supersedes the window
  model).** `openBoosted` reverts once `now ≥ expiry`. The backing `w` is the
  OPERATOR's capital (deposited at mint, never used on an unopened round), so it
  returns to the operator IMMEDIATELY with no window: `expireCharges(s, holder, n)`
  (permissionless — any keeper) burns n expired units held by `holder` and moves
  `n·w` from `earmark[s]` to `credit[op]` in the same call. `circ` shrinks by n; P2
  holds (Δearmark = −n·w = Δcirc·w). **No `holderPot`, no claim window, no
  `redeemExpired`.** Holder protection is on the PURCHASE PRICE, not the backing —
  see O4: the price lives in the mint-sale vesting escrow, the operator vests it only
  as charges are USED, and an expired-unused charge refunds the price to the holder.
  So an operator that makes charges unspendable collects nothing and holders are made
  whole, without ever handing the operator's backing to holders. (Plan-level: the
  price refund and the backing return are separate flows on the same expired charge —
  the mint-sale burns-for-refund and the pool returns backing; sequence them so the
  charge is burned exactly once. The S2a/S2c plans pin the exact call decomposition.)
- **T8 WITHDRAW-CREDIT:** `pool.withdrawCredit(τ,a)` by the operator, `a ≤
  credit[op][τ]` → `escrow.withdrawBankroll` (pool is bucket owner) → operator. The
  ONLY door out of the pool; opens only for released credit.

## Invariant (per token τ) + preservation

- **P1 (pool conservation):** `bankrollOf(pool,τ) == Σ earmark[s] + Σ hold[r] + Σ
  credit[op] + Σ holderPot[s]`.
- **P2 (backing adequacy = I4):** non-released series `earmark[s] == circ(s)·w(s)`;
  released series `holderPot[s] == circExpired(s)·w(s)` until sweep.
- **P3 (in-flight liquidity):** every open boosted round has an open bet B with payout
  d; escrow maintains `locked == Σ open-bet payouts` and balance ≥ all buckets.
- **P4 (residual):** `hold[r] == w − d ≥ 0`, created once at T2, destroyed once at
  exactly one terminal (consumed-flag mirroring `Round.status`).

The fable transcript carries the full ΔLHS==ΔRHS table proving P1–P4 across T1–T8, and
lemmas L1 (`d ≤ w`) and L2 (`openBoosted` never reverts pool-side: PoolBank ≥
earmark[s] ≥ w ≥ d). I4 follows from P1∧P2∧P4.

## Reentrancy / CEI

- One SSTORE mutex per contract (Solady's TSTORE guard is undeployable pre-Cancun,
  I7). Game: `nonReentrant` on `openBoosted`, **`claim` (NEW — unguarded today,
  `OperatorCoinFlip.sol:330`)**, `chopAndRoute`, `refundStale`, `sweepForfeit`,
  `claimParked`, and the Random-cast entry reaching `_settle`.
- Pool state hooks (`consume`/`onSettle`/`onPlainRefund`/`onChopRefund`) are
  `msg.sender == game` only (game mutex held). Pool token-movers (`withdrawCredit`,
  `redeemExpired`, mint deposit) carry the pool mutex + CEI (debit ledger before
  transfer; redeem burns before paying).
- Untrusted interactions LAST: the 1155 charge return to the player (T5) is the one
  untrusted callback; at that point all ledgers are terminal and re-entry hits
  `AlreadyResolved`. The game's `onERC1155Received` accounts NOTHING (exact-pull only;
  unsolicited pushes are ignored → harmless over-backing).

## Token support (narrower than the substrate)

Boosted tables reject fee-on-transfer, zero-value-transfer-reverting, and rebasing
tokens (bet B pulls/pays 0; measured deposits must be exact). Enforce at series
creation with a 0-value probe + measured mint; state in disclosure UI.

## Locked recommendations

Residual = hold-until-terminal, VARIABLE stake (reject fixed-stake: it fragments
liquidity and still needs the hold machinery). Operator owns `d` after settle-loss
(via credit). Adopt paired-bet (F-A). `w = ceil` (F-B). Series pins token + no-clamp
attach (F-C). `d > 0` dust guard. Immediate expiry settlement — backing → operator on
burn (`expireCharges`), holder price refund via vesting (O3/O4, revised per owner).
Guard `claim`. Caps count base exposure only (O2).

## Open decisions for the owner (defaults in force unless changed)

- **O1 — paired-bet deviates from §5.3's literal inject sequence.** It satisfies the
  intent (tokens in escrow before lock; win fully liquid; GameEscrow byte-identical)
  and is the only sound construction. Default: ADOPT. Owner sign-off requested.
- **O2 — `tableCap` basis:** base exposure only (default) vs total exposure.
- **O3 — RESOLVED (owner): immediate expiry settlement, no window.** Backing returns
  to the operator the moment an expired charge is burned (`expireCharges`, permissionless);
  there is no claim window and no holderPot. Holder protection is the purchase-price
  refund (O4), not the backing.
- **O4 — purchase-price refund is now LOAD-BEARING (the sole holder protection).** The
  mint-sale vesting escrow holds each buyer's price; the operator vests it only as
  charges are USED (burned via a round), and an expired-unused charge REFUNDS the
  unvested price to the holder. This closes the F5 rug (an operator who makes charges
  unspendable collects nothing; holders get their money back). Needs its own accounting
  pass in the S2c mint-sale plan; the S2a backing pool must expose the burn/return hook
  it composes with.
- **O5 — charge-holder liveness (C6):** a fee-starved operator still blocks boosted
  opens with backing present; expiry now gives holders a `w`/unit floor. Full fix
  deferred to the bonus-economy plan.
- **O6 — boosted-table token policy** (no FOT/zero-revert/rebase) — disclosure UI +
  mint-time enforcement.
- **O7 — a boosted round emits TWO escrow `Settled` events** (bets A and B); the
  caster/QA/indexer must handle the pair and the `payout != stake·maxMult/100` break.

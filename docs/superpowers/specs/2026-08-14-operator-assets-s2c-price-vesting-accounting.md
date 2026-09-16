# S2c accounting — purchase-price vesting, expiry refund, marketplace

Status: VERIFIED DESIGN (2026-08-14), fable accounting pass traced against the built
S2a/S2b contracts. Governs the PRICE side only — the purchase price NEVER enters
`GameEscrow` or `BackingPool`, so the backing-side P1–P4 (see
`2026-08-13-operator-assets-system2-accounting.md`) are untouched. Authority for the
S2c mint-sale + marketplace plan.

## Core design — bearer price stamp + burn-routed release

Two facts force it: (1) charges are freely transferable, fungible ERC1155 units with
no transfer hook, so a per-(holder,series) unvested-price ledger desyncs on any
transfer; (2) use-burns vs expiry-burns are indistinguishable after the fact. So:

- **One series, one immutable price `P`** (and a stamped fee split), set at series
  creation. Repricing = a new series.
- **The refund claim is a bearer property of the unit** — whoever holds a live unit
  holds its `P` claim. Transfers/resales/partial transfers need ZERO claim
  bookkeeping; the ERC1155 balance IS the claim registry. This is the elegant answer
  to the fungible-resale problem.
- **Every price release fires inside the burn.** `BonusChips1155.burn` gains an
  `onBurn(burner, from, id, n, beneficiary)` hook that calls the MintSale after
  `_burn`. A unit burns at most once; each burn fires the hook once; the hook releases
  exactly `n·P`. Exactly-once is structural, not procedural — and it is the single
  place a charge is burned, resolving the backing-side MEDIUM-3.

## Contract deltas (small)

- **MintSale (new)** — the vesting escrow + primary sale. Holds price tokens in its
  OWN balance (never a GameEscrow bucket — those are operator-withdrawable, which
  would void O4). Holds roles `chips.creator` and `pool.minter`. Ledgers (all
  pull-withdrawn): `escrowed[s]`, `vested[op][τ]`, `refundable[addr][τ]`,
  `feeAccrued[τ]`; tracks `alive(s) = minted − burned` from its mints + the burn hook.
- **Marketplace (new)** — approval-fill fixed-price resale, NO charge custody (custody
  would be expiry-burnable, see below). `IFeePolicy("marketplace")` bps at fill.
- **BonusChips1155 (~15 lines)** — `priceLedger` addr + owner setter; every burn calls
  `priceLedger.onBurn(...)` after `_burn` (no-op if unset); add
  `burnWithBeneficiary(from,id,n,beneficiary)` for the burner allowlist. Plain `burn`
  ABI unchanged, so the pool needs no change.
- **OperatorCoinFlip (ONE line)** — the chop-burn site becomes
  `burnWithBeneficiary(address(this), sid, 1, r.player)`. Win/loss burns stay plain.
- **BackingPool — ZERO changes.** `expireCharges`' burn now carries the refund
  automatically.

Wiring (governance-critical): `chips.creator = MintSale`, `chips.minter = pool`,
`pool.minter = MintSale`, `chips` burners = exactly `{game, pool}`,
`chips.priceLedger = MintSale`.

**Hook safety rule (load-bearing):** `onBurn` is `msg.sender == chips` only, SSTOREs
only, no external calls, and CANNOT revert on any reachable input (unknown series →
no-op). A reverting hook would freeze settles + expiry. Audit-checklist item.

## Price-side transitions (deltas)

- **S1 buy(s,n):** buyer −n·P; `escrowed[s] += n·P`; then `pool.fundEarmark(s,n,op,buyer)`
  (backing side) mints n to the buyer LAST. No fee at sale (fee-at-vest). `alive += n`.
- **S2 use (settle win OR loss):** plain game burn → hook (`beneficiary==0`):
  `escrowed −= P`, `vested[op] += P−f`, `feeAccrued += f`. Outcome-blind: the operator
  earned `P` because a fair round settled. `alive −= 1`.
- **S3 plain-timeout return:** no burn; charge returns alive; `P` stays escrowed.
  No price-side change.
- **S4 chop:** `burnWithBeneficiary(game, sid, 1, player)` → hook: `escrowed −= P`,
  `refundable[player] += P`. **Operator vests NOTHING on an abort** (chop-harvest fix,
  below). `alive −= 1`.
- **S5 expiry refund** (`pool.expireCharges`, permissionless, unmodified): its
  `chips.burn(holder,s,n)` → hook (`burner==pool`): `escrowed −= n·P`,
  `refundable[holder] += n·P` (fee-INCLUSIVE). Backing return rides the same tx (T7).
  `alive −= n`.
- **S6 secondary resale (fill):** units move seller→buyer, fee `m` accrues; the claim
  rides the units, zero ledger change. New holder's expiry floor is `P` (not the ask).
- **S7 withdrawals/sweep:** `withdrawVested`/`withdrawRefund`/`sweepFees`
  (→ `IFeePolicy.route`), each zero-sum, CEI, nonReentrant.

## Invariants

- **V1 (vesting adequacy = O4):** per series `escrowed[s] == alive(s)·P` (alive counts
  holder-held, listed, AND game-held in-flight units).
- **V2 (token conservation):** `balanceOf(MintSale,τ) ≥ Σ escrowed + Σ vested + Σ
  refundable + feeAccrued`.
- **V3 (operator reachability):** the operator can reach ONLY `vested[op][τ]`. No
  function moves `escrowed`/`refundable` toward the operator.
- **V4 (exactly-once release):** every burned unit releases exactly one `P`, routed by
  `(burner, beneficiary)` — pool→from, game+beneficiary→beneficiary, game-alone→
  `(P−f)` vest + `f` fee. Releases occur only in `onBurn`, once per burn.

Preservation of V1/V2 across S1–S7 is proven in the fable transcript (ΔLHS==ΔRHS every
row; rounding exact because `f` is stamped per unit).

## The chop-harvest attack (found this pass) — why chop refunds the player

If a chop-burn vested `P` to the operator, an operator running its own validator
(`requireOperator` forces it into every subset) could withhold on every boosted round,
chopping it: the operator recovers its fee + full `w` (T6) and would vest `P`, while
the player recovers only the stake — attack cost is just the colluding validator's
forfeit, and `P` is operator-chosen and unbounded relative to it. That reopens F5 via
the abort path. **Fix (pinned): `P` vests to the operator ONLY on a settled round
(win/loss); every other end of a unit's life refunds `P` to its holder** (chop → the
round's player; expiry → the current holder). This is the sole reason for the one-line
game change. Reverse (a player forcing a chop) is non-profitable (loses the charge
worth ≥ P plus its validator stake).

## Fee decision (pinned)

**Fee-at-vest; refunds fee-inclusive.** Buyer pays `P` gross; escrow holds gross; the
platform cut `f` comes out of the operator's vested share on each settled round; every
refund returns full `P`. So a rugged buyer loses zero, and the platform earns only on
delivered boosts. Stamp `bps_mint` at series creation (cap ≤ 1000 bps, owner to pin);
marketplace `bps_mkt` read at fill (same cap).

## Marketplace — approval-fill (no custody)

Custody is rejected: a custodial marketplace becomes an ERC1155 holder, and permissionless
`expireCharges` could burn its pooled inventory. Approval-fill: listing =
`{seller, s, unitsRemaining, Q}`; seller keeps custody + grants operator approval.
`fill` pulls the buyer's payment, accrues the fee, pays the seller, then
`safeTransferFrom(seller→buyer)` LAST; a stale listing reverts atomically (buyer safe).
The claim rides the units across resale exactly, including partial fills, zero ledger
writes.

## Redeploy scope (owner sign-off) + residuals

- **Redeploy:** chips (hook) + pool (immutable `chips` ref) + game (one-line chop
  change) → re-run `setBonusInfra` wiring. BackingPool logic untouched. New MintSale +
  Marketplace deployed fresh.
- Immutable `P` per series (operators rotate series); secondary buyer's floor is `P`
  not their ask `Q` (disclose in UI); governance invariants (the wiring above) must be
  QA-asserted or O4 voids; `onBurn` revert-free (audit); fee caps to pin; settle-gas
  re-baseline (the hook adds ~2 SSTOREs per boosted terminal — re-check the 943 caster
  margin) + new indexer events.

## S2c build slices (from this design)

- **S2c-1:** BonusChips1155 `onBurn` hook + `burnWithBeneficiary`; the one-line game
  chop-site change; wiring setters. (Redeploy-affecting — bundle with S2e.)
- **S2c-2:** MintSale (vesting escrow + `buy` + the four ledgers + withdrawals +
  `onBurn` router) with V1–V4 tests + a chop-harvest test.
- **S2c-3:** Marketplace (approval-fill list/fill/cancel + fee) with tests.
- **S2c-4:** full-suite + deployability + an end-to-end price+backing invariant test.

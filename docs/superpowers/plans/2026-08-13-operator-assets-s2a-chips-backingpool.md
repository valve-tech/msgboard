# System 2 — Slice S2a: BonusChips1155 + BackingPool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the two foundation contracts of the bonus economy — the consumable `BonusChips1155` charge token and the `BackingPool` co-operator that holds collateral inside `GameEscrow` — and prove the collateralization invariant in isolation, before the game integration (S2b).

**Architecture:** The **paired-bet model** (accounting doc, F-A). `BackingPool` authorizes itself as a `GameEscrow` bucket owner; all collateral lives in the pool's `(pool, token)` escrow bucket, deposited at mint. The pool keeps an internal per-token ledger — `earmark[series]`, `hold[roundId]`, `credit[op][token]` — mutated only by game-only hooks (`consume`/`onSettle`/`onPlainRefund`/`onChopRefund`) and by permissionless `expireCharges`, and drained only by operator `withdrawCredit`. S2a tests the pool's ledger invariant against a **mock game caller** + the real `GameEscrow`; the full paired-bet-through-`openBoosted` integration is S2b.

**Tech Stack:** Solidity 0.8.25 (evm shanghai, no MCOPY/TSTORE), Solady ERC1155, Foundry.

**Spec:** `docs/superpowers/specs/2026-08-13-operator-assets-system2-accounting.md` (the VERIFIED accounting model — authority for every ledger delta and the P1–P4 invariant) + program spec §5.

## Global Constraints

- **`GameEscrow` is NOT modified** (I1). The pool interacts only through its public entrypoints (`authorizeGame`, `depositBankroll`, `withdrawBankroll`, and — driven by the game in S2b — `lockExposure`/`settleWin`/`settleLoss`/`refund` with `operator = pool`).
- **`w = ⌈maxStake·bonusPoints/100⌉`** per charge (F-B — ceil, never floor). Series pins `token` and requires `base + bonusPoints ≤ MULT_MAX` at attach (F-C, enforced in S2b's `setBonusSeries`; S2a stores the series params).
- **Invariant (must be tested):** per token τ, `bankrollOf(pool,τ) == Σ earmark[s] + Σ hold[r] + Σ credit[op] ` (P1), and for every series `earmark[s] == circ(s)·w(s)` (P2), and `hold[r] == w−d ≥ 0` created/destroyed exactly once (P4). `circ` = minted − burned − game-held (exact-pull counter, never a balance read).
- **Expiry is immediate (O3):** `expireCharges` burns expired units and returns `n·w` from `earmark` to `credit[op]` — no window, no holderPot. Holder purchase-price protection is the mint-sale's job (S2c, O4).
- **Reentrancy:** one SSTORE `ReentrancyGuard` per contract (Solady TSTORE guard is undeployable pre-Cancun). Pool state hooks are `msg.sender == game` only; token-movers (`withdrawCredit`, `fundEarmark`) carry the pool mutex + CEI (ledger before transfer). BonusChips1155 mint/burn are role-gated.
- Token support is narrower for boosted tables: no fee-on-transfer / zero-value-revert / rebasing (measured deposits must be exact). Enforce at series creation (S2b/S2c); S2a's `fundEarmark` uses measured deltas.
- Deployability (I7): solc 0.8.25 / evm shanghai per-file override; verify no MCOPY/TSTORE on stripped bytecode; EIP-170 < 24576.

---

## File Structure

- `games/contracts/contracts/games/operator/BonusChips1155.sol` (create) — Solady ERC1155; a series registry `createSeries(bonusPoints, maxStake, expiry, token) → id`; role-gated `mint` (minter only) and `burn` (burner set: game + pool); `seriesOf(id)` view; `w(id)` view (ceil).
- `games/contracts/contracts/games/operator/IBackingPool.sol` (create) — the hook interface the game (S2b) will call: `consume`, `onSettle`, `onPlainRefund`, `onChopRefund`.
- `games/contracts/contracts/games/operator/BackingPool.sol` (create) — the co-operator + ledger.
- `games/contracts/test/foundry/BonusChips1155.t.sol` (create) — series/mint/burn/role tests + `w` ceil (incl. the F-B counterexample `maxStake=999,bp=25 → w=250`).
- `games/contracts/test/foundry/BackingPool.t.sol` (create) — the invariant tests: replay hook sequences via a mock game against the real `GameEscrow`; assert P1/P2/P4 after every transition and after randomized sequences.

---

## Task 1: `BonusChips1155` (series + role-gated mint/burn)

**Files:** create `BonusChips1155.sol`, `test/foundry/BonusChips1155.t.sol`.

**Interfaces:**
- Produces: `createSeries(uint16 bonusPoints, uint256 maxStake, uint64 expiry, address token) → uint256 id` (owner/authorized-creator only — the mint-sale in S2c; for S2a an owner-set `creator`); `seriesOf(id) → (bonusPoints, maxStake, expiry, token)`; `w(id) → uint256` (= `⌈maxStake·bonusPoints/100⌉`); `mint(to, id, amount)` (minter only); `burn(from, id, amount)` (burner only); standard ERC1155 balances/transfers (Solady base).

- [ ] **Step 1: Write failing tests** (`BonusChips1155.t.sol`): `createSeries` stores params and derives `w` as CEIL — assert `w` for `(maxStake=999, bonusPoints=25)` is `250` (F-B counterexample; a floor impl returns 249 and fails); `mint` reverts for a non-minter and succeeds for the minter; `burn` reverts for a non-burner and succeeds for an authorized burner; transfers move balances (Solady). Run `forge test --mp test/foundry/BonusChips1155.t.sol` → FAIL.
- [ ] **Step 2: Implement** `BonusChips1155` on Solady's `ERC1155`. Roles: `owner` sets `creator`, `minter`, and a `burner` allowlist (game + pool addresses, set in S2b/deploy). `w(id)` computes the ceil. Keep it minimal; no `uri` logic beyond a stored per-series metadata pointer (theming/art is System 1's concern, not here).
- [ ] **Step 3:** `forge test --mp test/foundry/BonusChips1155.t.sol` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(assets-s2a): BonusChips1155 consumable charge token (series registry, ceil w, role-gated mint/burn)"`

---

## Task 2: `BackingPool` (co-operator + collateral ledger)

**Files:** create `IBackingPool.sol`, `BackingPool.sol`, `test/foundry/BackingPool.t.sol`.

**Interfaces:**
- Consumes: `GameEscrow` (authorizeGame/deposit/withdraw), `BonusChips1155` (`w`, `burn`, `seriesOf`).
- Produces (hooks, `msg.sender == game` only): `consume(bytes32 roundId, uint256 seriesId, uint256 d)` (earmark −= w; hold[roundId] = w−d; record (series,d,w)); `onSettle(bytes32 roundId)` (hold −r → credit[op] += r on win; += w on loss — the game tells it which, or the pool infers from whether escrow returned d; pin in the accounting: onSettleWin releases r, onSettleLoss releases w); split into `onSettleWin`/`onSettleLoss` for clarity; `onPlainRefund(roundId)` (hold −r; earmark[series] += w — the returned d+r); `onChopRefund(roundId)` (hold −r; credit[op] += w). Produces (public): `fundEarmark(seriesId, uint256 n, address from)` (minter/mint-sale only — measured pull of `n·w`, `depositBankroll(pool)`, earmark += n·w); `expireCharges(seriesId, holder, n)` (permissionless — requires `now ≥ expiry`; `BonusChips1155.burn(holder, id, n)`; earmark −= n·w; credit[op] += n·w); `withdrawCredit(token, amount)` (operator only — `credit[op] −= amount`; `escrow.withdrawBankroll`; forward). Views: `earmark(id)`, `hold(roundId)`, `credit(op, token)`.

  Note: the pool must know each series' `operator` to key `credit[op]`. Store `seriesOperator[id]` set at `fundEarmark` (the operator funding the earmark) — or read it from the mint-sale. Pin: `fundEarmark` records the operator; `credit` is keyed by that operator.

- [ ] **Step 1: Constructor + self-authorize** — constructor takes `(escrow, chips, game)`; calls `GameEscrow(escrow).authorizeGame(game, true)` so the game may lock/settle bets in the pool's bucket. (Confirm `authorizeGame`'s exact signature/semantics against `GameEscrow.sol` first — the accounting doc cites it as permissionless self-sovereign at :135-138.)
- [ ] **Step 2: Write failing invariant tests** (`BackingPool.t.sol`) using a MOCK game contract that calls the hooks, against the REAL `GameEscrow` + `BonusChips1155` + a mock ERC20:
  - `test_mint_earmarks`: `fundEarmark(s, n)` → `bankrollOf(pool) == n·w` and `earmark(s) == n·w` (P1, P2).
  - `test_consume_then_win_releases_residual`: simulate T2 consume + T3 win (the mock game does the escrow bet-B lock/settleWin with operator=pool AND calls consume/onSettleWin) → assert `earmark`, `hold`, `credit`, `bankrollOf(pool)` match the accounting doc T2/T3 deltas; P1 holds.
  - `test_consume_then_loss_returns_d_to_pool`: T2 + T4 → assert PoolBank += d, `credit[op] += w`, P1/P2 hold.
  - `test_plain_refund_reearmarks`: T2 + T5 → assert `earmark += w` (funded by returned d+r), circ +1, P2 holds.
  - `test_chop_refund_burns_and_credits`: T2 + T6 → assert charge burned, `credit[op] += w`, P2 holds.
  - `test_expire_returns_backing_to_operator`: mint, advance past expiry, `expireCharges` → `credit[op] += n·w`, `earmark −= n·w`, circ −n, P2 holds; and it REVERTS before expiry.
  - `test_withdrawCredit_only_released`: operator can withdraw exactly `credit`, not more; a non-operator cannot.
  - `test_invariant_random_sequence`: a bounded fuzz/loop applying a random legal sequence of {mint, consume+win, consume+loss, consume+plainRefund, consume+chopRefund, expire, withdrawCredit}; after EACH step assert P1 (`bankrollOf(pool) == Σ earmark + Σ hold + Σ credit`) and P2 (`earmark[s] == circ(s)·w`).

  Run → FAIL (BackingPool absent).
- [ ] **Step 3: Implement `BackingPool`** to the accounting doc's T1–T8 deltas exactly. Hooks `msg.sender == game`; `fundEarmark` minter-only; `expireCharges` permissionless; `withdrawCredit` operator-only with CEI (debit `credit` before `withdrawBankroll`); pool `ReentrancyGuard` on the public token-movers. The pool NEVER reads a 1155 balance for accounting — it trusts the game's exact-pull counter conveyed through the hooks and its own `earmark`/`circ` bookkeeping.
- [ ] **Step 4:** `forge test --mp test/foundry/BackingPool.t.sol` → PASS (all invariant tests, including the fuzz).
- [ ] **Step 5: Commit** — `git commit -m "feat(assets-s2a): BackingPool co-operator + collateral ledger (paired-bet, P1/P2/P4 invariant tested)"`

---

## Task 3: Deployability gate

- [ ] **Step 1:** `cd games/contracts && forge test` full suite green.
- [ ] **Step 2:** Add the shanghai per-file override for `BonusChips1155.sol` and `BackingPool.sol` (hardhat + foundry profiles), and verify stripped-bytecode has no MCOPY(0x5e)/TSTORE(0x5d) and size < 24576 (reuse the inline scan from Slice 0 Task 4). Add both to `OperatorSubstrateSize.t.sol`.
- [ ] **Step 3: Commit** — `git commit -m "chore(assets-s2a): deployability gate (shanghai override + MCOPY/TSTORE + size) for chips + backing pool"`

---

## Deferred to S2b+ (documented)

- `openBoosted` + `setBonusSeries` (F-C token/clamp checks) + the charge pull/burn/return lifecycle + the paired bet-B `lockExposure(pool,...)` and its settle/refund + guarding `claim` — the GAME integration, S2b (a game redeploy).
- Mint-sale (vest-against-burns + expired-price refund, O4), marketplace, fee-policy wiring — S2c.
- Operator-game player UI + bonus/boost UI + deferred theming wiring — S2d. 943 reprove — S2e (owner-gated).

## Self-Review

- **Accounting coverage:** T1 mint → Task 2 `fundEarmark`; T2 consume → `consume`; T3/T4 → `onSettleWin`/`onSettleLoss`; T5 → `onPlainRefund`; T6 → `onChopRefund`; T7 expiry → `expireCharges`; T8 → `withdrawCredit`. Every transition has a function AND an invariant test. P1/P2/P4 fuzz-tested.
- **No placeholders:** the one implementer choice (onSettle split vs inferred) is called out; `w` ceil has the exact F-B test value.
- **Invariant-first:** the pool's correctness IS the P1/P2 test; the fuzz sequence is the core deliverable, mirroring how Slice 0's park test was the core.
- **Isolation:** S2a proves the ledger against the real escrow with a mock game, so a bug is caught before the (larger) game-integration surface in S2b.

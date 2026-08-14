# System 2 — Slice S2b: openBoosted game integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire the verified S2a collateralization (BonusChips1155 + BackingPool) into `OperatorCoinFlip` via the paired-bet model — an `openBoosted` entrypoint, the charge lifecycle (pull/burn/return), the paired bet-A/bet-B settle/refund, `setBonusSeries` with the F-C checks, and a `claim` reentrancy guard. Source only; the redeploy + live reprove is S2e (owner-gated).

**Architecture:** A boosted round opens two escrow bets under one roundId — bet A (operator bucket, stake σ, payout `P_b`) exactly like today's `open()`, and bet B (pool bucket, stake 0, payout `d`). The pool's ledger is updated in lockstep via its game-only hooks. Non-boosted `open()` is byte-for-byte unchanged. `GameEscrow` untouched.

**Tech Stack:** Solidity 0.8.25 (evm shanghai, no MCOPY/TSTORE), Foundry.

**Spec / authority:** `docs/superpowers/specs/2026-08-13-operator-assets-system2-accounting.md` (the T1–T8 ledger + P1–P4 invariant + reentrancy/CEI — the authority for every delta and ordering) and the S2a contracts (`BackingPool.sol`, `BonusChips1155.sol`).

## Global Constraints

- `GameEscrow`/`EscrowLib` NOT modified (I1). The paired boost bet uses the existing `lockExposure`/`settleWin`/`settleLoss`/`refund` with `operator = pool`.
- Non-boosted `open()`/`_settle`/`_routeForfeit`/`refundStale` behavior for plain rounds is UNCHANGED (Slice 0's neutral-sink forfeit stays). Boosted paths branch on `round.seriesId != 0`.
- **CEI ordering (accounting §6), exactly as verified:** T2 open — checks → effects (Round incl. boost fields, `tableLocked += x`, `feeBalance -= F`, instanceByKey) → heat → pull 1 charge (player→game) → `pool.consume` → `lockExposure(B: pool, 0, d)` → `lockExposure(A: operator, σ, P_b)` LAST. Terminals set `status` first, release `tableLocked`, settle/refund both bets, call the pool hook, then the untrusted 1155 move LAST (burn fires no hook; a return-to-player uses try/catch-park).
- **Caps count base exposure `x` only** (O2). `tableLocked` moves by exactly `x` up at open and down once per terminal — preserve the drift-free exactly-once discipline.
- **Charge lifecycle, exactly once:** pull 1 at open; on settle-win/settle-loss/chop-refund BURN it; on plain-timeout REFUND it to the player (try/catch → park). Mirror the `status` exactly-once guard so no path double-burns/returns.
- `d > 0`, `eff > base`, `eff >= minEffMult`, `stake <= series.maxStake`, `now < series.expiry` all checked in `openBoosted`.
- `setBonusSeries` (F-C): `onlyOperator`, requires `table.token == series.token` AND `table.maxMultiplierX100 + series.bonusPoints <= MULT_MAX` (no clamp reliance).
- Guard `claim` with `nonReentrant` (it is unguarded today — accounting §6).
- Pre-Cancun deployability (I7); EIP-170 (headroom was ~14KB before Slice 0 — measure).

---

## File Structure

- `games/contracts/contracts/games/operator/OperatorCoinFlip.sol` (modify) — bonus infra pointers + `setBonusSeries` + `openBoosted` + boosted branches in `_settle`/`_routeForfeit`/`refundStale` + guard `claim` + boost fields on `Round` (appended) + `BoostApplied` event.
- `games/contracts/test/foundry/OperatorCoinFlipBoosted.t.sol` (create) — the end-to-end paired-bet tests against the REAL `GameEscrow` + REAL `BackingPool` + REAL `BonusChips1155` driven by the real `openBoosted`, asserting P1/P2 hold through the game (not a mock) across win/lose/plain-timeout/chop, plus the check reverts.
- `games/contracts/test/foundry/OperatorCoinFlip.t.sol` (modify) — confirm plain `open()`/settle/forfeit tests still pass unchanged (regression).

---

## Task 1: Bonus infra wiring + `setBonusSeries`

**Files:** modify `OperatorCoinFlip.sol`; add tests to `OperatorCoinFlipBoosted.t.sol`.

**Interfaces:**
- Produces: immutable-ish `backingPool`, `bonusChips` (set once via owner `setBonusInfra(pool, chips)` — the pool references the game in ITS constructor, so deploy order is game → pool → `setBonusInfra`); `bonusSeries[tableId]` mapping; `setBonusSeries(bytes32 tableId, uint256 seriesId)` (onlyOperator, 0 = disable); event `BonusSeriesSet`.

- [ ] **Step 1: Write failing tests** — `setBonusInfra` is owner-only and one-time; `setBonusSeries` reverts for a non-operator, reverts when `table.token != series.token`, reverts when `base + bonusPoints > MULT_MAX`, reverts when infra unset, and succeeds (emits, stores) for a valid series. Run → FAIL.
- [ ] **Step 2: Implement** the pointers + setters. Read series params via `bonusChips.seriesOf(seriesId)`. Enforce F-C.
- [ ] **Step 3:** tests PASS; `forge build` clean.
- [ ] **Step 4: Commit** — `git commit -m "feat(assets-s2b): bonus infra pointers + setBonusSeries (F-C token/clamp checks)"`

---

## Task 2: `openBoosted`

**Files:** modify `OperatorCoinFlip.sol`; tests in `OperatorCoinFlipBoosted.t.sol`.

**Interfaces:**
- Produces: `openBoosted(bytes32 tableId, uint8 side, uint256 stake, uint16 minEffMult, address[] subset, PreimageLocation.Info[] locations) → bytes32 roundId`; `Round` gains appended `seriesId`, `boostD`, `effMult`; `BoostApplied(roundId, seriesId, effMult, d)`.

- [ ] **Step 1: Write failing tests** — a valid `openBoosted` locks bet A (operator, `P_b`) and bet B (pool, `d`), pulls 1 charge into the game, decrements `earmark` by `w` and sets `hold = w-d` (assert via pool views), increments `tableLocked` by `x` (base only), and emits `BoostApplied`. Revert tests: no series set; `stake > maxStake`; `now >= expiry`; `eff <= base`; `eff < minEffMult`; `d == 0` (dust); operator short on base exposure (reverts `InsufficientBankroll`, pool + charge + fee untouched). Run → FAIL.
- [ ] **Step 2: Implement** `openBoosted` following the T2 CEI ordering EXACTLY (checks → effects → heat → pull charge → `pool.consume` → `lockExposure(B)` → `lockExposure(A)` last), `nonReentrant`. Compute `P_b`, `P_t`, `d = P_t - P_b`, `x = P_b - σ`, `eff = min(base+bp, MULT_MAX)`. Bet B id = `keccak256(roundId, "boost")`. Keep plain `open()` untouched.
- [ ] **Step 3:** tests PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(assets-s2b): openBoosted — paired bet-A/bet-B, charge pull, pool.consume (T2)"`

---

## Task 3: Boosted settle (win + lose)

**Files:** modify `OperatorCoinFlip.sol` `_settle`; tests.

- [ ] **Step 1: Write failing tests** — SETTLE-WIN: player receives `P_t` (both bets pay), pool `hold -r → credit[op] += r`, charge burned, `tableLocked -= x`, P1/P2 hold. SETTLE-LOSS: operator bankroll `+= P_b - ρ`, pool `bankroll += d` and `credit[op] += w`, charge burned, P1/P2 hold. Run → FAIL.
- [ ] **Step 2: Implement** — in `_settle`, branch on `round.seriesId != 0`: settle bet B alongside bet A (`settleWin(B)`/`settleLoss(B)`), call `pool.onSettleWin`/`onSettleLoss(roundId)`, then `bonusChips.burn(game, seriesId, 1)` LAST. Plain rounds unchanged.
- [ ] **Step 3:** tests PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(assets-s2b): boosted settle (paired bet B + pool hook + charge burn) (T3/T4)"`

---

## Task 4: Boosted refund paths + guard `claim`

**Files:** modify `OperatorCoinFlip.sol` `_routeForfeit`, `refundStale`, `claim`; tests.

- [ ] **Step 1: Write failing tests** — CHOP-REFUND (boosted): bet A + bet B refunded (d → pool), `pool.onChopRefund` (`credit[op] += w`), charge BURNED (not returned — F4), forfeit still routed to the neutral sink (Slice 0), player refunded stake, P1/P2 hold. PLAIN-TIMEOUT (boosted): bet A + bet B refunded, `pool.onPlainRefund` (`earmark += w`), charge RETURNED to player (and a contract-player receiver failure PARKS it via a `claimParkedCharge` path, refund still succeeds), P1/P2 hold. Also: `claim` is `nonReentrant`. Run → FAIL.
- [ ] **Step 2: Implement** — branch boosted in `_routeForfeit` (chop) and the `refundStale` plain branch: refund bet B, call the matching pool hook, burn (chop) or return-with-park (plain) the charge LAST. Keep the Slice 0 neutral-sink forfeit routing intact. Add `nonReentrant` to `claim`. Add `parkedCharge` + `claimParkedCharge` mirroring the `unrouted`/`sweepForfeit` pattern.
- [ ] **Step 3:** tests PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(assets-s2b): boosted refunds (chop burns charge, plain returns w/ park) + guard claim (T5/T6)"`

---

## Task 5: Full suite + end-to-end invariant + deployability

- [ ] **Step 1:** `forge test` full suite green — INCLUDING the unchanged plain `OperatorCoinFlip.t.sol` (regression: plain rounds byte-identical behavior) and the Slice 0 forfeit tests.
- [ ] **Step 2: End-to-end invariant test** — a randomized sequence of boosted + plain rounds through the REAL game/escrow/pool/chips, asserting after every terminal: P1 (`bankrollOf(pool) == Σ earmark + Σ hold + Σ credit`), P2 (`earmark == circ·w`), the escrow solvency (`bankroll+locked+rake == balance` per bucket), and `tableLocked` returns to 0 when no boosted round is open. This is the S2b deliverable — the paired-bet flow proven through the real game, not the S2a mock.
- [ ] **Step 3: Deployability** — shanghai override already covers the game; measure the new `OperatorCoinFlip` stripped size (must stay < 24576 after openBoosted + boosted branches; if tight, move series-resolution into a small helper) and re-run the MCOPY/TSTORE scan.
- [ ] **Step 4: Commit** — `git commit -m "test(assets-s2b): end-to-end paired-bet invariant through the real game; deployability green"`

---

## Deferred (owner-gated / later slices)

- S2c: mint-sale (vest-against-burns + expired-price refund, O4/MEDIUM-3) + marketplace + fee-policy wiring.
- S2d: operator-game player UI + bonus/boost UI + the deferred System 1 theming sourcing (`setMetadataURI`/`setTheme`).
- S2e: 943 redeploy (retire old game, keep heatsSince, re-authorize game+pool, set infra, deploy pool via ansible) + extended `qa-operator-coinflip.ts` reprove + bot soak. OWNER-GATED.
- Pre-369: independent full re-audit of the S2 fund stack.

## Self-Review

- **Accounting coverage:** T2 → Task 2; T3/T4 → Task 3; T5/T6 → Task 4; setBonusSeries F-C → Task 1; guard claim → Task 4; the P1/P2 end-to-end proof → Task 5.
- **Isolation of risk:** plain `open()` is untouched (regression-tested), so the change is additive; boosted paths reuse the S2a-verified pool via its hooks.
- **No placeholders:** ordering is pinned to the accounting §6 CEI; the one sizing contingency (helper extraction if EIP-170 tight) is called out.

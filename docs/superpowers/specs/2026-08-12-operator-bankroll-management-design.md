# Operator bankroll management — the "backroom" (part A) — design

Status: APPROVED shape (2026-08-12). Build on a branch, re-prove on 943 before 369.

Part A of the house "backroom": the operator's controls for running bankroll across their tables —
live top-up/withdraw, per-table exposure caps, and an ops CLI. Part B (the live "security-room"
observability dashboard) is a separate design that renders the read layer defined here.

## Problem

An operator funds one shared bankroll pool per (operator, token) in GameEscrow; every table they run
draws exposure from it. Today a single busy or losing table can tie up (or lose) the whole pool, and the
operator has no per-table risk control and no purpose-built tooling to top up, withdraw, or rebalance
while play continues. Operators want to cap risk per table, move that risk between tables cheaply, and do
it all without pausing.

## Goals

- **Per-table exposure cap:** an operator sets a maximum concurrent locked exposure per table; opens that
  would exceed it revert, without splitting custody.
- **Balancing across tables = adjusting caps:** cheap, no token transfers (custody stays one shared pool).
- **Live top-up / withdraw without pausing:** rely on and prove the existing escrow behavior (withdraw is
  bounded to the unlocked balance; deposits/withdrawals never pause in-flight rounds).
- **Operator ops tooling:** an off-chain CLI for deposit/withdraw, set-cap/rebalance, policy config, and a
  per-table status read.

## Non-goals (separate efforts)

- **Backroom-B — the security-room dashboard** (live UI watching every player/round). It consumes the read
  layer here; its own design.
- **True per-table sub-accounts / custody segregation** — explicitly rejected in favor of caps on a shared
  pool (simpler, smaller custody-model change, easier to re-prove). A losing table still draws shared
  custody up to its cap; the cap bounds concurrent exposure, not lifetime P&L segregation.
- No change to the forfeit/settle/chop mechanics or the validator-policy hook beyond decrementing the new
  per-table counter on the paths that already resolve a round.

## Design

### Per-table exposure cap (in the game, not the escrow)

The cap is a per-table risk policy, so it lives in OperatorCoinFlip and GameEscrow stays the generic
custody seam (same separation as the validator policy).

- New state: `mapping(bytes32 tableId => uint256) tableCap` (operator-set; **0 = unlimited**, backward
  compatible) and `mapping(bytes32 tableId => uint256) tableLocked` (running sum of open-round exposure on
  that table, where exposure = `payout - stake`).
- New op: `setTableCap(bytes32 tableId, uint256 cap) external onlyOperator(tableId)` + event
  `TableCapSet(tableId, cap)`. Lowering a cap below current `tableLocked` is allowed — it simply blocks new
  opens until exposure clears (it never claws back in-flight rounds).
- Error: `TableCapExceeded()`.
- In `open()`, after the shared-pool path computes `payout` and the dust check, before `lockExposure`:
  ```solidity
  uint256 exposure = payout - stake;
  uint256 cap = t.tableCap; // t is the Table storage ref
  if (cap != 0 && tableLocked[tableId] + exposure > cap) revert TableCapExceeded();
  tableLocked[tableId] += exposure;
  ```
  (A revert in the subsequent `lockExposure` unwinds this increment atomically.)
- Release the exposure on EVERY terminal transition, exactly once, via a helper:
  ```solidity
  function _releaseTableExposure(bytes32 tableId, uint256 payout, uint256 stake) internal {
      tableLocked[tableId] -= (payout - stake);
  }
  ```
  Call it in the three places a round becomes terminal — the same status-guarded transitions that already
  exist, so no double-decrement is possible:
  - `_settle` (→ Settled, win or loss),
  - `_routeForfeit` (→ Refunded, from chopAndRoute and the chopped branch of refundStale),
  - `refundStale`'s plain-timeout branch (→ Refunded).
  Each reads the round's stored `payout`/`stake`, so the exposure released always equals the exposure
  locked at open.

### Live top-up / withdraw (already in the escrow — verified, not rebuilt)

`GameEscrow.depositBankroll` and `withdrawBankroll` do not pause play; `withdrawBankroll` reverts if it
would drop `bankroll` below `locked` (the unlocked balance is `bankroll - locked`). Backroom-A adds no
mechanic here — it depends on this and tests it: top up during an open round; withdraw down to exactly the
locked floor; a withdraw past the floor reverts; play continues throughout.

### Balancing across tables

Because custody is one shared pool, moving risk between tables is `setTableCap` only — raise the busy
table's cap, lower a quiet one's. No `moveBankroll`, no transfers. The ops CLI wraps this as `rebalance`.

### Operator ops tooling (off-chain CLI)

`games/e2e/scripts/operator-ops.ts` — same conventions as qa/redeploy scripts (secrets via `op`, valve
RPC, RPC-retry, reads addresses from the substrate json). Commands (via `CMD=` env or argv):
- `deposit <amount>` / `withdraw <amount>` — escrow bankroll; `withdraw` first prints bankroll / locked /
  unlocked and refuses an amount above unlocked.
- `set-cap <tableId> <amount>` and `rebalance <tableId>=<amount> ...` — set one or many table caps in a run.
- `set-policy <tableId> <policyAddr>` and `set-config <tableId> <minCount> <requireOperator> <wl...>` — wraps
  `setValidatorPolicy` + `DefaultValidatorPolicy.setConfig` (ties in the validator-policy feature).
- `status [tableId]` — the per-table read: token, cap, tableLocked, available headroom (`min(cap-locked,
  bankroll-locked)` or just `bankroll-locked` when uncapped), open-round count, current validator policy.
  This read layer is what backroom-B will render.

The CLI only calls existing/new operator-only entrypoints; it holds no special authority beyond the
operator key.

## Fund-safety invariants (to hold after the change)

1. `tableLocked[table]` is incremented by exactly `exposure` once per successful `open()` and decremented by
   exactly `exposure` once per terminal transition of that round — so it can never drift from the true sum
   of open-round exposure on the table. (Test: multi-round open/settle/forfeit/refund sequences leave
   `tableLocked` back at 0.)
2. The cap only ADDS a constraint on `open()`; it never affects settlement, forfeit routing, custody, the
   shared-pool bankroll check, or another table. A cap of 0 is a no-op (uncapped).
3. Lowering a cap cannot brick or claw back in-flight rounds — it only gates new opens; existing rounds
   resolve normally and free their exposure.
4. Withdraw remains bounded to the unlocked balance (escrow, unchanged) — no path lets an operator pull
   funds backing an in-flight round.
5. The ops CLI has no authority beyond the operator key; every state change goes through an operator-only
   on-chain function.

## Re-prove-on-943 plan (the airtight bar)

- **Foundry** (OperatorCoinFlip.t.sol): open blocked at the cap (`TableCapExceeded`); exposure frees as
  rounds settle/lose/forfeit/refund and a later open then succeeds; `cap==0` unlimited; `setTableCap`
  operator-only; lowering the cap below `tableLocked` blocks new opens but resolves in-flight; `tableLocked`
  returns to 0 across a mixed settle/forfeit/refund sequence; the cap decrement happens exactly once on the
  forfeit path (no double-decrement with `_routeForfeit`).
- **Escrow tests**: deposit mid-round; withdraw to the locked floor; over-floor withdraw reverts.
- **Anvil vs real Random**: unaffected (cap is pre-lock gating); add a capped-table settle+forfeit pass.
- **Deployability guard**: OperatorCoinFlip MCOPY/TSTORE-free, under size (watch the +growth from the two
  mappings + helper).
- **Live 943**: redeploy; `operator-ops.ts status` shows correct per-table numbers; a capped table rejects
  an over-cap open and accepts within cap; forfeit proof still green.
- **Reviews**: fund-safety review focused on the `tableLocked` counter (desync → brick or over-draw?) and
  the withdraw/unlocked invariant.

## Open sub-decisions (small, non-blocking)

- `status` "available headroom" formula when uncapped: report `bankroll - locked` (recommended).
- Whether `rebalance` should also allow a paired deposit in the same run (recommended: keep `rebalance`
  caps-only; `deposit` is its own command) to keep each command single-purpose.

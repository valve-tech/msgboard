# Operator Bankroll Management (backroom-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an operator per-table exposure caps on their shared bankroll pool, verified no-pause top-up/withdraw, and an ops CLI — then re-prove airtight on 943.

**Architecture:** The cap is a per-table risk policy enforced in the game (OperatorCoinFlip); GameEscrow stays the generic shared-pool custody seam. The game tracks `tableLocked[table]` (running sum of open-round exposure) against an operator-set `tableCap[table]`, incrementing once at open and decrementing once on each terminal transition. Live top-up/withdraw already exist in the escrow (withdraw bounded to the unlocked balance); we verify and test them. An off-chain CLI wraps the operator-only entrypoints.

**Tech Stack:** Solidity 0.8.25 (via_ir, evm_version=shanghai), Foundry for unit tests, viem/tsx for the CLI + QA, hardhat artifacts for the e2e path.

**Spec:** docs/superpowers/specs/2026-08-12-operator-bankroll-management-design.md

## Global Constraints

- solc 0.8.25, via_ir, `evm_version = shanghai` — no MCOPY/TSTORE/Cancun opcodes; deployability guard stays green (runtime < 24576B, mcopy=tstore=tload=0).
- The cap lives in the game; GameEscrow is NOT made table-aware. Custody stays one shared pool per (operator, token).
- `tableCap == 0` means unlimited (backward compatible). Exceeding a cap reverts `TableCapExceeded`.
- `tableLocked[table]` is incremented by exactly `payout - stake` once per successful open and decremented by exactly that once per terminal transition (`_settle`, `_routeForfeit`, `refundStale` plain branch) — it must never drift.
- The cap only gates `open()`; it never touches settle/forfeit/custody/another table. Lowering a cap never claws back in-flight rounds.
- Withdraw stays bounded to the unlocked balance (escrow, unchanged) — no pulling funds backing an in-flight round.
- Reuse the hardened 943 substrate (registry/escrow/bond/vault); only the game changes.

---

### Task 1: Per-table exposure caps in OperatorCoinFlip

**Files:**
- Modify: `games/contracts/contracts/games/operator/OperatorCoinFlip.sol`
- Test: `games/contracts/test/foundry/OperatorCoinFlip.t.sol`

**Interfaces:**
- Consumes: existing `onlyOperator(tableId)`, `open()`, `_settle`, `_routeForfeit`, `refundStale`, `Round{payout,stake,tableId}`.
- Produces:
  - `mapping(bytes32 => uint256) public tableCap`
  - `mapping(bytes32 => uint256) public tableLocked`
  - `setTableCap(bytes32 tableId, uint256 cap) external onlyOperator(tableId)`
  - event `TableCapSet(bytes32 indexed tableId, uint256 cap)`
  - error `TableCapExceeded()`

- [ ] **Step 1: Write the failing tests** (append to OperatorCoinFlip.t.sol)

```solidity
function test_setTableCap_onlyOperator() public {
    bytes32 tid = _table();
    vm.prank(address(0xBAD));
    vm.expectRevert(OperatorCoinFlip.NotOperator.selector);
    game.setTableCap(tid, 5 ether);
    vm.prank(op); game.setTableCap(tid, 5 ether);
    assertEq(game.tableCap(tid), 5 ether);
}

function test_tableCap_blocksOverExposure_and_tracksLocked() public {
    bytes32 tid = _table();
    uint256 exposure = 4 ether * MULT / 100 - 4 ether; // payout - stake for a 4e18 stake
    vm.prank(op); game.setTableCap(tid, exposure); // room for exactly one such round
    ( , , PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether); // fills the cap
    locs; // silence unused
    assertEq(game.tableLocked(tid), exposure);
    // a second open would push tableLocked to 2*exposure > cap → revert
    vm.prank(player);
    vm.expectRevert(OperatorCoinFlip.TableCapExceeded.selector);
    game.open(tid, 0, 4 ether, subset, _locsAt(game.tierPriceOf(tid, 4 ether)));
}

function test_tableCap_freesOnSettle() public {
    bytes32 tid = _table();
    uint256 exposure = 4 ether * MULT / 100 - 4 ether;
    vm.prank(op); game.setTableCap(tid, exposure);
    (, bytes32 key,) = _open(tid, 0, 4 ether);
    rnd.pushCast(key, bytes32(uint256(0))); // settle → releases exposure
    assertEq(game.tableLocked(tid), 0);
    (bytes32 r2,,) = _open(tid, 0, 4 ether); // now fits again
    assertEq(_status(r2), uint8(OperatorCoinFlip.Status.Pending));
}

function test_tableCap_zeroIsUnlimited() public {
    bytes32 tid = _table(); // default cap 0
    for (uint256 i = 0; i < 3; i++) _open(tid, 0, 4 ether); // many rounds, no cap revert
    assertEq(game.tableLocked(tid), 3 * (4 ether * MULT / 100 - 4 ether));
}

function test_tableCap_freesOnForfeit_onceOnly() public {
    bytes32 tid = _table();
    uint256 exposure = 4 ether * MULT / 100 - 4 ether;
    vm.prank(op); game.setTableCap(tid, exposure);
    (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
    rnd.setRevealed(key, 0x3);
    game.chopAndRoute(roundId, locs); // forfeit path → releases exposure exactly once
    assertEq(game.tableLocked(tid), 0);
    // a fresh open fits again (proves it wasn't double-decremented into underflow-revert or left stuck)
    (bytes32 r2,,) = _open(tid, 0, 4 ether);
    assertEq(_status(r2), uint8(OperatorCoinFlip.Status.Pending));
}

function test_tableCap_freesOnRefundStale() public {
    bytes32 tid = _table();
    uint256 exposure = 4 ether * MULT / 100 - 4 ether;
    vm.prank(op); game.setTableCap(tid, exposure);
    (bytes32 roundId,,) = _open(tid, 0, 4 ether);
    vm.roll(block.number + 201); // past STALE_BLOCKS, no chop → plain refund branch
    game.refundStale(roundId);
    assertEq(game.tableLocked(tid), 0);
}

function test_lowerCap_blocksNewButResolvesInflight() public {
    bytes32 tid = _table();
    (bytes32 roundId, bytes32 key,) = _open(tid, 0, 4 ether); // uncapped open
    vm.prank(op); game.setTableCap(tid, 1); // now below tableLocked
    vm.prank(player);
    vm.expectRevert(OperatorCoinFlip.TableCapExceeded.selector);
    game.open(tid, 0, 4 ether, subset, _locsAt(game.tierPriceOf(tid, 4 ether)));
    rnd.pushCast(key, bytes32(uint256(0))); // in-flight round still settles
    assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Settled));
    assertEq(game.tableLocked(tid), 0);
}
```

- [ ] **Step 2: Run to verify fail** — `cd games/contracts && forge test --match-contract OperatorCoinFlip` → FAIL (tableCap/tableLocked/setTableCap/TableCapExceeded missing).

- [ ] **Step 3: Implement in OperatorCoinFlip.sol**

Add error + event + state:
```solidity
error TableCapExceeded();
```
```solidity
event TableCapSet(bytes32 indexed tableId, uint256 cap);
```
```solidity
mapping(bytes32 tableId => uint256) public tableCap;    // max concurrent locked exposure; 0 = unlimited
mapping(bytes32 tableId => uint256) public tableLocked; // running sum of open-round exposure on the table
```
Add the setter (near setOpen/setValidatorPolicy):
```solidity
function setTableCap(bytes32 tableId, uint256 cap) external onlyOperator(tableId) {
    tableCap[tableId] = cap;
    emit TableCapSet(tableId, cap);
}
```
In `open()`, after `uint256 payout = stake * t.maxMultiplierX100 / 100;` and the `DustStake` check, before `_chargeFee`/heat/lockExposure:
```solidity
uint256 exposure = payout - stake;
uint256 cap = t.tableCap;
if (cap != 0 && tableLocked[tableId] + exposure > cap) revert TableCapExceeded();
tableLocked[tableId] += exposure;
```
Add the release helper:
```solidity
function _releaseTableExposure(bytes32 tableId, uint256 payout, uint256 stake) internal {
    tableLocked[tableId] -= (payout - stake);
}
```
Call it on each terminal transition:
- in `_settle`, right after `r.status = Status.Settled;`:
  `_releaseTableExposure(r.tableId, r.payout, r.stake);`
- in `_routeForfeit`, right after `r.status = Status.Refunded;`:
  `_releaseTableExposure(r.tableId, r.payout, r.stake);`
- in `refundStale`'s plain-timeout branch (the one that sets `r.status = Status.Refunded;` directly, NOT the `_routeForfeit` branch), right after that assignment:
  `_releaseTableExposure(r.tableId, r.payout, r.stake);`

- [ ] **Step 4: Run to verify pass** — `forge test --match-contract "OperatorCoinFlip|MockRandomStaking|DefaultValidatorPolicy"` → all PASS (prior 35 + 7 new).

- [ ] **Step 5: Deployability guard** — hardhat compile + the scan one-liner for OperatorCoinFlip.json: mcopy=tstore=tload=0, size < 24576.

- [ ] **Step 6: Commit**

```bash
git add games/contracts/contracts/games/operator/OperatorCoinFlip.sol games/contracts/test/foundry/OperatorCoinFlip.t.sol
git commit -m "feat(operator): per-table exposure caps on the shared bankroll pool"
```

---

### Task 2: Verify no-pause top-up / withdraw (escrow behavior tests)

**Files:**
- Test: `games/contracts/test/foundry/GameEscrow.t.sol`

**Interfaces:**
- Consumes: existing `GameEscrow.depositBankroll(operator, token, amount)`, `withdrawBankroll(token, amount)` (msg.sender = operator), `bankrollOf`, `lockedOf`, and the escrow's lock path (via an authorized game or the test's existing setup).

- [ ] **Step 1: Write tests** confirming the unlocked-balance invariant (adapt to GameEscrow.t.sol's existing setUp — it already deploys the escrow and an authorized game/operator; reuse those handles). The three behaviors:

```solidity
// with an operator funded and one round's exposure locked (reuse the file's lock helper / authorized game):
// 1. deposit succeeds while a round is locked (no pause)
// 2. withdraw of (bankroll - locked) succeeds; bankroll drops to exactly locked
// 3. withdraw of (bankroll - locked + 1) reverts (cannot pull locked funds)
function test_withdraw_boundedToUnlocked_whileRoundLocked() public {
    // arrange: operator bankroll B, lock exposure E on a round (use the existing helper in this file)
    // uint256 unlocked = esc.bankrollOf(op, token) - esc.lockedOf(op, token);
    // vm.prank(op); esc.depositBankroll(op, token, 1 ether); // no-pause top-up works
    // vm.prank(op); esc.withdrawBankroll(token, unlocked + 1 ether); // down to the locked floor
    // assertEq(esc.bankrollOf(op, token), esc.lockedOf(op, token));
    // vm.prank(op); vm.expectRevert(); esc.withdrawBankroll(token, 1); // past the floor reverts
}
```
Fill the arrange section using the concrete helpers already in GameEscrow.t.sol (read the file's setUp + any `_lock`/authorized-game helper and mirror the existing tests' style). If the file has no lock helper, lock via the authorized game's `lockExposure` exactly as the other tests in the file do.

- [ ] **Step 2: Run** — `forge test --match-contract GameEscrow` → PASS.

- [ ] **Step 3: Commit**

```bash
git add games/contracts/test/foundry/GameEscrow.t.sol
git commit -m "test(operator): escrow top-up/withdraw are no-pause and bounded to the unlocked balance"
```

---

### Task 3: Operator ops CLI (operator-ops.ts)

**Files:**
- Create: `games/e2e/scripts/operator-ops.ts`

**Interfaces:**
- Consumes: OperatorCoinFlip (`setTableCap`, `tableCap`, `tableLocked`, `setValidatorPolicy`, `tables`, `operatorOf`), GameEscrow (`depositBankroll`, `withdrawBankroll`, `bankrollOf`, `lockedOf`), DefaultValidatorPolicy (`setConfig`, `configOf`) — addresses from `contracts/deployments/943-operator-substrate.json`.

- [ ] **Step 1: Implement the CLI** — mirror qa-operator-coinflip.ts conventions: `PRIVATE_KEY` (operator) via `op`, `RPC_URL` (valve RPC), a `send` wrapper with transient-RPC retry, addresses from the substrate json + Chips from CoinFlipTables. Dispatch on `CMD` env (or argv[2]):
  - `deposit <amount>` → approve escrow + `depositBankroll(operator, CHIPS, amount)`.
  - `withdraw <amount>` → print `bankrollOf` / `lockedOf` / unlocked; if `amount > unlocked` refuse with a clear message; else `withdrawBankroll(CHIPS, amount)`.
  - `set-cap <tableId> <amount>` → `setTableCap`.
  - `rebalance <tableId>=<amount> [<tableId>=<amount> ...]` → one `setTableCap` per pair.
  - `set-policy <tableId> <policyAddr>` → `setValidatorPolicy`.
  - `set-config <tableId> <minCount> <requireOperator:true|false> <wl0> <wl1> ...` → `DefaultValidatorPolicy.setConfig(GAME, tableId, minCount, requireOperator, [wl...])`.
  - `status [tableId]` → for each table (or the given one): token, `tableCap`, `tableLocked`, available = uncapped ? `bankrollOf-lockedOf` : `min(cap-tableLocked, bankrollOf-lockedOf)`, and the table's `validatorPolicy`. (Enumerate tables via the `operatorTables` helper in actor-common if present; else accept an explicit tableId.)
  Keep each command single-purpose; `rebalance` adjusts caps only (deposits are their own command).

- [ ] **Step 2: Typecheck** — `cd games/e2e && npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 3: Read-only smoke** (safe; no writes) — `CMD=status PRIVATE_KEY=<op> RPC_URL=<valve 943> npx tsx scripts/operator-ops.ts` prints the per-table view without error.

- [ ] **Step 4: Commit**

```bash
git add games/e2e/scripts/operator-ops.ts
git commit -m "feat(operator): operator-ops CLI — bankroll deposit/withdraw, table caps/rebalance, policy, status"
```

---

### Task 4: QA cap cases + review + live 943 redeploy + re-prove

**Files:**
- Modify: `games/e2e/scripts/qa-operator-coinflip.ts`
- Deployment JSONs (943), SDD ledger.

- [ ] **Step 1:** Add a `caps` mode to qa-operator-coinflip.ts (folded into `all`): create a table, `setTableCap(tid, exposure)` for one round's exposure, `openRound` once (fills the cap), then `expectRevert` a second `open` with `TableCapExceeded`; settle or refund the first and confirm a later open succeeds (or simply assert `tableLocked` via a read). Reuse the run's self-contained ink/cast helpers; keep it valve-RPC + retry.

- [ ] **Step 2: Fund-safety review** (subagent, opus) focused on the `tableLocked` counter: can it desync from real exposure (increment/decrement asymmetry across settle/forfeit/refund/claim), underflow (double-decrement) to brick a table, or be bypassed to over-draw the shared pool? Confirm the cap gates open() only and the forfeit/policy airtightness is preserved. Fix any finding + re-review.

- [ ] **Step 3: Redeploy** the capped OperatorCoinFlip (+ existing DefaultValidatorPolicy) to 943 via `redeploy-operator-coinflip.ts` (valve RPC, DEPLOY_EXECUTE=1). Read-back wiring + both config files synced + prior game retired.

- [ ] **Step 4: Live proof** — `qa-operator-coinflip.ts MODE=all` on 943: expect the full forfeit + policy checks PLUS the cap checks (over-cap open reverts TableCapExceeded, within-cap opens, tableLocked frees on resolve). Also run `operator-ops.ts status` and confirm the numbers.

- [ ] **Step 5: Record + commit** — update the memory note + SDD ledger with the new 943 addresses and the cap proof.

```bash
git add games/e2e/scripts/qa-operator-coinflip.ts games/contracts/deployments/943-operator-substrate.json games/e2e/scripts/943-deployment.json
git commit -m "chore(operator): redeploy capped OperatorCoinFlip to 943 + live cap proof"
```

---

## Self-Review

**Spec coverage:** per-table cap in the game (Task 1: state, setTableCap, open() check, `_releaseTableExposure` on all three terminal paths); cap==0 unlimited + TableCapExceeded (Task 1 tests); balancing = setTableCap (Task 3 `rebalance`); no-pause top-up/withdraw verified (Task 2); ops CLI incl. status read layer (Task 3); re-prove on 943 (Task 4). Non-goals (sub-accounts, security-room UI) correctly absent. ✓

**Placeholder scan:** Task 2's arrange block is intentionally adapted-to-file because GameEscrow.t.sol's existing setUp/lock helpers must be reused rather than reinvented — the three assertions (deposit-while-locked, withdraw-to-floor, over-floor-reverts) are concrete; the implementer wires them with the file's own helpers. All other steps carry real code. ✓

**Type consistency:** `tableCap`/`tableLocked` public mappings → auto getters `tableCap(bytes32)`/`tableLocked(bytes32)` used in tests; `setTableCap(bytes32,uint256)` / `TableCapExceeded` / `TableCapSet` consistent across Task 1 and the CLI (Task 3). `_releaseTableExposure(bytes32,uint256,uint256)` defined and called with `(r.tableId, r.payout, r.stake)` at all three sites. exposure = `payout - stake` identical at increment (open) and decrement (helper). ✓

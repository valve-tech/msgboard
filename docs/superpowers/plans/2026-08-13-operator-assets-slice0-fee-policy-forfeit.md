# Operator Assets — Slice 0: pluggable fee policy + neutral-sink forfeit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a pluggable `IFeePolicy` seam and re-route the validator forfeit from the operator's own bankroll to a neutral sink (burn) through it — closing the operator-run-validator win-denial hole (369 gate, task #42) and laying the fee rails System 2 reuses.

**Architecture:** A minimal view-first fee-policy interface; a `BurnFeePolicy` default sink; an owner-set forfeit-policy pointer on `OperatorCoinFlip` restricted to a constructor-fixed immutable menu; `_routeForfeit` rewritten to refund the player first, then hand the FULL measured forfeit to the policy inside a try/catch that parks on failure (never freezes the refund). `GameEscrow` is untouched.

**Tech Stack:** Solidity 0.8.25 (evm shanghai, no MCOPY/TSTORE), Foundry, viem/tsx e2e.

**Spec:** `docs/superpowers/specs/2026-08-13-operator-assets-program-design.md` (§4 is Slice 0).

## Global Constraints

- `GameEscrow` is NOT modified (program invariant I1). Only `OperatorCoinFlip` + two new small contracts change.
- The forfeit call site routes the **FULL** forfeit amount via `route()` and does NOT call `feeBps` (H2). The `feeBps ≤ 1000` clamp governs only the later mint-sale/marketplace percentage cuts, not this slice.
- Refund the player BEFORE routing the forfeit; wrap the transfer+route in a try/catch that parks on failure (M1/M2). A bad or griefing policy can never freeze a chopped round's refund.
- Route the MEASURED amount received from `handoff` (balance delta), not the nominal `forfeit` (M3, fee-on-transfer safety) — mirrors the existing `_pullVerified` idiom.
- Forfeit sink is game-owner-set, never operator-set, and only from an immutable constructor-fixed menu (I5). It defaults to a `BurnFeePolicy` so it is never unset/brickable.
- Custody invariant unchanged: `Random.balanceOf(game, token) == Σ feeBalance[op][token]`. The re-route changes only the post-`handoff` destination of the forfeit; the fee restore to the operator stays.
- Pre-Cancun deployability (I7): solc 0.8.25 / `evmVersion: shanghai` per-file override on every new contract; verify no MCOPY/TSTORE on STRIPPED bytecode (CBOR trailer gives false MCOPY hits); EIP-170 < 24576 (OperatorCoinFlip has ~14KB headroom).
- Deploy discipline for Task 5 (from memory): new game address → retire old into `operatorCoinFlipRetired`; keep `heatsSince`; re-`authorizeGame`/`setPlayerGame`; ansible runbook; valve RPC (public 943 RPC quotes bogus 10000-gwei gas); check `op` session first (expired session hangs deploys silently).

## Deploy-bundling note

Slice 0 changes `OperatorCoinFlip`, which forces a game redeploy. System 2 also redeploys the game (openBoosted + setTheme). To avoid two redeploy cycles, Task 5's live-943 redeploy MAY be bundled with System 2's — Slice 0's code is fully built and Foundry/anvil-proven on its own regardless. Tasks 1–4 are self-contained and land now; Task 5's live deploy is owner-gated and may wait for the System 2 bundle.

---

## File Structure

- `games/contracts/contracts/games/operator/IFeePolicy.sol` (create) — the seam.
- `games/contracts/contracts/games/operator/BurnFeePolicy.sol` (create) — default sink (burns; counts burned per token for QA).
- `games/contracts/contracts/games/operator/OperatorCoinFlip.sol` (modify) — menu + pointer + `setForfeitPolicy` + `_routeForfeit` rewrite + `unrouted`/`sweepForfeit` + `ForfeitParked`.
- `games/contracts/test/foundry/OperatorCoinFlip.t.sol` (modify) — invert 4 forfeit→bankroll asserts; add park + sweep + tier-boundary tests.
- `games/contracts/test/foundry/FeePolicy.t.sol` (create) — BurnFeePolicy unit tests.
- `games/e2e/scripts/qa-operator-coinflip.ts`, `games/e2e/test/operator-forfeit.test.ts`, `games/e2e/scripts/qa-operator-chop.ts` (modify) — invert the forfeit→bankroll assertions (H1); assert sink credited.
- `games/contracts/scripts/redeploy-operator-coinflip.ts` (modify, Task 5) — deploy BurnFeePolicy + pass the menu to the game constructor; sync deployment JSON.

---

## Task 1: `IFeePolicy` + `BurnFeePolicy`

**Files:** create `IFeePolicy.sol`, `BurnFeePolicy.sol`, `test/foundry/FeePolicy.t.sol`.

**Interfaces:**
- Produces: `IFeePolicy` (below); `BurnFeePolicy` (implements it, has `mapping(address=>uint256) public burned`).

- [ ] **Step 1: Write `IFeePolicy.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Pluggable fee-routing seam. A fee-producing contract transfers the fee tokens to the policy
/// and then calls `route`, which sends them to their destination (burn / buyback / recipient). `kind`
/// distinguishes call sites so one policy can price each differently; `feeBps` is read by percentage-cut
/// call sites (mint-sale/marketplace) BEFORE transferring — the forfeit call site skips it and routes
/// the full amount. A policy MUST NOT forward to any address named in `context` as a round participant.
interface IFeePolicy {
    function feeBps(bytes32 kind, address token, address payer) external view returns (uint16 bps);
    function route(bytes32 kind, address token, uint256 amount, bytes calldata context) external;
}
```

- [ ] **Step 2: Write the failing test `FeePolicy.t.sol`** — a mock ERC20, deploy `BurnFeePolicy`, transfer 5e18 to it, call `route(FORFEIT_KIND, token, 5e18, "")`, assert the tokens left the policy to the dead address (or were burned) and `burned[token] == 5e18`. Also assert `feeBps` returns 0 for the forfeit kind. Run: `forge test --mp test/foundry/FeePolicy.t.sol` → FAIL (BurnFeePolicy absent).

- [ ] **Step 3: Write `BurnFeePolicy.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {IFeePolicy} from "./IFeePolicy.sol";

/// @notice The default neutral sink: burns everything routed to it. Never a round participant, so it is
/// a safe forfeit destination. `feeBps` is 0 (the forfeit site routes the full amount and ignores it).
contract BurnFeePolicy is IFeePolicy {
    using SafeTransferLib for address;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    mapping(address token => uint256) public burned; // QA/observability: total burned per token

    function feeBps(bytes32, address, address) external pure returns (uint16) { return 0; }

    /// @notice Burn `amount` of `token` already delivered to this contract. Tries a token `burn(uint256)`
    /// first; falls back to a dead-address transfer for tokens without one. Reverts if neither works, so
    /// the caller's try/catch parks the amount rather than losing it.
    function route(bytes32, address token, uint256 amount, bytes calldata) external {
        burned[token] += amount;
        // Prefer a real burn; fall back to the dead address. (Both handled by SafeTransferLib patterns;
        // the implementer picks the exact approach and documents which tokens each path suits.)
        token.safeTransfer(DEAD, amount);
    }
}
```

Note: some tokens block transfers to `DEAD` or lack `burn`; per the spec that is a per-token concern and the caller parks on revert. Keep `route` simple and reverting-on-failure so the game's try/catch handles it.

- [ ] **Step 4: Run tests** — `forge test --mp test/foundry/FeePolicy.t.sol` → PASS.
- [ ] **Step 5: Commit** — `git add games/contracts/contracts/games/operator/IFeePolicy.sol games/contracts/contracts/games/operator/BurnFeePolicy.sol games/contracts/test/foundry/FeePolicy.t.sol && git commit -m "feat(assets-s0): IFeePolicy seam + BurnFeePolicy neutral sink"`

---

## Task 2: `OperatorCoinFlip` — neutral-sink forfeit re-route

**Files:** modify `OperatorCoinFlip.sol` and `test/foundry/OperatorCoinFlip.t.sol`.

**Interfaces:**
- Consumes: `IFeePolicy` (Task 1).
- Produces: `forfeitPolicy` (view), `setForfeitPolicy(address)` (onlyOwner), `unrouted(address)` (view), `sweepForfeit(address)` (permissionless, nonReentrant), event `ForfeitParked(bytes32 roundId, address token, uint256 amount)`. `ForfeitRouted`'s 4th arg now means "amount routed to the neutral sink" (0 if parked) — same shape, new meaning (L5).

- [ ] **Step 1: Add state, constructor menu, and the setter**

Add near the imports: `import {IFeePolicy} from "./IFeePolicy.sol";`. Add:

```solidity
bytes32 internal constant FORFEIT_KIND = keccak256("forfeit");

address public forfeitPolicy;                       // owner-set; from the immutable menu; defaults to a BurnFeePolicy
mapping(address policy => bool) public allowedFeePolicy; // constructor-fixed menu; NO setter (I5)
mapping(address token => uint256) public unrouted;  // forfeit parked when the policy failed; swept later

event ForfeitParked(bytes32 indexed roundId, address indexed token, uint256 amount);
event ForfeitPolicySet(address indexed policy);
```

Change the constructor to seed the menu and the default policy (the menu is immutable — populated once, no adder):

```solidity
constructor(address random_, address escrow_, address registry_, address[] memory feePolicyMenu_, address forfeitPolicy_)
    GameBase(random_)
{
    escrow = escrow_;
    registry = registry_;
    for (uint256 i = 0; i < feePolicyMenu_.length; ++i) allowedFeePolicy[feePolicyMenu_[i]] = true;
    if (!allowedFeePolicy[forfeitPolicy_]) revert PolicyRejected(); // default must be on the menu
    forfeitPolicy = forfeitPolicy_;
}
```

Add the setter (use GameBase's owner gate — confirm the exact modifier/owner accessor in `GameBase.sol`; the validator functions are owner-gated, reuse that mechanism):

```solidity
/// @notice Switch the active forfeit sink. Immediate (a recovery lever if a policy goes bad), but only
/// to a menu member — an operator can never set this, and it can never point off the fixed menu.
function setForfeitPolicy(address policy) external /* onlyOwner */ {
    if (!allowedFeePolicy[policy]) revert PolicyRejected();
    forfeitPolicy = policy;
    emit ForfeitPolicySet(policy);
}
```

- [ ] **Step 2: Write the failing tests first** (in `OperatorCoinFlip.t.sol`) — before changing `_routeForfeit`. Update `setUp` to deploy a `BurnFeePolicy`, pass `[burn]` as the menu and `burn` as the default to the `OperatorCoinFlip` constructor. Then:
  - Invert the three forfeit asserts at ~L280/L309/L328 and the policy-attached one at ~L477: assert `esc.bankrollOf(op, tok)` is **unchanged** by the forfeit, and `burnPolicy.burned(tok)` increased by `tierPrice`.
  - New `test_forfeit_parks_when_policy_reverts`: deploy a `RevertingFeePolicy` (a tiny test contract whose `route` reverts), add it to the menu (pass it in the constructor menu for this test's game instance), `setForfeitPolicy(reverting)`, drive a chopped round, assert: the player refund SUCCEEDED, the round is `Refunded`, `unrouted(tok) == tierPrice`, `ForfeitParked` emitted, operator bankroll unchanged.
  - New `test_sweepForfeit_routes_parked`: after the park above, `setForfeitPolicy(burn)`, call `sweepForfeit(tok)`, assert `unrouted(tok) == 0` and `burned(tok)` increased by `tierPrice`.
  - New `test_forfeit_tier_boundary` (F4 groundwork): stake `== minStake` so `tierPrice == stake`; drive a chopped round; assert the forfeit routed to the sink equals `tierPrice` and operator bankroll unchanged.
  - KEEP unchanged: the custody-invariant test (~L406) and the tableCap forfeit tests (~L521-532) — exposure release is unchanged.

Run: `forge test --mp test/foundry/OperatorCoinFlip.t.sol` → FAIL (old `_routeForfeit` still credits bankroll).

- [ ] **Step 3: Rewrite `_routeForfeit`** (currently deposits the forfeit into the operator bankroll). New body — refund first, measured handoff, full-amount route, try/catch-park:

```solidity
function _routeForfeit(bytes32 roundId) internal {
    Round storage r = rounds[roundId];
    Table storage t = tables[r.tableId];
    address token = t.token;
    address operator = t.operator;

    uint256 fee = r.feeCharged;
    uint256 forfeit = r.chopCredit - fee;

    // Effects.
    r.status = Status.Refunded;
    _releaseTableExposure(r.tableId, r.payout, r.stake);
    feeBalance[operator][token] += fee; // operator's fee is restored exactly as before

    // Interactions — refund the player FIRST; the sink route must never gate the refund (M1).
    GameEscrow(escrow).refund(roundId);
    emit RoundRefunded(roundId, r.tableId, r.player, r.stake);

    uint256 routed;
    if (forfeit > 0) {
        uint256 pre = token.balanceOf(address(this));
        IRandomStaking(random).handoff(address(this), token, int256(forfeit));
        uint256 measured = token.balanceOf(address(this)) - pre; // fee-on-transfer safe (M3)
        routed = _routeForfeitToSink(roundId, operator, r.player, token, measured);
    }
    emit ForfeitRouted(roundId, operator, token, routed); // 4th arg = amount to the neutral sink (0 if parked)
}

/// @notice Deliver the full forfeit to the neutral sink; park it on any failure so a bad policy cannot
/// freeze the abort. Returns the amount routed (0 if parked). The transfer + route are wrapped in one
/// external self-call so a route() revert rolls the transfer back and we park cleanly.
function _routeForfeitToSink(bytes32 roundId, address operator, address player, address token, uint256 amount)
    internal returns (uint256 routed)
{
    if (amount == 0) return 0;
    bytes memory ctx = abi.encode(roundId, operator, player); // I5: policy can self-check non-participant
    try this._deliverAndRoute(forfeitPolicy, token, amount, ctx) {
        return amount;
    } catch {
        unrouted[token] += amount;
        emit ForfeitParked(roundId, token, amount);
        return 0;
    }
}

/// @notice External-self-only: transfer `amount` to the policy then call route(), atomically, so the
/// caller's try/catch can roll both back together. Full amount — never a bps cut (H2).
function _deliverAndRoute(address policy, address token, uint256 amount, bytes calldata ctx) external {
    if (msg.sender != address(this)) revert NotOperator(); // self-only (reuse an existing error)
    token.safeTransfer(policy, amount);
    IFeePolicy(policy).route(FORFEIT_KIND, token, amount, ctx);
}
```

Add `sweepForfeit`:

```solidity
/// @notice Permissionless retry of parked forfeits (after the owner swapped a bad policy). Exactly-once:
/// zero the ledger before the external route, park it back on failure.
function sweepForfeit(address token) external nonReentrant {
    uint256 amount = unrouted[token];
    if (amount == 0) return;
    unrouted[token] = 0;
    try this._deliverAndRoute(forfeitPolicy, token, amount, abi.encode(bytes32(0), address(0), address(0))) {
        // routed
    } catch {
        unrouted[token] = amount; // restore; still parked
    }
}
```

Note for the implementer: confirm `token.balanceOf` is available via the imported `SafeTransferLib` or add a minimal IERC20 balanceOf; `chopAndRoute` and `refundStale`'s chopped branch already call `_routeForfeit`, so no other call site changes. Remove the old `handoff`+`safeApproveWithRetry`+`depositBankroll` lines entirely.

- [ ] **Step 4: Run tests** — `forge test --mp test/foundry/OperatorCoinFlip.t.sol` → PASS (all inverted + new tests green, custody-invariant + cap tests still green).
- [ ] **Step 5: Commit** — `git commit -am "feat(assets-s0): route validator forfeit to the neutral sink (refund-first, park-on-fail); closes the operator-validator denial hole"`

---

## Task 3: Invert the e2e / QA forfeit assertions (H1 — all surfaces)

**Files:** modify `games/e2e/scripts/qa-operator-coinflip.ts`, `games/e2e/test/operator-forfeit.test.ts`, `games/e2e/scripts/qa-operator-chop.ts`.

The build-readiness review found FOUR surfaces (not two) asserting forfeit→bankroll. All must flip to bankroll-unchanged + sink-credited.

- [ ] **Step 1:** `qa-operator-coinflip.ts` ~L285 — replace the `forfeit banked to operator bankroll (+tierPrice)` check (`bankrollOf() - before === TIER`) with two checks: operator bankroll UNCHANGED across the forfeit, and the BurnFeePolicy `burned(token)` increased by `TIER`. Keep the fee-restored and exposure/stake checks (~L286-292).
- [ ] **Step 2:** `operator-forfeit.test.ts` ~L284 and ~L324 — invert `(bankrollOf() - before) === PRICE` to bankroll unchanged + sink credited by `PRICE`. Keep fee-restored (~L297/L326) and validator-stake checks.
- [ ] **Step 3:** `qa-operator-chop.ts` ~L95 — change `bankroll += exposure + forfeit` to `bankroll += exposure` (only the returned exposure) and add a sink-credited-by-tierPrice check.
- [ ] **Step 4:** For all three, read the BurnFeePolicy address from the synced deployment JSON (Task 5 adds it) and assert `burned(token)`; where the event is checked, `ForfeitRouted.forfeit` now equals the amount routed to the sink. These scripts run live against 943 in Task 5, so they only need to typecheck now: `cd games/e2e && npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `git commit -am "test(assets-s0): invert forfeit->bankroll assertions to forfeit->sink across all four e2e surfaces"`

---

## Task 4: Full Foundry suite + deployability gate

- [ ] **Step 1:** `cd games/contracts && forge test` → all green (the whole operator suite, not just the touched files).
- [ ] **Step 2:** Compile under the shanghai profile and verify deployability of every new/changed contract (BurnFeePolicy, OperatorCoinFlip): assert the STRIPPED runtime bytecode contains no MCOPY (0x5e) / TSTORE (0x5d) — use the repo's existing deployability scan (the one from the MCOPY remediation), and assert size < 24576. OperatorCoinFlip has ~14KB headroom; confirm the additions keep it under.
- [ ] **Step 3:** Run the Forge coverage on the operator contracts to confirm the new branches (park, sweep, tier-boundary, setForfeitPolicy reject) are covered.
- [ ] **Step 4: Commit** any profile/scan config touched — `git commit -am "chore(assets-s0): deployability + coverage gate green for the fee-policy forfeit re-route"`

---

## Task 5: Live-943 redeploy + reprove (OWNER-GATED; may bundle with System 2)

Do NOT run this without the owner's go-ahead — it is a production redeploy on the ansible runbook.

- [ ] **Step 1:** Confirm `op` session first: `timeout 15 op read op://valve/valve_deployer/pk >/dev/null && echo OK || echo HUNG`.
- [ ] **Step 2:** Extend `redeploy-operator-coinflip.ts` to deploy `BurnFeePolicy`, pass `[burnPolicy]` as the menu and `burnPolicy` as the default to the new `OperatorCoinFlip`, and sync BOTH deployment JSONs (add `BurnFeePolicy` + retire the prior game into `operatorCoinFlipRetired`, keep `heatsSince`).
- [ ] **Step 3:** Deploy to 943 via the ansible runbook, valve RPC (not the public 943 RPC). Re-`authorizeGame`/`setPlayerGame` as the redeploy runbook requires.
- [ ] **Step 4:** Reprove: `cd games/e2e && MODE=all … npx tsx scripts/qa-operator-coinflip.ts` — assert the forfeit path now credits the BurnFeePolicy sink (not the operator bankroll), the player is refunded, fee restored, exposure released, and the custody invariant holds. Bundle option: run this together with the System 2 QA once that lands, on one redeploy.
- [ ] **Step 5:** Update the memory note (`validator-forfeit-mechanism`) with the new addresses and the neutral-sink routing. Commit the config + proof log.

---

## Self-Review

- **Spec coverage:** §4.1 IFeePolicy → Task 1; §4.2 forfeit re-route (refund-first, measured, full-amount, park) → Task 2; H1 four test surfaces → Tasks 2+3; deployability/custody → Task 4; live reprove → Task 5. All covered.
- **Review findings:** H2 (full amount, skip feeBps) → Task 2 Step 3 + `_deliverAndRoute`; M1 (refund first + wrap) → Step 3; M2 (unset default burn, also guarded) → default is a menu BurnFeePolicy, and the route is always try/caught; M3 (measured) → `pre`/`measured` delta; L1 (context ABI) → `abi.encode(roundId, operator, player)`; L2 (sweep nonReentrant, exactly-once) → `sweepForfeit`; L3 (immutable menu) → constructor-set `allowedFeePolicy`, no adder, immediate switch for recovery; L4 (sink balance to QA) → `BurnFeePolicy.burned`; L5 (event shape) → keep `ForfeitRouted` shape, 4th arg = routed-to-sink, add `ForfeitParked`.
- **No placeholders:** contract code is concrete; the one implementer choice (burn vs dead-transfer transport) is called out explicitly with the reason.
- **Type/name consistency:** `FORFEIT_KIND`, `forfeitPolicy`, `allowedFeePolicy`, `unrouted`, `_deliverAndRoute`, `_routeForfeitToSink`, `ForfeitParked`, `BurnFeePolicy.burned` used consistently across tasks.

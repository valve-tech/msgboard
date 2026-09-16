# Validator-Inclusion Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator attach a pluggable, stricter-only validator-inclusion policy to each table, without ever weakening the fund-safety floor, and re-prove it airtight on 943.

**Architecture:** Each `Table` gains an optional `validatorPolicy` hook address. `open()` enforces the existing hard floor (`_validateSubset`: ≥3 distinct allowlisted validators) FIRST, then, if a policy is set, calls it as a `view` that can only reject (tighten). A built-in `DefaultValidatorPolicy` covers the common rules (minCount / requireOperator / whitelist) with per-(game,table) config settable only by the operator. The policy gates `open()` only — settle/claim/chop/forfeit are untouched, preserving the proven forfeit airtightness.

**Tech Stack:** Solidity 0.8.25 (via_ir, evm_version=shanghai — pre-Cancun 369/943, no MCOPY/TSTORE), Foundry (forge) for unit tests, viem + vitest + anvil for the real-Random integration test, hardhat artifacts for the e2e/QA path.

## Global Constraints

- solc 0.8.25, via_ir, `evm_version = shanghai` (foundry.toml + hardhat.config.ts overrides) — NO MCOPY/TSTORE/Cancun opcodes; deployability guard must stay green (runtime < 24576B, mcopy=tstore=tload=0).
- The hard floor stays in the game and CANNOT be lowered by any hook: `subset.length >= MIN_SUBSET` (3), all distinct, all `_isAllowlisted`. Enforced before the hook runs.
- The policy hook is `view` (interface-enforced): it can read state but cannot mutate or move funds.
- Only the table's operator may set/point a table's policy; a player cannot inject one.
- The policy gates `open()` only. No change to `_settle`/`claim`/`chopAndRoute`/`refundStale`/fee/forfeit accounting.
- A reverting/abusive hook may brick only its own operator's table; never another operator, a player, or the escrow.
- Reuse the existing hardened substrate on 943 (registry/escrow/bond/vault); only the game changes + a new policy contract.

---

### Task 1: IValidatorPolicy interface + OperatorCoinFlip hook wiring

**Files:**
- Create: `games/contracts/contracts/games/operator/IValidatorPolicy.sol`
- Modify: `games/contracts/contracts/games/operator/OperatorCoinFlip.sol` (Table struct, errors, `operatorOf`, `setValidatorPolicy`, `open()`)
- Test: `games/contracts/test/foundry/OperatorCoinFlip.t.sol`

**Interfaces:**
- Consumes: existing `GameBase._validateSubset`, `onlyOperator(tableId)`, `tables` mapping.
- Produces:
  - `IValidatorPolicy.validate(address operator, bytes32 tableId, address proposer, address[] calldata subset) external view returns (bool ok)`
  - `OperatorCoinFlip.setValidatorPolicy(bytes32 tableId, address policy)` (operator-only)
  - `OperatorCoinFlip.operatorOf(bytes32 tableId) external view returns (address)`
  - `Table.validatorPolicy` (address, appended field)
  - error `PolicyRejected()`

- [ ] **Step 1: Write the interface**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Pluggable, stricter-only validator-inclusion policy for an operator table. The game
/// enforces the hard floor (>=3 distinct allowlisted validators) BEFORE calling this, so a policy can
/// only ADD constraints, never weaken them. MUST be view: it may read state but cannot move funds.
interface IValidatorPolicy {
    /// @return ok true iff `subset` satisfies the operator's rule for `tableId`. `proposer` is the party
    /// assembling the round (the player in a 1-player game; the opener/game in a future N-party game).
    function validate(address operator, bytes32 tableId, address proposer, address[] calldata subset)
        external
        view
        returns (bool ok);
}
```

- [ ] **Step 2: Write the failing tests** (add to OperatorCoinFlip.t.sol; add a minimal mock policy at the bottom of the test file)

```solidity
// --- minimal policies for hook tests (put at file scope in OperatorCoinFlip.t.sol) ---
contract AllowAllPolicy is IValidatorPolicy {
    function validate(address, bytes32, address, address[] calldata) external pure returns (bool) { return true; }
}
contract RejectAllPolicy is IValidatorPolicy {
    function validate(address, bytes32, address, address[] calldata) external pure returns (bool) { return false; }
}
contract RevertingPolicy is IValidatorPolicy {
    function validate(address, bytes32, address, address[] calldata) external pure returns (bool) { revert("policy boom"); }
}
// Accepts even a too-small subset — proves the game floor still rejects regardless of the hook.
contract TwoIsFinePolicy is IValidatorPolicy {
    function validate(address, bytes32, address, address[] calldata s) external pure returns (bool) { return s.length >= 2; }
}
```

```solidity
function test_setValidatorPolicy_onlyOperator() public {
    bytes32 tid = _table();
    AllowAllPolicy p = new AllowAllPolicy();
    vm.prank(address(0xBAD));
    vm.expectRevert(OperatorCoinFlip.NotOperator.selector);
    game.setValidatorPolicy(tid, address(p));
    vm.prank(op);
    game.setValidatorPolicy(tid, address(p)); // operator OK
    ( , , , , , , address pol) = game.tables(tid);
    assertEq(pol, address(p));
}

function test_open_policyRejects_reverts() public {
    bytes32 tid = _table();
    RejectAllPolicy p = new RejectAllPolicy();
    vm.prank(op); game.setValidatorPolicy(tid, address(p));
    (bytes32,) ; // placeholder to keep numbering
    vm.prank(player);
    vm.expectRevert(OperatorCoinFlip.PolicyRejected.selector);
    game.open(tid, 0, 4 ether, subset, _locsAt(game.tierPriceOf(tid, 4 ether)));
}

function test_open_policyAccepts_succeeds() public {
    bytes32 tid = _table();
    AllowAllPolicy p = new AllowAllPolicy();
    vm.prank(op); game.setValidatorPolicy(tid, address(p));
    (bytes32 roundId,,) = _open(tid, 0, 4 ether); // must not revert
    assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Pending));
}

function test_open_floor_cannot_be_weakened_by_hook() public {
    bytes32 tid = _table();
    TwoIsFinePolicy p = new TwoIsFinePolicy();
    vm.prank(op); game.setValidatorPolicy(tid, address(p));
    address[] memory two = new address[](2);
    two[0] = subset[0]; two[1] = subset[1];
    vm.prank(player);
    vm.expectRevert(GameBase.BadSubset.selector); // the floor rejects before/despite the permissive hook
    game.open(tid, 0, 4 ether, two, _locsAt(game.tierPriceOf(tid, 4 ether)));
}

function test_open_revertingHook_bricksOnlyThatTable() public {
    bytes32 bad = _table();
    RevertingPolicy p = new RevertingPolicy();
    vm.prank(op); game.setValidatorPolicy(bad, address(p));
    vm.prank(player);
    vm.expectRevert(); // hook revert bubbles → open reverts
    game.open(bad, 0, 4 ether, subset, _locsAt(game.tierPriceOf(bad, 4 ether)));
    // a different table with no policy still works
    bytes32 ok = _table();
    (bytes32 roundId,,) = _open(ok, 0, 4 ether);
    assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Pending));
}

function test_settle_and_forfeit_unaffected_with_policy() public {
    bytes32 tid = _table();
    AllowAllPolicy p = new AllowAllPolicy();
    vm.prank(op); game.setValidatorPolicy(tid, address(p));
    (bytes32 roundId, bytes32 key, PreimageLocation.Info[] memory locs) = _open(tid, 0, 4 ether);
    rnd.setRevealed(key, 0x3);
    game.chopAndRoute(roundId, locs);
    assertEq(_status(roundId), uint8(OperatorCoinFlip.Status.Refunded));
    assertEq(esc.bankrollOf(op, address(tok)), BANKROLL + 4 ether);
}
```

Add `import {IValidatorPolicy} from "../../contracts/games/operator/IValidatorPolicy.sol";` and `import {GameBase} from "../../contracts/GameBase.sol";` (GameBase may already be imported) to the test file.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd games/contracts && forge test --match-contract OperatorCoinFlip`
Expected: compile error / FAIL — `setValidatorPolicy`, `PolicyRejected`, `Table.validatorPolicy` don't exist yet.

- [ ] **Step 4: Implement the wiring in OperatorCoinFlip.sol**

Add the import and error:
```solidity
import {IValidatorPolicy} from "./IValidatorPolicy.sol";
```
```solidity
error PolicyRejected();
```
Append `validatorPolicy` to the `Table` struct (after `open`, keeping earlier tuple indices stable):
```solidity
struct Table {
    address operator;
    address token;
    uint16  maxMultiplierX100;
    uint256 minStake;
    uint256 maxStake;
    bool    open;
    address validatorPolicy; // 0 = floor only; else a stricter-only IValidatorPolicy hook
}
```
Set it to `address(0)` in the `createTable` struct literal (add `validatorPolicy: address(0)`).
Add the getter + setter:
```solidity
function operatorOf(bytes32 tableId) external view returns (address) {
    return tables[tableId].operator;
}

function setValidatorPolicy(bytes32 tableId, address policy) external onlyOperator(tableId) {
    tables[tableId].validatorPolicy = policy;
    emit ValidatorPolicySet(tableId, policy);
}
```
Add the event near the others:
```solidity
event ValidatorPolicySet(bytes32 indexed tableId, address indexed policy);
```
In `open()`, AFTER `_validateSubset(validatorSubset);` and before computing the tier price, call the hook:
```solidity
_validateSubset(validatorSubset); // hard floor first — a hook can only tighten it
address policy = t.validatorPolicy;
if (policy != address(0)) {
    if (!IValidatorPolicy(policy).validate(t.operator, tableId, msg.sender, validatorSubset)) revert PolicyRejected();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd games/contracts && forge test --match-contract OperatorCoinFlip`
Expected: PASS (all prior 25 + the 6 new). If a `_table()` tuple destructuring breaks because `tables` now returns 7 fields, update the test helper that reads it (search `game.tables(` in the test).

- [ ] **Step 6: Deployability guard**

Run:
```bash
cd games/contracts && ../../node_modules/.bin/hardhat compile && node --input-type=module -e '
import {readFileSync} from "node:fs";
function strip(h){let c=h.slice(2);const b=Buffer.from(c,"hex");const m=b[b.length-2]*256+b[b.length-1];return m+2<=b.length?b.subarray(0,b.length-m-2):b;}
function scan(h){const b=strip(h);let i=0,mc=0,ts=0,tl=0;while(i<b.length){const o=b[i];if(o===0x5e)mc++;else if(o===0x5d)ts++;else if(o===0x5c)tl++;if(o>=0x60&&o<=0x7f){i+=1+(o-0x5f);continue;}i++;}return{mc,ts,tl,size:b.length};}
const a=JSON.parse(readFileSync("artifacts/contracts/games/operator/OperatorCoinFlip.sol/OperatorCoinFlip.json","utf8"));
const s=scan(a.deployedBytecode);console.log("OperatorCoinFlip",s.size+"B","mcopy="+s.mc,"tstore="+s.ts,"tload="+s.tl);'
```
Expected: mcopy=tstore=tload=0, size < 24576.

- [ ] **Step 7: Commit**

```bash
git add games/contracts/contracts/games/operator/IValidatorPolicy.sol games/contracts/contracts/games/operator/OperatorCoinFlip.sol games/contracts/test/foundry/OperatorCoinFlip.t.sol
git commit -m "feat(operator): pluggable stricter-only validator-inclusion policy hook on tables"
```

---

### Task 2: DefaultValidatorPolicy (built-in minCount / requireOperator / whitelist)

**Files:**
- Create: `games/contracts/contracts/games/operator/DefaultValidatorPolicy.sol`
- Test: `games/contracts/test/foundry/DefaultValidatorPolicy.t.sol`

**Interfaces:**
- Consumes: `IValidatorPolicy` (Task 1), `OperatorCoinFlip.operatorOf` (Task 1).
- Produces:
  - `DefaultValidatorPolicy.setConfig(address game, bytes32 tableId, uint256 minCount, bool requireOperator, address[] calldata whitelist)` (operator-only, via `operatorOf`)
  - `DefaultValidatorPolicy.configOf(address game, bytes32 tableId) view returns (uint256 minCount, bool requireOperator, bool useWhitelist)`
  - `validate(...)` per IValidatorPolicy.

- [ ] **Step 1: Write failing tests** (`DefaultValidatorPolicy.t.sol`)

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {DefaultValidatorPolicy} from "../../contracts/games/operator/DefaultValidatorPolicy.sol";

// stand-in for the game: only operatorOf is used by the policy
contract GameStub {
    mapping(bytes32 => address) public op;
    function set(bytes32 t, address o) external { op[t] = o; }
    function operatorOf(bytes32 t) external view returns (address) { return op[t]; }
}

contract DefaultValidatorPolicyTest is Test {
    DefaultValidatorPolicy pol;
    GameStub game;
    address operator = address(0x0B);
    bytes32 tid = keccak256("t1");
    address v1 = address(0x301); address v2 = address(0x302); address v3 = address(0x303); address v4 = address(0x304);

    function setUp() public {
        pol = new DefaultValidatorPolicy();
        game = new GameStub();
        game.set(tid, operator);
    }
    function _subset(address a, address b, address c) internal pure returns (address[] memory s) {
        s = new address[](3); s[0]=a; s[1]=b; s[2]=c;
    }

    function test_setConfig_onlyOperator() public {
        address[] memory wl = new address[](0);
        vm.prank(address(0xBAD));
        vm.expectRevert(DefaultValidatorPolicy.NotOperator.selector);
        pol.setConfig(address(game), tid, 3, false, wl);
        vm.prank(operator);
        pol.setConfig(address(game), tid, 3, false, wl); // OK
    }

    function test_requireOperator() public {
        address[] memory wl = new address[](0);
        vm.prank(operator); pol.setConfig(address(game), tid, 3, true, wl);
        // operator not present → reject
        assertFalse(pol.validate(operator, tid, address(0), _subset(v1, v2, v3)));
        // operator present → accept
        assertTrue(pol.validate(operator, tid, address(0), _subset(operator, v1, v2)));
    }

    function test_whitelist() public {
        address[] memory wl = new address[](3);
        wl[0]=v1; wl[1]=v2; wl[2]=v3;
        vm.prank(operator); pol.setConfig(address(game), tid, 3, false, wl);
        assertTrue(pol.validate(operator, tid, address(0), _subset(v1, v2, v3)));
        assertFalse(pol.validate(operator, tid, address(0), _subset(v1, v2, v4))); // v4 not whitelisted
    }

    function test_minCount() public {
        address[] memory wl = new address[](0);
        vm.prank(operator); pol.setConfig(address(game), tid, 4, false, wl);
        assertFalse(pol.validate(operator, tid, address(0), _subset(v1, v2, v3))); // only 3 < 4
    }
}
```

- [ ] **Step 2: Run to verify fail** — `forge test --match-contract DefaultValidatorPolicy` → FAIL (contract missing).

- [ ] **Step 3: Implement DefaultValidatorPolicy.sol**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IValidatorPolicy} from "./IValidatorPolicy.sol";

interface IOperatorGameTables {
    function operatorOf(bytes32 tableId) external view returns (address);
}

/// @notice A ready-made stricter-only validator policy. Per (game, table) an operator sets: a minimum
/// count, whether the operator address must be in the subset, and an optional whitelist (if non-empty,
/// every subset member must be on it). The game already enforces the hard floor (>=3 distinct allowlisted),
/// so this can only add constraints. Config is writable only by the table's operator (read via the game's
/// operatorOf). All checks are pure reads → view, cannot move funds.
contract DefaultValidatorPolicy is IValidatorPolicy {
    error NotOperator();

    struct Config {
        uint256 minCount;
        bool requireOperator;
        bool useWhitelist;
        uint256 version; // bump on each setConfig so a re-set whitelist replaces the old one cleanly
    }

    mapping(address game => mapping(bytes32 tableId => Config)) internal _config;
    // whitelist membership keyed by version so a fresh setConfig doesn't inherit stale entries
    mapping(address game => mapping(bytes32 tableId => mapping(uint256 version => mapping(address => bool)))) internal _wl;

    event ConfigSet(address indexed game, bytes32 indexed tableId, uint256 minCount, bool requireOperator, bool useWhitelist);

    function setConfig(
        address game,
        bytes32 tableId,
        uint256 minCount,
        bool requireOperator,
        address[] calldata whitelist
    ) external {
        if (msg.sender != IOperatorGameTables(game).operatorOf(tableId)) revert NotOperator();
        Config storage c = _config[game][tableId];
        uint256 v = c.version + 1;
        c.minCount = minCount;
        c.requireOperator = requireOperator;
        c.useWhitelist = whitelist.length > 0;
        c.version = v;
        for (uint256 i = 0; i < whitelist.length; ++i) {
            _wl[game][tableId][v][whitelist[i]] = true;
        }
        emit ConfigSet(game, tableId, minCount, requireOperator, c.useWhitelist);
    }

    function configOf(address game, bytes32 tableId)
        external
        view
        returns (uint256 minCount, bool requireOperator, bool useWhitelist)
    {
        Config storage c = _config[game][tableId];
        return (c.minCount, c.requireOperator, c.useWhitelist);
    }

    /// @dev msg.sender is the calling game; config is keyed by it.
    function validate(address operator, bytes32 tableId, address, address[] calldata subset)
        external
        view
        returns (bool)
    {
        Config storage c = _config[msg.sender][tableId];
        if (subset.length < c.minCount) return false;
        if (c.requireOperator) {
            bool found;
            for (uint256 i = 0; i < subset.length; ++i) {
                if (subset[i] == operator) { found = true; break; }
            }
            if (!found) return false;
        }
        if (c.useWhitelist) {
            uint256 v = c.version;
            for (uint256 i = 0; i < subset.length; ++i) {
                if (!_wl[msg.sender][tableId][v][subset[i]]) return false;
            }
        }
        return true;
    }
}
```

- [ ] **Step 4: Run to verify pass** — `forge test --match-contract DefaultValidatorPolicy` → PASS.

- [ ] **Step 5: Deployability guard** — same one-liner as Task 1 Step 6 but for `DefaultValidatorPolicy.json`. Expected: mcopy=tstore=tload=0, small size.

- [ ] **Step 6: Commit**

```bash
git add games/contracts/contracts/games/operator/DefaultValidatorPolicy.sol games/contracts/test/foundry/DefaultValidatorPolicy.t.sol
git commit -m "feat(operator): DefaultValidatorPolicy — minCount/requireOperator/whitelist, operator-set"
```

---

### Task 3: Anvil integration — policy set, settle + forfeit still pass vs real Random

**Files:**
- Modify: `games/e2e/test/operator-forfeit.test.ts`

**Interfaces:**
- Consumes: `setValidatorPolicy` (Task 1), `DefaultValidatorPolicy` artifact (Task 2), the existing anvil harness.

- [ ] **Step 1: Add a test** that deploys `DefaultValidatorPolicy`, sets a requireOperator=false / whitelist=the 3 validators config for the table, points the table at it via `setValidatorPolicy`, then runs one settle and one forfeit round and asserts they behave exactly as the no-policy cases (policy is pre-heat gating, so real-Random paths are unchanged). Reuse `openRound`, the withhold+chop sequence, and the same assertions (forfeit == PRICE, player refunded, fee restored).

Import the artifact:
```ts
import DefaultPolicyArtifact from '@msgboard/games-contracts/artifacts/contracts/games/operator/DefaultValidatorPolicy.sol/DefaultValidatorPolicy.json'
```
In `beforeAll`, after `createTable`, deploy the policy, `setConfig(game, tableId, 3, false, subset)`, and `game.setValidatorPolicy(tableId, policy)`. Then the existing SETTLE / FORFEIT / FRONT-RUN tests run against a policy-gated table.

- [ ] **Step 2: Run** — `cd games/e2e && npx vitest run test/operator-forfeit.test.ts`
Expected: all tests PASS (policy accepts the canonical subset; forfeit unchanged).

- [ ] **Step 3: Commit**

```bash
git add games/e2e/test/operator-forfeit.test.ts
git commit -m "test(operator): anvil — settle+forfeit unchanged with a validator policy attached"
```

---

### Task 4: Redeploy path + QA harness policy cases

**Files:**
- Modify: `games/contracts/scripts/redeploy-operator-coinflip.ts` (also deploy DefaultValidatorPolicy, record its address)
- Modify: `games/e2e/scripts/qa-operator-coinflip.ts` (policy mode: set config, valid open passes, invalid open reverts PolicyRejected)

**Interfaces:**
- Consumes: Task 1 + Task 2 contracts.
- Produces: `943-operator-substrate.json.contracts.DefaultValidatorPolicy`.

- [ ] **Step 1:** In `redeploy-operator-coinflip.ts`, after deploying `OperatorCoinFlip`, also deploy `DefaultValidatorPolicy` (no constructor args) and write it into the record `contracts.DefaultValidatorPolicy`. Keep the existing e2e-config sync.

- [ ] **Step 2:** In `qa-operator-coinflip.ts`, add a `runPolicy()` mode (folded into `all`): create a table, `DefaultValidatorPolicy.setConfig(GAME, tableId, 3, true, subset)` (requireOperator=true), `game.setValidatorPolicy(tableId, policy)`, then:
  - open with a subset that INCLUDES the operator among the 3 → passes (or, since the canonical subset is the 3 validators and the operator is a separate address, set requireOperator=false + whitelist=subset for the passing case, and a separate table with a whitelist EXCLUDING one member to force a `PolicyRejected` revert via `expectRevert`).
  - Assert the valid open succeeds and the invalid open reverts `PolicyRejected`.
Keep the run self-contained (reads addresses from the substrate json, uses the valve RPC, retries transient RPC errors).

- [ ] **Step 3:** Typecheck: `cd games/e2e && npx tsc --noEmit -p tsconfig.json` and `cd games/contracts && npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 4: Commit**

```bash
git add games/contracts/scripts/redeploy-operator-coinflip.ts games/e2e/scripts/qa-operator-coinflip.ts
git commit -m "chore(operator): deploy DefaultValidatorPolicy in redeploy + QA policy cases"
```

---

### Task 5: Reviews, live 943 redeploy + re-prove

**Files:** deployment JSONs (943), the SDD ledger; no new source unless a review finds an issue.

- [ ] **Step 1: Whole-branch fund-safety review** (subagent, opus) focused on the hook seam: can any hook path move funds, bypass the floor (≥3 distinct allowlisted), be set by a non-operator, or brick beyond the operator's own table? Confirm the policy gates open() only and the forfeit airtightness is preserved. Fix any finding + re-review.

- [ ] **Step 2: Redeploy** the policy-aware OperatorCoinFlip + DefaultValidatorPolicy to 943 via `redeploy-operator-coinflip.ts` (valve RPC, `DEPLOY_EXECUTE=1`). Confirm read-back wiring + both config files synced + prior game retired.

- [ ] **Step 3: Live proof** — run `qa-operator-coinflip.ts MODE=all` on 943 (valve RPC, secrets via `op`). Expected: the full 42 checks + the new policy checks (valid open passes, invalid open reverts PolicyRejected), forfeit still routes.

- [ ] **Step 4: Record** the 943 addresses + the policy proof in the memory + `validator-forfeit-mechanism` note; update the SDD ledger.

- [ ] **Step 5: Commit**

```bash
git add games/contracts/deployments/943-operator-substrate.json games/e2e/scripts/943-deployment.json
git commit -m "chore(operator): redeploy policy-aware OperatorCoinFlip + DefaultValidatorPolicy to 943 + live proof"
```

---

## Self-Review

**Spec coverage:** pluggable hook (Task 1); stricter-only floor enforced by the game (Task 1 wiring + `test_open_floor_cannot_be_weakened_by_hook`); built-in default policy with minCount/requireOperator/whitelist (Task 2); multiplayer-ready interface (Task 1 — `proposer` + `subset` in the signature); operator-only policy set (Task 1 `setValidatorPolicy` + Task 2 `setConfig`); reverting hook bricks only its table (Task 1 test); forfeit/settle untouched (Task 1 + Task 3 tests); re-prove on 943 (Tasks 3–5). ZK-settlement and the backroom are non-goals (separate). ✓

**Placeholder scan:** the QA policy-case wording in Task 4 Step 2 gives two concrete options (requireOperator vs whitelist-excluding-a-member) rather than one fixed subset because the canonical 943 subset does not contain the operator address — the implementer picks the whitelist-exclusion path to force a real `PolicyRejected`. Concrete, not a placeholder. All code steps carry real code. ✓

**Type consistency:** `IValidatorPolicy.validate(address,bytes32,address,address[])→bool` is used identically in the interface (Task 1), the mocks (Task 1), DefaultValidatorPolicy (Task 2), and the game's call site (Task 1). `operatorOf(bytes32)→address` defined in Task 1, consumed by DefaultValidatorPolicy + its GameStub (Task 2). `setValidatorPolicy(bytes32,address)` / `setConfig(address,bytes32,uint256,bool,address[])` consistent across tasks. `Table.validatorPolicy` appended (tuple index 6) — the `tables` getter now returns 7 fields; Task 1 Step 5 flags updating any test destructuring. ✓

# Table-Maintainer Substrate — Slice A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the bonded-operator substrate — a permissionless registry, a standardized pre-collateralized token-agnostic escrow, protocol-held bond custody, and a default funding vault — and prove it end-to-end by wiring an escrow-backed coin-flip reference game, on 943 with bots.

**Architecture:** Three new standalone contracts form the substrate: `OperatorRegistry` (thin identity + rake/funding/bond config, custodies nothing), `GameEscrow` (the safety-critical settlement seam — holds all player/operator funds in per-`(operator, token)` isolated ledgers, pre-collateralizes every bet with balance-delta-verified pulls, pays out deterministically), and `OperatorBond` (protocol-held accountability bond). `OperatorVault` is an EIP-1167-cloneable convenience funding source. `OperatorCoinFlip` is a new reference game that extends the existing `GameBase` (validator heat / onCast settle) but delegates ALL custody to `GameEscrow` — the live `CoinFlipTables` is left untouched. The escrow enforces every money invariant structurally; the game only decides win/loss/refund and can only pay the player recorded at lock or credit the operator's own ledger.

**Tech Stack:** Solidity 0.8.25, Foundry (forge), Solady (`SafeTransferLib`, `ERC20`, `LibClone`), the existing `games/contracts` Foundry harness (`FOUNDRY_PROFILE=default`), `MockRandom` for validator entropy, the `ERC20`/`ReenteringToken` test mocks.

## Global Constraints

- Solidity pragma `^0.8.24`; compiled at `solc = 0.8.25`, `via_ir = true`, `optimizer_runs = 700`, `evm_version = shanghai` (chain 943/369 are pre-Cancun — PUSH0 ok, **MCOPY/TSTORE rejected on-chain**; every new deployed artifact MUST be MCOPY-free — Task 11 gates this).
- All new production contracts live under `games/contracts/contracts/games/operator/`. All new tests live under `games/contracts/test/foundry/`.
- Run tests from `games/contracts/` with the default profile: `forge test --match-path 'test/foundry/<Name>.t.sol' -vv`.
- Token moves ONLY via `solady/src/utils/SafeTransferLib.sol` (`safeTransfer`, `safeTransferFrom`, `balanceOf`). Never raw `IERC20`.
- Every external token pull is **balance-delta verified**: measure `balanceOf(this)` before/after and credit the measured delta — never the requested amount (fee-on-transfer / rebasing safe).
- Per-`(operator, token)` ledger key is always `keccak256(abi.encode(operator, token))`. No cross-operator or cross-token pooling, ever.
- Checks-Effects-Interactions on every path: flip status / mutate ledger BEFORE any external transfer. Reentrancy is defeated structurally (state settled before transfer), not with a guard that would block claim retries.
- Deployed-bytecode ceiling: keep every new contract under 24,300 bytes (EIP-170 safety margin). Extract pure accounting math into `EscrowLib` to hold `GameEscrow` down (mirrors the existing `BankrollLib` pattern).
- No native token anywhere in the substrate — the substrate is token-agnostic ERC-20 only. It never names which token has value.

---

## File Structure

- `contracts/games/operator/EscrowLib.sol` — pure per-`(operator, token)` ledger accounting + its bounds-check errors (no transfers, no events). Mirrors `BankrollLib`.
- `contracts/games/operator/OperatorRegistry.sol` — permissionless operator identity; rake config, funding-source pointer, bond-ref pointer, metadata URI. Custodies nothing.
- `contracts/games/operator/GameEscrow.sol` — the standardized settlement seam: bankroll deposit/withdraw, `lockExposure`, `settleWin`/`settleLoss`, `refund`, rake accrual/withdraw. Holds all game funds.
- `contracts/games/operator/OperatorBond.sol` — protocol-held per-`(operator, token)` bond: post/topUp/withdraw-when-idle, game-authorized `slashToPlayer`.
- `contracts/games/operator/OperatorVault.sol` — minimal EIP-1167-cloneable default funding vault (holds operator capital, funds the escrow's bankroll on the operator's behalf).
- `contracts/games/operator/OperatorCoinFlip.sol` — reference game: extends `GameBase`, delegates custody to `GameEscrow`, token-agnostic per-table.
- Tests (all `test/foundry/`): `OperatorRegistry.t.sol`, `GameEscrow.t.sol`, `GameEscrowInvariant.t.sol`, `OperatorBond.t.sol`, `OperatorVault.t.sol`, `OperatorCoinFlip.t.sol`.
- `contracts/deploy/` (or existing deploy dir): a 943 deploy script + the addresses doc.

**Architecture note — deviation from spec §3.2/§3.5 phrasing (intentional):** the spec describes pulling exposure "from the operator's funding source" *per bet*. This plan uses the strictly-safer **internal-ledger** form: the operator pre-deposits capital into `GameEscrow` (balance-delta verified) crediting its `(operator, token)` bankroll ledger; `lockExposure` debits exposure from that already-in-escrow ledger and pulls ONLY the player's stake fresh. Both forms satisfy every invariant (a BYO source that won't fund → the bankroll is short → the bet reverts, player never exposed), but the internal-ledger form keeps all collateral physically in escrow before any bet opens, so escrow solvency is a local invariant rather than a per-bet external-call trust. "BYO funding" is preserved: `depositBankroll` pulls from `msg.sender`, which may be any EOA / Safe / `OperatorVault` clone. This is the load-bearing simplification; carry it through every task.

---

## Task 1: EscrowLib — pure ledger accounting

**Files:**
- Create: `contracts/games/operator/EscrowLib.sol`
- Test: `test/foundry/GameEscrow.t.sol` (this task adds the library-level unit tests; later tasks extend the same file for the contract)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `struct EscrowLib.Ledger { uint256 bankroll; uint256 locked; uint256 rake; }`
  - `EscrowLib.creditBankroll(Ledger storage, uint256)`
  - `EscrowLib.debitBankroll(Ledger storage, uint256)` — reverts `InsufficientBankroll` if `< amount`
  - `EscrowLib.lock(Ledger storage, uint256 exposure, uint256 payout)` — reverts `InsufficientBankroll` if `bankroll < exposure`; then `bankroll -= exposure; locked += payout`
  - `EscrowLib.settleWin(Ledger storage, uint256 payout)` — `locked -= payout`
  - `EscrowLib.settleLoss(Ledger storage, uint256 payout, uint256 rakeAmt)` — `locked -= payout; rake += rakeAmt; bankroll += (payout - rakeAmt)`
  - `EscrowLib.refundExposure(Ledger storage, uint256 payout, uint256 exposure)` — `locked -= payout; bankroll += exposure`
  - `EscrowLib.takeRake(Ledger storage) returns (uint256 amt)` — `amt = rake; rake = 0`
  - errors: `InsufficientBankroll()`

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EscrowLib} from "../../contracts/games/operator/EscrowLib.sol";

contract EscrowLibTest is Test {
    using EscrowLib for EscrowLib.Ledger;
    EscrowLib.Ledger internal l;

    function test_lock_debitsExposure_growsLocked() public {
        l.creditBankroll(100);
        l.lock(30, 50); // exposure 30, payout 50 (player stake 20 sits in `locked` too)
        assertEq(l.bankroll, 70);
        assertEq(l.locked, 50);
    }

    function test_lock_revertsWhenBankrollBelowExposure() public {
        l.creditBankroll(10);
        vm.expectRevert(EscrowLib.InsufficientBankroll.selector);
        l.lock(30, 50);
    }

    function test_settleLoss_returnsExposurePlusStakeMinusRake() public {
        l.creditBankroll(100);
        l.lock(30, 50);      // bankroll 70, locked 50
        l.settleLoss(50, 4); // rake 4
        assertEq(l.locked, 0);
        assertEq(l.rake, 4);
        assertEq(l.bankroll, 70 + 46); // exposure(30) + stake(20) - rake(4) = 46
    }

    function test_settleWin_onlyReleasesLocked() public {
        l.creditBankroll(100);
        l.lock(30, 50);
        l.settleWin(50); // payout leaves escrow to the player externally
        assertEq(l.locked, 0);
        assertEq(l.bankroll, 70); // exposure already left at lock; not returned on a win
    }

    function test_refundExposure_returnsOnlyExposure() public {
        l.creditBankroll(100);
        l.lock(30, 50);
        l.refundExposure(50, 30); // stake returns to player externally
        assertEq(l.locked, 0);
        assertEq(l.bankroll, 100 - 30 + 30); // net: exposure back, stake NOT credited (goes to player)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: FAIL — `EscrowLib` source not found / undefined.

- [ ] **Step 3: Write minimal implementation**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Pure per-(operator, token) ledger accounting for GameEscrow. Only the mutations and their
/// bounds-check reverts live here — token transfers, events, and access control stay in GameEscrow,
/// since a library must not move the contract's tokens. Mirrors BankrollLib's split.
///
/// `bankroll` is the operator's armed capital a new bet may lock exposure against. `locked` is the
/// full payout escrowed by live bets (operator exposure + the player's own stake). `rake` is accrued
/// operator rake awaiting withdrawal. Every unit is denominated in one token; the (operator, token)
/// key lives in GameEscrow's mapping, one Ledger per key — buckets never mix.
library EscrowLib {
    error InsufficientBankroll();

    struct Ledger {
        uint256 bankroll;
        uint256 locked;
        uint256 rake;
    }

    function creditBankroll(Ledger storage l, uint256 amount) internal {
        l.bankroll += amount;
    }

    function debitBankroll(Ledger storage l, uint256 amount) internal {
        if (l.bankroll < amount) revert InsufficientBankroll();
        l.bankroll -= amount;
    }

    /// @notice Reserve a bet at lock: only the operator's exposure leaves bankroll; `locked` grows by
    /// the full payout (the player's own stake, pulled by the caller, funds the remainder).
    function lock(Ledger storage l, uint256 exposure, uint256 payout) internal {
        if (l.bankroll < exposure) revert InsufficientBankroll();
        l.bankroll -= exposure;
        l.locked += payout;
    }

    /// @notice Player won: payout leaves `locked` to be paid to the player by the caller. bankroll is
    /// untouched — the exposure already left at lock.
    function settleWin(Ledger storage l, uint256 payout) internal {
        l.locked -= payout;
    }

    /// @notice Player lost: the whole reservation returns to the operator minus rake. bankroll gains
    /// (payout - rakeAmt) = exposure + stake - rake; rake accrues separately.
    function settleLoss(Ledger storage l, uint256 payout, uint256 rakeAmt) internal {
        l.locked -= payout;
        l.rake += rakeAmt;
        l.bankroll += (payout - rakeAmt);
    }

    /// @notice Refund (abort/timeout): only the operator's exposure returns to bankroll — the player
    /// reclaims their own stake directly (a transfer the caller performs).
    function refundExposure(Ledger storage l, uint256 payout, uint256 exposure) internal {
        l.locked -= payout;
        l.bankroll += exposure;
    }

    /// @notice Zero and return the accrued rake for withdrawal.
    function takeRake(Ledger storage l) internal returns (uint256 amt) {
        amt = l.rake;
        l.rake = 0;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add contracts/games/operator/EscrowLib.sol test/foundry/GameEscrow.t.sol
git commit -m "feat(operator): EscrowLib pure per-(operator,token) ledger accounting"
```

---

## Task 2: OperatorRegistry — permissionless identity + config

**Files:**
- Create: `contracts/games/operator/OperatorRegistry.sol`
- Test: `test/foundry/OperatorRegistry.t.sol`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `register() external returns (address operatorId)` — `operatorId == msg.sender`; idempotent-safe (records `registered[msg.sender] = true`). Emits `Registered(operatorId)`.
  - `setRakeBps(address game, uint16 bps) external` — operator's own rake for a game; reverts `RakeTooHigh` if `bps > MAX_RAKE_BPS` (constant = 500 = 5%). Stored `rakeBps[msg.sender][game]`. Emits `RakeSet`.
  - `rakeBps(address operator, address game) external view returns (uint16)`
  - `setRakeRecipient(address token, address recipient) external` — `rakeRecipient[msg.sender][token]`. Emits `RakeRecipientSet`.
  - `rakeRecipientOf(address operator, address token) external view returns (address)` — returns the set recipient, or `operator` if unset (never `address(0)`).
  - `setFundingSource(address token, address src) external` — `fundingSource[msg.sender][token]`. Emits `FundingSourceSet`. (Informational pointer for off-chain/vault use; escrow never trusts it.)
  - `fundingSourceOf(address operator, address token) external view returns (address)`
  - `setMetadataURI(string calldata uri) external` — emits `MetadataSet(operator, uri)` (event only; not stored, indexer reads events — mirrors `CoinFlipTables.setName`).
  - `MAX_RAKE_BPS() constant uint16 = 500`
  - errors: `NotRegistered()`, `RakeTooHigh()`

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";

contract OperatorRegistryTest is Test {
    OperatorRegistry internal reg;
    address internal op = address(0x0B);
    address internal game = address(0x6A);
    address internal token = address(0x70);

    function setUp() public { reg = new OperatorRegistry(); }

    function test_register_setsOperatorId() public {
        vm.prank(op);
        assertEq(reg.register(), op);
        assertTrue(reg.registered(op));
    }

    function test_setRakeBps_boundedByMax() public {
        vm.prank(op); reg.register();
        vm.prank(op); reg.setRakeBps(game, 300);
        assertEq(reg.rakeBps(op, game), 300);
        vm.prank(op);
        vm.expectRevert(OperatorRegistry.RakeTooHigh.selector);
        reg.setRakeBps(game, 501);
    }

    function test_rakeRecipient_defaultsToOperator() public {
        vm.prank(op); reg.register();
        assertEq(reg.rakeRecipientOf(op, token), op);
        vm.prank(op); reg.setRakeRecipient(token, address(0xFEE));
        assertEq(reg.rakeRecipientOf(op, token), address(0xFEE));
    }

    function test_config_requiresRegistration() public {
        vm.prank(op);
        vm.expectRevert(OperatorRegistry.NotRegistered.selector);
        reg.setRakeBps(game, 100);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/OperatorRegistry.t.sol' -vv`
Expected: FAIL — source not found.

- [ ] **Step 3: Write minimal implementation**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Permissionless operator identity + config for the table-maintainer substrate. Anyone may
/// register (no admin gate); the registry holds NO funds — it stores only rake config, a funding-source
/// pointer, and a metadata URI event. Curation / "verified" status lives entirely off-chain in the
/// discovery layer (slice C); this contract gatekeeps nothing.
contract OperatorRegistry {
    error NotRegistered();
    error RakeTooHigh();

    uint16 public constant MAX_RAKE_BPS = 500; // 5% ceiling on any operator's own rake

    mapping(address operator => bool) public registered;
    mapping(address operator => mapping(address game => uint16)) internal _rakeBps;
    mapping(address operator => mapping(address token => address)) internal _rakeRecipient;
    mapping(address operator => mapping(address token => address)) internal _fundingSource;

    event Registered(address indexed operator);
    event RakeSet(address indexed operator, address indexed game, uint16 bps);
    event RakeRecipientSet(address indexed operator, address indexed token, address recipient);
    event FundingSourceSet(address indexed operator, address indexed token, address src);
    event MetadataSet(address indexed operator, string uri);

    modifier onlyRegistered() {
        if (!registered[msg.sender]) revert NotRegistered();
        _;
    }

    function register() external returns (address operatorId) {
        registered[msg.sender] = true;
        emit Registered(msg.sender);
        return msg.sender;
    }

    function setRakeBps(address game, uint16 bps) external onlyRegistered {
        if (bps > MAX_RAKE_BPS) revert RakeTooHigh();
        _rakeBps[msg.sender][game] = bps;
        emit RakeSet(msg.sender, game, bps);
    }

    function rakeBps(address operator, address game) external view returns (uint16) {
        return _rakeBps[operator][game];
    }

    function setRakeRecipient(address token, address recipient) external onlyRegistered {
        _rakeRecipient[msg.sender][token] = recipient;
        emit RakeRecipientSet(msg.sender, token, recipient);
    }

    function rakeRecipientOf(address operator, address token) external view returns (address) {
        address r = _rakeRecipient[operator][token];
        return r == address(0) ? operator : r;
    }

    function setFundingSource(address token, address src) external onlyRegistered {
        _fundingSource[msg.sender][token] = src;
        emit FundingSourceSet(msg.sender, token, src);
    }

    function fundingSourceOf(address operator, address token) external view returns (address) {
        return _fundingSource[operator][token];
    }

    function setMetadataURI(string calldata uri) external onlyRegistered {
        emit MetadataSet(msg.sender, uri);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-path 'test/foundry/OperatorRegistry.t.sol' -vv`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add contracts/games/operator/OperatorRegistry.sol test/foundry/OperatorRegistry.t.sol
git commit -m "feat(operator): permissionless OperatorRegistry (identity + rake/funding config)"
```

---

## Task 3: GameEscrow — bankroll deposit/withdraw with balance-delta verification

**Files:**
- Create: `contracts/games/operator/GameEscrow.sol`
- Modify: `test/foundry/GameEscrow.t.sol` (add a `GameEscrowDepositTest` contract; keep `EscrowLibTest`)

**Interfaces:**
- Consumes: `EscrowLib` (Task 1), `OperatorRegistry` (Task 2).
- Produces:
  - `constructor(address registry_)`
  - `registry() external view returns (address)`
  - `_ledgerKey(address operator, address token) internal pure returns (bytes32)` = `keccak256(abi.encode(operator, token))`
  - `bankrollOf(address operator, address token) external view returns (uint256)`
  - `depositBankroll(address operator, address token, uint256 amount) external` — pulls from `msg.sender` via balance-delta, credits `(operator, token)` bankroll with the MEASURED delta. Emits `BankrollDeposited(operator, token, msg.sender, credited)`.
  - `withdrawBankroll(address token, uint256 amount) external` — `msg.sender` is the operator; debits its own `(operator, token)` bankroll (reverts `InsufficientBankroll`), transfers out. Emits `BankrollWithdrawn`.
  - internal `_pullVerified(address token, address from, uint256 amount) returns (uint256 received)` — balance-delta measured pull.

- [ ] **Step 1: Write the failing test**

```solidity
// (append to test/foundry/GameEscrow.t.sol)
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

contract GameEscrowDepositTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;      // plain (no burn)
    ERC20 internal feeTok;   // fee-on-transfer (burns 1%)
    address internal op = address(0x0B);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        feeTok = new ERC20(true);
        vm.prank(op); reg.register();
    }

    function test_deposit_creditsFullAmount_forPlainToken() public {
        tok.mint(address(this), 100 ether);
        tok.approve(address(esc), type(uint256).max);
        esc.depositBankroll(op, address(tok), 100 ether);
        assertEq(esc.bankrollOf(op, address(tok)), 100 ether);
        assertEq(tok.balanceOf(address(esc)), 100 ether);
    }

    function test_deposit_creditsMeasuredDelta_forFeeOnTransfer() public {
        feeTok.mint(address(this), 100 ether);
        feeTok.approve(address(esc), type(uint256).max);
        esc.depositBankroll(op, address(feeTok), 100 ether);
        // 1% burned in transfer → escrow received 99 ether → ledger credits 99, not 100
        assertEq(feeTok.balanceOf(address(esc)), 99 ether);
        assertEq(esc.bankrollOf(op, address(feeTok)), 99 ether);
    }

    function test_withdraw_onlyOperatorsOwnBucket() public {
        tok.mint(address(this), 100 ether);
        tok.approve(address(esc), type(uint256).max);
        esc.depositBankroll(op, address(tok), 100 ether);
        vm.prank(op);
        esc.withdrawBankroll(address(tok), 40 ether);
        assertEq(esc.bankrollOf(op, address(tok)), 60 ether);
        assertEq(tok.balanceOf(op), 40 ether);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: FAIL — `GameEscrow` source not found.

- [ ] **Step 3: Write minimal implementation**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {EscrowLib} from "./EscrowLib.sol";
import {OperatorRegistry} from "./OperatorRegistry.sol";

/// @notice The standardized settlement seam — the safety-critical core of the table-maintainer
/// substrate. Holds ALL player and operator funds in per-(operator, token) isolated ledgers, pulls
/// every deposit with balance-delta verification (fee-on-transfer / rebasing safe), and pays out
/// deterministically. It is token-agnostic (any ERC-20, no whitelist, no oracle). Bet lifecycle
/// (lockExposure / settle / refund / rake) is added in Tasks 4–6.
contract GameEscrow {
    using SafeTransferLib for address;
    using EscrowLib for EscrowLib.Ledger;

    address public immutable registry;

    mapping(bytes32 key => EscrowLib.Ledger) internal ledgers;

    event BankrollDeposited(address indexed operator, address indexed token, address indexed from, uint256 credited);
    event BankrollWithdrawn(address indexed operator, address indexed token, uint256 amount);

    constructor(address registry_) {
        registry = registry_;
    }

    function _ledgerKey(address operator, address token) internal pure returns (bytes32) {
        return keccak256(abi.encode(operator, token));
    }

    function bankrollOf(address operator, address token) external view returns (uint256) {
        return ledgers[_ledgerKey(operator, token)].bankroll;
    }

    /// @notice Pull `amount` of `token` from `from` and return the MEASURED delta actually received.
    /// Crediting the delta (not the requested amount) keeps the books exact for fee-on-transfer and
    /// rebasing tokens, and contains any such token to its own bucket.
    function _pullVerified(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balBefore;
    }

    /// @notice Fund an operator's (operator, token) bankroll from msg.sender — the BYO funding source
    /// (EOA, Safe, OperatorVault clone). Anyone may fund any operator; only the measured delta is
    /// credited.
    function depositBankroll(address operator, address token, uint256 amount) external {
        uint256 credited = _pullVerified(token, msg.sender, amount);
        ledgers[_ledgerKey(operator, token)].creditBankroll(credited);
        emit BankrollDeposited(operator, token, msg.sender, credited);
    }

    /// @notice Operator withdraws its own idle bankroll. Debits its (operator, token) ledger only —
    /// locked and rake are untouchable here.
    function withdrawBankroll(address token, uint256 amount) external {
        ledgers[_ledgerKey(msg.sender, token)].debitBankroll(amount);
        token.safeTransfer(msg.sender, amount);
        emit BankrollWithdrawn(msg.sender, token, amount);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: PASS (`EscrowLibTest` 4 + `GameEscrowDepositTest` 3).

- [ ] **Step 5: Commit**

```bash
git add contracts/games/operator/GameEscrow.sol test/foundry/GameEscrow.t.sol
git commit -m "feat(operator): GameEscrow bankroll deposit/withdraw with balance-delta verification"
```

---

## Task 4: GameEscrow — lockExposure (pre-collateralization)

**Files:**
- Modify: `contracts/games/operator/GameEscrow.sol`
- Modify: `test/foundry/GameEscrow.t.sol` (add `GameEscrowLockTest`)

**Interfaces:**
- Consumes: Task 3 escrow, `EscrowLib.lock`.
- Produces:
  - `struct Bet { address game; address operator; address token; address player; uint256 payout; uint256 stake; bool open; }`
  - `bets(bytes32 betId) public view returns (...)` (auto-getter from `mapping(bytes32 => Bet) public bets`)
  - `lockExposure(bytes32 betId, address operator, address token, address player, uint256 stake, uint256 payout) external` — `msg.sender` is the game. Reverts `BetExists` if `bets[betId].open`; reverts `BadPayout` if `payout < stake`. Debits exposure (`payout - stake`) from `(operator, token)` bankroll via `EscrowLib.lock`, then pulls the player's stake via `_pullVerified` and reverts `StakeUnderDelivered` if the measured delta `< stake` (no fee-on-transfer on the stake leg — the game quoted `payout` off `stake`). Records the `Bet`. Emits `ExposureLocked`.
  - `lockedOf(address operator, address token) external view returns (uint256)`
  - errors: `BetExists()`, `BadPayout()`, `StakeUnderDelivered()`

- [ ] **Step 1: Write the failing test**

```solidity
// (append to test/foundry/GameEscrow.t.sol)
contract GameEscrowLockTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;
    address internal op = address(0x0B);
    address internal player = address(0x9E7);
    address internal game;

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        vm.prank(op); reg.register();
        game = address(this); // this test acts as the game
        tok.mint(op, 1000 ether);
        vm.prank(op); tok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.depositBankroll(op, address(tok), 1000 ether);
        tok.mint(player, 100 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
    }

    function test_lock_pullsStake_debitsExposure_holdsPayout() public {
        bytes32 betId = keccak256("b1");
        esc.lockExposure(betId, op, address(tok), player, 10 ether, 19 ether); // exposure 9
        assertEq(esc.bankrollOf(op, address(tok)), 991 ether); // 1000 - 9
        assertEq(esc.lockedOf(op, address(tok)), 19 ether);
        // escrow physically holds bankroll(991) + locked(19) = 1010 = 1000 deposit + 10 stake
        assertEq(tok.balanceOf(address(esc)), 1010 ether);
    }

    function test_lock_revertsWhenBankrollBelowExposure() public {
        bytes32 betId = keccak256("b2");
        vm.expectRevert(EscrowLib.InsufficientBankroll.selector);
        esc.lockExposure(betId, op, address(tok), player, 10 ether, 2000 ether); // exposure 1990 > 1000
    }

    function test_lock_rejectsDuplicateBetId() public {
        bytes32 betId = keccak256("b3");
        esc.lockExposure(betId, op, address(tok), player, 10 ether, 19 ether);
        vm.expectRevert(GameEscrow.BetExists.selector);
        esc.lockExposure(betId, op, address(tok), player, 10 ether, 19 ether);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: FAIL — `lockExposure` / `lockedOf` / `BetExists` undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `GameEscrow` (struct + mapping near the ledgers mapping, errors, and the function):

```solidity
    error BetExists();
    error BadPayout();
    error StakeUnderDelivered();

    struct Bet {
        address game;
        address operator;
        address token;
        address player;
        uint256 payout;
        uint256 stake;
        bool    open;
    }

    mapping(bytes32 betId => Bet) public bets;

    event ExposureLocked(bytes32 indexed betId, address indexed operator, address token, address player, uint256 stake, uint256 payout);

    function lockedOf(address operator, address token) external view returns (uint256) {
        return ledgers[_ledgerKey(operator, token)].locked;
    }

    /// @notice Pre-collateralize a bet. The game calls this at bet-accept: exposure (payout - stake)
    /// is debited from the operator's bankroll (reverting if short — graceful bankruptcy), and the
    /// player's stake is pulled in fresh, balance-delta checked. After this returns, the escrow holds
    /// the FULL payout for this bet, so settlement can never be under-collateralized. The recorded
    /// game is the ONLY address that may settle/refund this bet.
    function lockExposure(
        bytes32 betId,
        address operator,
        address token,
        address player,
        uint256 stake,
        uint256 payout
    ) external {
        if (bets[betId].open) revert BetExists();
        if (payout < stake) revert BadPayout();
        uint256 exposure;
        unchecked { exposure = payout - stake; }

        ledgers[_ledgerKey(operator, token)].lock(exposure, payout);

        uint256 received = _pullVerified(token, player, stake);
        if (received < stake) revert StakeUnderDelivered();

        bets[betId] = Bet({
            game: msg.sender,
            operator: operator,
            token: token,
            player: player,
            payout: payout,
            stake: stake,
            open: true
        });
        emit ExposureLocked(betId, operator, token, player, stake, payout);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: PASS (adds `GameEscrowLockTest` 3).

- [ ] **Step 5: Commit**

```bash
git add contracts/games/operator/GameEscrow.sol test/foundry/GameEscrow.t.sol
git commit -m "feat(operator): GameEscrow.lockExposure pre-collateralizes every bet (balance-delta stake pull)"
```

---

## Task 5: GameEscrow — settle (win/loss + rake) and refund

**Files:**
- Modify: `contracts/games/operator/GameEscrow.sol`
- Modify: `test/foundry/GameEscrow.t.sol` (add `GameEscrowSettleTest`)

**Interfaces:**
- Consumes: Task 4 escrow, `OperatorRegistry.rakeBps`/`rakeRecipientOf`, `EscrowLib.settleWin`/`settleLoss`/`refundExposure`/`takeRake`.
- Produces:
  - `settleWin(bytes32 betId) external` — only `bets[betId].game`; reverts `UnknownBet` if not open. CEI: flip `open=false`, `EscrowLib.settleWin`, then `token.safeTransfer(player, payout)`. Emits `Settled(betId, true, payout, 0)`.
  - `settleLoss(bytes32 betId) external` — only game; computes `rakeAmt = registry.rakeBps(operator, game) * stake / 10000` (rake on the player's forfeited stake), `EscrowLib.settleLoss(payout, rakeAmt)`, no external transfer (funds stay in escrow as bankroll/rake). Emits `Settled(betId, false, 0, rakeAmt)`.
  - `refund(bytes32 betId) external` — only game; `EscrowLib.refundExposure(payout, exposure)`, then `token.safeTransfer(player, stake)`. Emits `Refunded(betId, player, stake)`.
  - `withdrawRake(address token) external` — `msg.sender` is operator; `amt = EscrowLib.takeRake(ledger)`, transfers to `registry.rakeRecipientOf(operator, token)`. Emits `RakeWithdrawn`.
  - errors: `UnknownBet()`, `NotBetGame()`

- [ ] **Step 1: Write the failing test**

```solidity
// (append to test/foundry/GameEscrow.t.sol)
contract GameEscrowSettleTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;
    address internal op = address(0x0B);
    address internal player = address(0x9E7);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        vm.prank(op); reg.register();
        vm.prank(op); reg.setRakeBps(address(this), 200); // 2% rake, this contract is the game
        tok.mint(op, 1000 ether);
        vm.prank(op); tok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.depositBankroll(op, address(tok), 1000 ether);
        tok.mint(player, 100 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
    }

    function _lock(bytes32 id) internal {
        esc.lockExposure(id, op, address(tok), player, 10 ether, 19 ether); // exposure 9
    }

    function test_settleWin_paysPlayerFullPayout() public {
        bytes32 id = keccak256("w");
        _lock(id);
        esc.settleWin(id);
        assertEq(tok.balanceOf(player), 90 ether + 19 ether); // had 100, staked 10, won 19
        assertEq(esc.lockedOf(op, address(tok)), 0);
        assertEq(esc.bankrollOf(op, address(tok)), 991 ether); // exposure gone
    }

    function test_settleLoss_accruesRake_returnsRemainderToBankroll() public {
        bytes32 id = keccak256("l");
        _lock(id);
        esc.settleLoss(id);
        // rake = 2% of stake(10) = 0.2; bankroll = 991 + (19 - 0.2) = 1009.8
        assertEq(esc.bankrollOf(op, address(tok)), 1009.8 ether);
        assertEq(esc.lockedOf(op, address(tok)), 0);
        vm.prank(op);
        esc.withdrawRake(address(tok));
        assertEq(tok.balanceOf(op), 0.2 ether); // rake swept to operator (default recipient)
    }

    function test_refund_returnsStakeToPlayer_exposureToBankroll() public {
        bytes32 id = keccak256("r");
        _lock(id);
        esc.refund(id);
        assertEq(tok.balanceOf(player), 100 ether); // stake fully back
        assertEq(esc.bankrollOf(op, address(tok)), 1000 ether); // exposure restored
        assertEq(esc.lockedOf(op, address(tok)), 0);
    }

    function test_settle_onlyRecordedGame() public {
        bytes32 id = keccak256("g");
        _lock(id);
        vm.prank(address(0xBAD));
        vm.expectRevert(GameEscrow.NotBetGame.selector);
        esc.settleWin(id);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: FAIL — `settleWin` etc. undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `GameEscrow`:

```solidity
    error UnknownBet();
    error NotBetGame();

    event Settled(bytes32 indexed betId, bool playerWon, uint256 paidToPlayer, uint256 rake);
    event Refunded(bytes32 indexed betId, address indexed player, uint256 stake);
    event RakeWithdrawn(address indexed operator, address indexed token, address recipient, uint256 amount);

    function _openBet(bytes32 betId) internal view returns (Bet storage b) {
        b = bets[betId];
        if (!b.open) revert UnknownBet();
        if (b.game != msg.sender) revert NotBetGame();
    }

    function settleWin(bytes32 betId) external {
        Bet storage b = _openBet(betId);
        b.open = false; // effects before interaction
        ledgers[_ledgerKey(b.operator, b.token)].settleWin(b.payout);
        b.token.safeTransfer(b.player, b.payout);
        emit Settled(betId, true, b.payout, 0);
    }

    function settleLoss(bytes32 betId) external {
        Bet storage b = _openBet(betId);
        b.open = false;
        uint16 bps = OperatorRegistry(registry).rakeBps(b.operator, b.game);
        uint256 rakeAmt = uint256(b.stake) * bps / 10000;
        ledgers[_ledgerKey(b.operator, b.token)].settleLoss(b.payout, rakeAmt);
        emit Settled(betId, false, 0, rakeAmt);
    }

    function refund(bytes32 betId) external {
        Bet storage b = _openBet(betId);
        b.open = false;
        uint256 exposure;
        unchecked { exposure = b.payout - b.stake; }
        ledgers[_ledgerKey(b.operator, b.token)].refundExposure(b.payout, exposure);
        b.token.safeTransfer(b.player, b.stake);
        emit Refunded(betId, b.player, b.stake);
    }

    function withdrawRake(address token) external {
        uint256 amt = ledgers[_ledgerKey(msg.sender, token)].takeRake();
        address recipient = OperatorRegistry(registry).rakeRecipientOf(msg.sender, token);
        token.safeTransfer(recipient, amt);
        emit RakeWithdrawn(msg.sender, token, recipient, amt);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: PASS (adds `GameEscrowSettleTest` 4).

- [ ] **Step 5: Commit**

```bash
git add contracts/games/operator/GameEscrow.sol test/foundry/GameEscrow.t.sol
git commit -m "feat(operator): GameEscrow settle (win/loss+rake) and refund, game-authorized"
```

---

## Task 6: OperatorBond — protocol-held accountability bond

**Files:**
- Create: `contracts/games/operator/OperatorBond.sol`
- Test: `test/foundry/OperatorBond.t.sol`

**Interfaces:**
- Consumes: `SafeTransferLib`.
- Produces:
  - `constructor(address registry_)` — stores `registry` (for future game-authorization checks; slice A trusts any caller-supplied `game` recorded per-slash, see below).
  - `bondOf(address operator, address token) external view returns (uint256 total, uint256 locked)`
  - `postBond(address operator, address token, uint256 amount) external` — balance-delta pull from `msg.sender`, credits `(operator, token)` bond total. Emits `BondPosted`.
  - `withdrawBond(address token, uint256 amount) external` — operator withdraws from its own free bond (`total - locked`); reverts `BondLocked` if `amount > free`. Emits `BondWithdrawn`.
  - `slashToPlayer(address operator, address token, address player, uint256 amount) external` — callable by any contract acting as an adjudicating game; caps at free bond, reduces total, transfers to player. Emits `BondSlashed(operator, token, msg.sender, player, amount)`. (The load-bearing dispute-lock wiring is slice D; slice A ships post/withdraw/slash as the substrate primitive so operators are genuinely bonded from day one.)
  - errors: `BondLocked()`, `InsufficientBond()`

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorBond} from "../../contracts/games/operator/OperatorBond.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

contract OperatorBondTest is Test {
    OperatorBond internal bond;
    ERC20 internal tok;
    address internal op = address(0x0B);
    address internal player = address(0x9E7);

    function setUp() public {
        bond = new OperatorBond(address(new OperatorRegistry()));
        tok = new ERC20(false);
        tok.mint(address(this), 100 ether);
        tok.approve(address(bond), type(uint256).max);
    }

    function test_post_and_withdraw() public {
        bond.postBond(op, address(tok), 50 ether);
        (uint256 total, uint256 locked) = bond.bondOf(op, address(tok));
        assertEq(total, 50 ether); assertEq(locked, 0);
        vm.prank(op);
        bond.withdrawBond(address(tok), 20 ether);
        (total,) = bond.bondOf(op, address(tok));
        assertEq(total, 30 ether);
        assertEq(tok.balanceOf(op), 20 ether);
    }

    function test_slashToPlayer_paysPlayer_reducesTotal() public {
        bond.postBond(op, address(tok), 50 ether);
        bond.slashToPlayer(op, address(tok), player, 15 ether); // this contract is the "game"
        (uint256 total,) = bond.bondOf(op, address(tok));
        assertEq(total, 35 ether);
        assertEq(tok.balanceOf(player), 15 ether);
    }

    function test_slash_cappedAtFreeBond() public {
        bond.postBond(op, address(tok), 10 ether);
        vm.expectRevert(OperatorBond.InsufficientBond.selector);
        bond.slashToPlayer(op, address(tok), player, 11 ether);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/OperatorBond.t.sol' -vv`
Expected: FAIL — source not found.

- [ ] **Step 3: Write minimal implementation**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";

/// @notice Protocol-held per-(operator, token) accountability bond, separate from the funding vault so
/// a harmed player can always be made whole regardless of operator behavior. Slice A ships the custody
/// primitive: operators post/withdraw-when-idle, and an adjudicating game may slash a capped amount to
/// a harmed player. The dispute-LOCK path (freezing bond while a dispute is open) is wired in slice D,
/// where the N-party residual makes it load-bearing; until then `locked` stays 0 and free == total.
contract OperatorBond {
    using SafeTransferLib for address;

    error BondLocked();
    error InsufficientBond();

    address public immutable registry;

    struct Bond { uint256 total; uint256 locked; }
    mapping(bytes32 key => Bond) internal bonds;

    event BondPosted(address indexed operator, address indexed token, address indexed from, uint256 credited);
    event BondWithdrawn(address indexed operator, address indexed token, uint256 amount);
    event BondSlashed(address indexed operator, address indexed token, address game, address player, uint256 amount);

    constructor(address registry_) { registry = registry_; }

    function _key(address operator, address token) internal pure returns (bytes32) {
        return keccak256(abi.encode(operator, token));
    }

    function bondOf(address operator, address token) external view returns (uint256 total, uint256 locked) {
        Bond storage b = bonds[_key(operator, token)];
        return (b.total, b.locked);
    }

    function postBond(address operator, address token, uint256 amount) external {
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 credited = token.balanceOf(address(this)) - balBefore;
        bonds[_key(operator, token)].total += credited;
        emit BondPosted(operator, token, msg.sender, credited);
    }

    function withdrawBond(address token, uint256 amount) external {
        Bond storage b = bonds[_key(msg.sender, token)];
        uint256 free = b.total - b.locked;
        if (amount > free) revert BondLocked();
        b.total -= amount;
        token.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, token, amount);
    }

    function slashToPlayer(address operator, address token, address player, uint256 amount) external {
        Bond storage b = bonds[_key(operator, token)];
        uint256 free = b.total - b.locked;
        if (amount > free) revert InsufficientBond();
        b.total -= amount;
        token.safeTransfer(player, amount);
        emit BondSlashed(operator, token, msg.sender, player, amount);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-path 'test/foundry/OperatorBond.t.sol' -vv`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add contracts/games/operator/OperatorBond.sol test/foundry/OperatorBond.t.sol
git commit -m "feat(operator): OperatorBond protocol-held accountability bond (post/withdraw/slash)"
```

---

## Task 7: OperatorVault — default cloneable funding vault

**Files:**
- Create: `contracts/games/operator/OperatorVault.sol`
- Test: `test/foundry/OperatorVault.t.sol`

**Interfaces:**
- Consumes: `SafeTransferLib`, `GameEscrow.depositBankroll`.
- Produces: an EIP-1167-cloneable minimal vault holding an operator's capital and funding the escrow on demand. Uses an `initialize`-style setter (clones can't run constructors).
  - `initialize(address owner_, address escrow_) external` — one-shot; reverts `AlreadyInit` if re-called.
  - `owner() / escrow()` public getters (state vars).
  - `fund(address token, uint256 amount) external` — only owner; approves escrow for `amount` and calls `GameEscrow.depositBankroll(owner, token, amount)` (vault's own balance is the source; must be pre-funded by a plain transfer in). Emits `Funded`.
  - `sweep(address token, uint256 amount) external` — only owner; transfers idle vault balance back to owner. Emits `Swept`.
  - errors: `AlreadyInit()`, `NotOwner()`
  - A factory helper `OperatorVaultFactory` is out of scope; the deploy script (Task 11) clones via Solady `LibClone.clone(impl)` + `initialize`. This task delivers the implementation contract + a direct (non-clone) test.

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorVault} from "../../contracts/games/operator/OperatorVault.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

contract OperatorVaultTest is Test {
    OperatorVault internal vault;
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;
    address internal op = address(0x0B);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        vm.prank(op); reg.register();
        vault = new OperatorVault();
        vault.initialize(op, address(esc));
        tok.mint(address(vault), 500 ether); // pre-fund the vault
    }

    function test_fund_depositsToEscrowUnderOwnerBucket() public {
        vm.prank(op);
        vault.fund(address(tok), 300 ether);
        assertEq(esc.bankrollOf(op, address(tok)), 300 ether);
        assertEq(tok.balanceOf(address(vault)), 200 ether);
    }

    function test_initialize_isOneShot() public {
        vm.expectRevert(OperatorVault.AlreadyInit.selector);
        vault.initialize(op, address(esc));
    }

    function test_fund_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(OperatorVault.NotOwner.selector);
        vault.fund(address(tok), 1 ether);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/OperatorVault.t.sol' -vv`
Expected: FAIL — source not found.

- [ ] **Step 3: Write minimal implementation**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {GameEscrow} from "./GameEscrow.sol";

/// @notice Minimal EIP-1167-cloneable default funding vault. Holds an operator's capital and funds the
/// GameEscrow bankroll on demand. BYO funding stays first-class — this is a convenience for onboarding,
/// not a required path. Clones share this implementation's code and run initialize() in place of a
/// constructor.
contract OperatorVault {
    using SafeTransferLib for address;

    error AlreadyInit();
    error NotOwner();

    address public owner;
    address public escrow;

    event Funded(address indexed token, uint256 amount);
    event Swept(address indexed token, uint256 amount);

    function initialize(address owner_, address escrow_) external {
        if (owner != address(0)) revert AlreadyInit();
        owner = owner_;
        escrow = escrow_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Move `amount` of the vault's own `token` balance into the escrow's bankroll under the
    /// owner's (owner, token) bucket. The escrow pulls via transferFrom, so approve it first.
    function fund(address token, uint256 amount) external onlyOwner {
        token.safeApprove(escrow, amount);
        GameEscrow(escrow).depositBankroll(owner, token, amount);
        emit Funded(token, amount);
    }

    function sweep(address token, uint256 amount) external onlyOwner {
        token.safeTransfer(owner, amount);
        emit Swept(token, amount);
    }
}
```

Note: `SafeTransferLib.safeApprove` exists in Solady. If a strict-approval token reverts on non-zero→non-zero, use `safeApproveWithRetry`; the plain test token is fine with `safeApprove`.

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-path 'test/foundry/OperatorVault.t.sol' -vv`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add contracts/games/operator/OperatorVault.sol test/foundry/OperatorVault.t.sol
git commit -m "feat(operator): OperatorVault cloneable default funding vault"
```

---

## Task 8: OperatorCoinFlip — escrow-backed reference game

**Files:**
- Create: `contracts/games/operator/OperatorCoinFlip.sol`
- Test: `test/foundry/OperatorCoinFlip.t.sol`

**Interfaces:**
- Consumes: `GameBase` (validator heat/onCast settle, `_heatBound`, `_validateSubset`, `_seed`, `_refundableNow`), `GameEscrow` (Tasks 3–5), `OperatorRegistry` (Task 2), `PreimageLocation`.
- Produces:
  - `constructor(address random_, address escrow_, address registry_) GameBase(random_)`
  - `struct Table { address operator; address token; uint16 maxMultiplierX100; uint256 maxStake; bool open; }`
  - `tables(bytes32 tableId) public view returns (...)`
  - `createTable(address token, uint16 maxMultiplierX100, uint256 maxStake) external returns (bytes32 tableId)` — `msg.sender` must be `registry.registered`; multiplier bounded `[150, 200]`. Table's operator = msg.sender.
  - `setOpen(bytes32 tableId, bool) external` — operator only.
  - `open(bytes32 tableId, uint8 side, uint256 stake, address[] calldata validatorSubset, PreimageLocation.Info[] calldata locs) external returns (bytes32 roundId)` — computes `payout = stake * mult / 100`, calls `GameEscrow.lockExposure(roundId, operator, token, msg.sender, stake, payout)` (escrow pulls the player's stake — player approves the ESCROW, not the game), heats validators, records the round, sets `instanceByKey[key] = roundId`.
  - `_settle(bytes32 roundId, bytes32 seed) internal override` — parity `uint8(uint256(seed) & 1) == side` → `GameEscrow.settleWin(roundId)` else `settleLoss(roundId)`.
  - `claim(bytes32 roundId) external` — pull-fallback: require seed finalized, then `_settle`.
  - `refundStale(bytes32 roundId) external` — require seed still missing and refundable, then `GameEscrow.refund(roundId)`. This is the **validator-abort resolution**: the player's stake always returns from pre-locked capital; the operator's exposure returns to its bankroll; no free-roll.
  - errors: `NotRegisteredOperator()`, `NotOperator()`, `BadMultiplier()`, `TableClosed()`, `WrongSide()`, `ZeroStake()`, `StakeTooHigh()`, `AlreadyResolved()`, `TooEarly()`
  - Round status enum `{ None, Pending, Settled, Refunded }`; `mapping(bytes32 => Round) public rounds` with `Round { bytes32 tableId; address player; uint8 side; uint256 stake; uint256 payout; bytes32 key; uint256 openedAtBlock; Status status; }`.

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorCoinFlip} from "../../contracts/games/operator/OperatorCoinFlip.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {MockRandom} from "./MockRandom.sol";

contract OperatorCoinFlipTest is Test {
    OperatorCoinFlip internal game;
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    MockRandom internal rnd;
    ERC20 internal tok;
    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    address internal op = address(0x0B);
    address internal player = address(0x9E7);
    uint16 internal constant MULT = 196; // 1.96x
    uint256 internal constant MAX_STAKE = 100 ether;

    function setUp() public {
        rnd = new MockRandom();
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        game = new OperatorCoinFlip(address(rnd), address(esc), address(reg));
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x3000 + i));
            game.addValidator(v);
            subset.push(v);
            locs.push(PreimageLocation.Info({
                provider: v, callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(0), price: 0, offset: 0, index: 0
            }));
        }
        vm.prank(op); reg.register();
        // operator funds bankroll into the escrow
        tok.mint(op, 1000 ether);
        vm.prank(op); tok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.depositBankroll(op, address(tok), 1000 ether);
        // player approves the ESCROW (custodian), not the game
        tok.mint(player, 100 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
    }

    function _open(uint8 side) internal returns (bytes32 roundId, bytes32 key) {
        bytes32 tableId = _table();
        vm.prank(player);
        roundId = game.open(tableId, side, 10 ether, subset, locs);
        (,,,,, key,,) = game.rounds(roundId);
    }

    function _table() internal returns (bytes32 tableId) {
        vm.prank(op);
        tableId = game.createTable(address(tok), MULT, MAX_STAKE);
    }

    function test_open_locksExposure_pullsStakeToEscrow() public {
        (bytes32 roundId,) = _open(0);
        assertEq(esc.lockedOf(op, address(tok)), 19.6 ether); // payout of 10 @ 1.96
        assertEq(tok.balanceOf(player), 90 ether);
        assertGt(uint256(roundId), 0);
    }

    function test_settle_win_paysPlayerFromEscrow() public {
        (bytes32 roundId, bytes32 key) = _open(0); // player picks HEADS (0)
        rnd.pushCast(address(game), key, bytes32(uint256(0))); // even → HEADS → player wins
        assertEq(tok.balanceOf(player), 90 ether + 19.6 ether);
        assertEq(esc.lockedOf(op, address(tok)), 0);
    }

    function test_settle_loss_returnsToBankroll() public {
        (bytes32 roundId, bytes32 key) = _open(0);
        rnd.pushCast(address(game), key, bytes32(uint256(1))); // odd → TAILS → player loses
        assertEq(tok.balanceOf(player), 90 ether); // stake stays lost
        assertEq(esc.lockedOf(op, address(tok)), 0);
        assertGt(esc.bankrollOf(op, address(tok)), 1000 ether); // operator gained
    }

    function test_refundStale_returnsStake_afterTimeout_validatorAbort() public {
        (bytes32 roundId,) = _open(0);
        vm.roll(block.number + 201); // past STALE_BLOCKS (200), no seed finalized
        game.refundStale(roundId);
        assertEq(tok.balanceOf(player), 100 ether);       // player made whole — no free-roll
        assertEq(esc.bankrollOf(op, address(tok)), 1000 ether); // operator exposure restored
    }

    function test_createTable_requiresRegisteredOperator() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(OperatorCoinFlip.NotRegisteredOperator.selector);
        game.createTable(address(tok), MULT, MAX_STAKE);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/OperatorCoinFlip.t.sol' -vv`
Expected: FAIL — `OperatorCoinFlip` source not found.

- [ ] **Step 3: Write minimal implementation**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameBase} from "../GameBase.sol";
import {PreimageLocation} from "../PreimageLocation.sol";
import {GameEscrow} from "./GameEscrow.sol";
import {OperatorRegistry} from "./OperatorRegistry.sol";

/// @notice Escrow-backed coin flip — the slice-A reference game. Identical parity mechanics to
/// CoinFlipTables, but every chip lives in GameEscrow (token-agnostic, pre-collateralized) and every
/// table belongs to a registered operator. The operator supplies bankroll and cannot touch the coin;
/// the substrate guarantees the player is paid on a win and refunded on a validator abort, from
/// pre-locked capital. This wiring resolves the CoinFlip validator-abort free-roll: refundStale
/// returns the player's stake from escrow and the operator's exposure to its bankroll — never a split,
/// never a steal.
contract OperatorCoinFlip is GameBase {
    error NotRegisteredOperator();
    error NotOperator();
    error BadMultiplier();
    error TableClosed();
    error WrongSide();
    error ZeroStake();
    error StakeTooHigh();
    error AlreadyResolved();
    error TooEarly();

    uint16 internal constant MULT_MIN = 150;
    uint16 internal constant MULT_MAX = 200;
    uint8 internal constant TAILS = 1;

    enum Status { None, Pending, Settled, Refunded }

    struct Table {
        address operator;
        address token;
        uint16  maxMultiplierX100;
        uint256 maxStake;
        bool    open;
    }

    struct Round {
        bytes32 tableId;
        address player;
        uint8   side;
        uint256 stake;
        uint256 payout;
        bytes32 key;
        uint256 openedAtBlock;
        Status  status;
    }

    address public immutable escrow;
    address public immutable registry;

    mapping(bytes32 tableId => Table) public tables;
    mapping(bytes32 roundId => Round) public rounds;
    uint256 internal _tableNonce;
    uint256 internal _roundNonce;

    event TableCreated(bytes32 indexed tableId, address indexed operator, address indexed token, uint16 maxMultiplierX100, uint256 maxStake);
    event OpenSet(bytes32 indexed tableId, bool open);
    event RoundOpened(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint8 side, uint256 stake, uint256 payout, bytes32 key, uint256 openedAtBlock);
    event RoundSettled(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, bool won, uint256 payout, bytes32 seed);
    event RoundRefunded(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint256 stake);

    constructor(address random_, address escrow_, address registry_) GameBase(random_) {
        escrow = escrow_;
        registry = registry_;
    }

    modifier onlyOperator(bytes32 tableId) {
        if (tables[tableId].operator != msg.sender) revert NotOperator();
        _;
    }

    function createTable(address token, uint16 maxMultiplierX100, uint256 maxStake) external returns (bytes32 tableId) {
        if (!OperatorRegistry(registry).registered(msg.sender)) revert NotRegisteredOperator();
        if (maxMultiplierX100 < MULT_MIN || maxMultiplierX100 > MULT_MAX) revert BadMultiplier();
        tableId = keccak256(abi.encode(address(this), msg.sender, ++_tableNonce));
        tables[tableId] = Table({operator: msg.sender, token: token, maxMultiplierX100: maxMultiplierX100, maxStake: maxStake, open: true});
        emit TableCreated(tableId, msg.sender, token, maxMultiplierX100, maxStake);
    }

    function setOpen(bytes32 tableId, bool isOpen) external onlyOperator(tableId) {
        tables[tableId].open = isOpen;
        emit OpenSet(tableId, isOpen);
    }

    function open(
        bytes32 tableId,
        uint8 side,
        uint256 stake,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) external returns (bytes32 roundId) {
        Table storage t = tables[tableId];
        if (t.operator == address(0)) revert TableClosed();
        if (!t.open) revert TableClosed();
        if (side > TAILS) revert WrongSide();
        if (stake == 0) revert ZeroStake();
        if (stake > t.maxStake) revert StakeTooHigh();
        _validateSubset(validatorSubset);

        uint256 payout = stake * t.maxMultiplierX100 / 100;
        bytes32 key = _heatBound(validatorSubset, validatorLocations);
        roundId = keccak256(abi.encode(address(this), ++_roundNonce, tableId, msg.sender));

        // custody lives in the escrow: it pulls the player's stake (player approves the escrow) and
        // debits the operator's exposure from its bankroll — reverting if the operator is short.
        GameEscrow(escrow).lockExposure(roundId, t.operator, t.token, msg.sender, stake, payout);

        rounds[roundId] = Round({
            tableId: tableId, player: msg.sender, side: side, stake: stake, payout: payout,
            key: key, openedAtBlock: block.number, status: Status.Pending
        });
        instanceByKey[key] = roundId;
        emit RoundOpened(roundId, tableId, msg.sender, side, stake, payout, key, block.number);
    }

    function _settle(bytes32 roundId, bytes32 seed) internal override {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        r.status = Status.Settled;
        bool won = uint8(uint256(seed) & 1) == r.side;
        if (won) {
            GameEscrow(escrow).settleWin(roundId);
        } else {
            GameEscrow(escrow).settleLoss(roundId);
        }
        emit RoundSettled(roundId, r.tableId, r.player, won, r.payout, seed);
    }

    function claim(bytes32 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        bytes32 seed = _seed(r.key);
        if (seed == bytes32(0)) revert TooEarly();
        _settle(roundId, seed);
    }

    function refundStale(bytes32 roundId) external {
        Round storage r = rounds[roundId];
        if (r.status != Status.Pending) revert AlreadyResolved();
        if (_seed(r.key) != bytes32(0)) revert TooEarly();
        if (!_refundableNow(roundId, r.openedAtBlock)) revert TooEarly();
        r.status = Status.Refunded;
        GameEscrow(escrow).refund(roundId);
        emit RoundRefunded(roundId, r.tableId, r.player, r.stake);
    }
}
```

Note on `MockRandom`: `test/foundry/MockRandom.sol` already provides `pushCast(address consumer, bytes32 key, bytes32 seed)` and the `heat`/`randomness` surface `GameBase` calls (it's used by `CoinFlipTables.t.sol`). No changes needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `forge test --match-path 'test/foundry/OperatorCoinFlip.t.sol' -vv`
Expected: PASS (5 tests) — including `test_refundStale_...` proving the validator-abort resolution.

- [ ] **Step 5: Commit**

```bash
git add contracts/games/operator/OperatorCoinFlip.sol test/foundry/OperatorCoinFlip.t.sol
git commit -m "feat(operator): OperatorCoinFlip escrow-backed reference game (resolves validator-abort free-roll)"
```

---

## Task 9: Conservation + isolation invariants

**Files:**
- Create: `test/foundry/GameEscrowInvariant.t.sol`
- Create: `contracts/test/EscrowHandler.sol` (invariant handler that drives deposit/lock/settle/refund with bounded fuzz inputs across two operators and two tokens)

**Interfaces:**
- Consumes: `GameEscrow`, `OperatorRegistry`, `ERC20`, `ReenteringToken`.
- Produces: an invariant suite asserting the non-negotiable money properties.

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {EscrowHandler} from "../../contracts/test/EscrowHandler.sol";

/// @notice The load-bearing substrate invariants:
///   (I1) SOLVENCY: for every (operator, token), bankroll + locked + rake <= token.balanceOf(escrow)
///        summed across that token's buckets — the escrow can always pay what it owes.
///   (I2) ISOLATION: a hostile/fee-on-transfer token in one bucket never reduces another bucket's
///        recorded balance below what its own token backs.
contract GameEscrowInvariantTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tokA;
    ERC20 internal tokB;
    EscrowHandler internal handler;

    address internal opX = address(0xA1);
    address internal opY = address(0xA2);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tokA = new ERC20(false);
        tokB = new ERC20(false);
        vm.prank(opX); reg.register();
        vm.prank(opY); reg.register();
        handler = new EscrowHandler(esc, reg, tokA, tokB, opX, opY);
        targetContract(address(handler));
    }

    /// I1 — per (operator, token) the escrow physically holds at least what the ledger claims.
    function invariant_solvencyPerBucket() public view {
        assertLe(
            esc.bankrollOf(opX, address(tokA)) + esc.lockedOf(opX, address(tokA)),
            tokA.balanceOf(address(esc))
        );
        assertLe(
            esc.bankrollOf(opY, address(tokB)) + esc.lockedOf(opY, address(tokB)),
            tokB.balanceOf(address(esc))
        );
    }

    /// I2 — the sum of all tokA ledger claims never exceeds the escrow's tokA balance, regardless of
    /// what happens in tokB buckets (cross-token isolation).
    function invariant_tokenIsolation() public view {
        uint256 claimsA =
            esc.bankrollOf(opX, address(tokA)) + esc.lockedOf(opX, address(tokA)) +
            esc.bankrollOf(opY, address(tokA)) + esc.lockedOf(opY, address(tokA));
        assertLe(claimsA, tokA.balanceOf(address(esc)));
    }
}
```

The `EscrowHandler` mints/approves for both operators and a pool of players, then exposes bounded `deposit`, `lock`, `settleWin`, `settleLoss`, `refund` actions (tracking open betIds so it only settles live ones). Keep it under ~120 lines; model it on the existing `test/foundry` invariant handlers (e.g. the `ZkTableHandler` / `CoinFlipTablesInvariant` patterns).

- [ ] **Step 2: Run test to verify it fails**

Run: `forge test --match-path 'test/foundry/GameEscrowInvariant.t.sol' -vv`
Expected: FAIL — `EscrowHandler` not found (until you write it), then run to green once implemented.

- [ ] **Step 3: Write the handler + make invariants pass**

Implement `contracts/test/EscrowHandler.sol` with the bounded actions described in the Interfaces block. Wire real approvals in its constructor. The invariants should hold by construction of Tasks 3–5; if one fails, the failing sequence is a real accounting bug — fix the contract, not the invariant.

- [ ] **Step 4: Run to verify it passes**

Run: `forge test --match-path 'test/foundry/GameEscrowInvariant.t.sol' -vv`
Expected: PASS — both invariants hold over `runs = 256, depth = 64`.

- [ ] **Step 5: Commit**

```bash
git add test/foundry/GameEscrowInvariant.t.sol contracts/test/EscrowHandler.sol
git commit -m "test(operator): GameEscrow solvency + cross-token isolation invariants"
```

---

## Task 10: Reentrancy defense proof (hostile escrow token)

**Files:**
- Modify: `test/foundry/GameEscrow.t.sol` (add `GameEscrowReentrancyTest`)

**Interfaces:**
- Consumes: `GameEscrow`, `ReenteringToken` (existing mock — its `transfer` can be armed to re-enter an arbitrary target mid-transfer).

- [ ] **Step 1: Write the failing/[proving] test**

```solidity
// (append to test/foundry/GameEscrow.t.sol)
import {ReenteringToken} from "../../contracts/test/ReenteringToken.sol";

contract GameEscrowReentrancyTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ReenteringToken internal rtok;
    address internal op = address(0x0B);
    address internal player = address(0x9E7);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        rtok = new ReenteringToken();
        vm.prank(op); reg.register();
        rtok.mint(op, 1000 ether);
        vm.prank(op); esc.depositBankroll(op, address(rtok), 1000 ether); // ReenteringToken.transferFrom path
    }

    /// @notice CEI proof: settleWin flips the bet closed and zeroes `locked` BEFORE the payout
    /// transfer. Arm the token to re-enter settleWin on the SAME betId during payout; the reentrant
    /// call must revert UnknownBet (bet already closed), so no double payout is possible.
    function test_settleWin_isReentrancySafe() public {
        rtok.mint(player, 100 ether);
        // player "approves" via the mock's balance model; lockExposure pulls stake
        bytes32 betId = keccak256("re");
        // arm re-entry to call settleWin(betId) again mid-transfer
        rtok.arm(address(esc), abi.encodeWithSelector(GameEscrow.settleWin.selector, betId));
        vm.prank(address(this)); // this contract acts as the game
        esc.lockExposure(betId, op, address(rtok), player, 10 ether, 19 ether);
        esc.settleWin(betId);
        // the reentrant settleWin must have reverted (caught by the token), leaving exactly one payout
        assertEq(esc.lockedOf(op, address(rtok)), 0);
        assertEq(rtok.lastReentryReverted(), true);
    }
}
```

(Match the exact `arm` / `lastReentryReverted` surface `ReenteringToken` exposes — read the mock first and adapt selector/args names to it. If its arming method differs, use its real signature; the assertion is that the reentrant settle reverts and no second payout leaves.)

- [ ] **Step 2: Run test to verify behavior**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: PASS — reentrant settle reverts `UnknownBet`; single payout only. If it FAILS with a double-spend, that's a real CEI bug in Task 5 — fix `settleWin`/`settleLoss`/`refund` to flip `open=false` before any transfer (already the case) and re-run.

- [ ] **Step 3: (only if needed) fix CEI ordering**

If the test surfaced a reentrancy hole, ensure every settle/refund path sets `b.open = false` and mutates the ledger before the `safeTransfer`. No reentrancy guard is added (it would block the claim retry after a swallowed onCast — same rationale as `CoinFlipTables._settle`).

- [ ] **Step 4: Run to verify it passes**

Run: `forge test --match-path 'test/foundry/GameEscrow.t.sol' -vv`
Expected: PASS (all `GameEscrow.t.sol` suites).

- [ ] **Step 5: Commit**

```bash
git add test/foundry/GameEscrow.t.sol
git commit -m "test(operator): prove GameEscrow settle/refund reentrancy-safe against hostile token"
```

---

## Task 11: MCOPY/shanghai deployability gate + full-suite green

**Files:**
- Create: `test/foundry/OperatorSubstrateSize.t.sol` (deployed-size guards for each new contract, mirroring `HoldemTableNSize.t.sol`)
- No production changes expected unless a scan trips.

**Interfaces:**
- Consumes: all new contracts.

- [ ] **Step 1: Build all new artifacts and opcode-scan for MCOPY**

Run:
```bash
forge build
# MCOPY is opcode 0x5e. Scan each new deployed bytecode object; any hit means the artifact will
# revert on-chain on 943/369 (pre-Cancun). Expect ZERO hits under solc 0.8.25 + evm_version=shanghai.
for c in EscrowLib OperatorRegistry GameEscrow OperatorBond OperatorVault OperatorCoinFlip; do
  echo -n "$c MCOPY(5e) count: "
  jq -r '.deployedBytecode.object' "forge-out/$c.sol/$c.json" 2>/dev/null \
    | grep -o '5e' | wc -l
done
```
Expected: the scan confirms shanghai (the profile already pins `evm_version = shanghai`). A raw `grep '5e'` over hex is a coarse proxy (it also matches PUSH data), so the authoritative check is `evm_version` + a size/deploy dry-run; treat any surprising nonzero as a prompt to disassemble with `cast disassemble` and confirm no genuine `MCOPY` mnemonic. Document the result.

- [ ] **Step 2: Write the size guard test**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorBond} from "../../contracts/games/operator/OperatorBond.sol";
import {OperatorVault} from "../../contracts/games/operator/OperatorVault.sol";
import {OperatorCoinFlip} from "../../contracts/games/operator/OperatorCoinFlip.sol";

/// @notice EIP-170 deployability guard: every new substrate contract must stay under the 24,300-byte
/// safety margin (hard limit 24,576) so it deploys on 943/369.
contract OperatorSubstrateSizeTest is Test {
    function test_deployedSizesUnderCeiling() public {
        assertLt(address(new OperatorRegistry()).code.length, 24_300, "registry");
        OperatorRegistry reg = new OperatorRegistry();
        assertLt(address(new GameEscrow(address(reg))).code.length, 24_300, "escrow");
        assertLt(address(new OperatorBond(address(reg))).code.length, 24_300, "bond");
        assertLt(address(new OperatorVault()).code.length, 24_300, "vault");
        assertLt(address(new OperatorCoinFlip(address(0xR), address(0xE), address(reg))).code.length, 24_300, "game");
    }
}
```

(Replace `address(0xR)`/`address(0xE)` with valid literals, e.g. `address(1)`/`address(2)` — the constructor stores them without calling.)

- [ ] **Step 3: Run the size guard + the whole default suite**

Run:
```bash
forge test --match-path 'test/foundry/OperatorSubstrateSize.t.sol' -vv
forge test   # full default profile — confirm nothing else broke
```
Expected: size guard PASS; full default suite PASS (the substrate is import-isolated; existing suites unaffected).

- [ ] **Step 4: Confirm the special profiles still build**

Run (these profiles compile disjoint subsets — the substrate must not have leaked into them):
```bash
FOUNDRY_PROFILE=ffi forge build
FOUNDRY_PROFILE=zkm2 forge build
```
Expected: both build clean.

- [ ] **Step 5: Commit**

```bash
git add test/foundry/OperatorSubstrateSize.t.sol
git commit -m "test(operator): EIP-170 deployability guard + MCOPY/shanghai scan for substrate"
```

---

## Task 12: 943 deploy script + address doc

**Files:**
- Create: `contracts/deploy/deploy-operator-substrate.mts` (or match the repo's existing deploy-script convention — check `games/contracts` for the pattern used by the current CoinFlipTables deploy before writing).
- Create: `docs/superpowers/specs/2026-08-09-operator-substrate-addresses.md` (addresses stub, filled after deploy).

**Interfaces:**
- Consumes: all deployed contracts + the existing 943 deploy tooling (`valve_deployer` key via `op read op://valve/valve_deployer/pk`, legacy type-0 fee per the 943 gas trap — see the faucet memory).

- [ ] **Step 1: Inspect the existing deploy convention**

Read how CoinFlipTables was deployed to 943 (grep the repo for its deploy script / `deployment.json` handling). Match that convention exactly — including the **legacy/dynamic fee** handling (943 node gas quote is bogus; use the baseFee-derived fee, never `eth_gasPrice`). No new pattern.

- [ ] **Step 2: Write the deploy script**

Deploy order: `OperatorRegistry` → `GameEscrow(registry)` → `OperatorBond(registry)` → `OperatorVault` (implementation, for cloning) → `OperatorCoinFlip(random_943, escrow, registry)`. Then `addValidator` for the existing 943 validator set (reuse the CoinFlipTables validator list). Write all addresses to the chain deployment JSON the indexer/web read (match the existing `<chain>-deployment.json` shape).

- [ ] **Step 3: Deploy to 943**

Run the script against 943. Verify each contract's code is present (`cast code <addr>`), the registry `register()` works for a test operator, and `OperatorCoinFlip.createTable` + `open` succeed with a funded bankroll (a single manual round end-to-end).

- [ ] **Step 4: Record addresses**

Fill `docs/superpowers/specs/2026-08-09-operator-substrate-addresses.md` with block number + addresses. Update the memory file `table-maintainer-substrate-design.md` with the deployed 943 addresses.

- [ ] **Step 5: Commit**

```bash
git add contracts/deploy/deploy-operator-substrate.mts docs/superpowers/specs/2026-08-09-operator-substrate-addresses.md
git commit -m "chore(operator): 943 deploy script + address record for the operator substrate"
```

---

## Task 13: Bots play adversarial rounds on 943

**Files:**
- Modify: the existing games session-bot config (find the bot runner that plays `CoinFlipTables` on 943 and add an `OperatorCoinFlip` table) — check `games/house-service` / the bot actor config referenced in memory `games-randomness-caster-and-config-sync`.

**Interfaces:**
- Consumes: the deployed 943 substrate + the existing validator caster/settlement pipeline.

- [ ] **Step 1: Stand up a test operator table on 943**

Register an operator, deploy an `OperatorVault` clone (or fund the escrow bankroll directly), create an `OperatorCoinFlip` table with a real ERC-20 (use Chips on 943), open the table.

- [ ] **Step 2: Point bots at the table + run many rounds**

Have the session bots open rounds (both sides), let the validator caster finalize seeds, and confirm push-settle pays winners and accrues operator wins/rake.

- [ ] **Step 3: Drive the pathological paths**

- Open a round and withhold validator casts past `STALE_BLOCKS` → `refundStale` returns the player's stake and restores operator exposure (validator-abort resolution, live).
- Drain an operator's bankroll below exposure → `open` reverts `InsufficientBankroll` (graceful bankruptcy: the table stops taking bets, nobody is short).
- Attempt a settle from a non-game address → reverts `NotBetGame`.

- [ ] **Step 4: Verify invariants live**

For the test operator+token bucket on 943, confirm `bankroll + locked + rake <= token.balanceOf(escrow)` after the run (query via `cast call`). No freeze, no steal, correct rake.

- [ ] **Step 5: Record the run + gate 369**

Document the 943 run (rounds played, refunds, rejections) in the address doc. Update memory. **Do NOT deploy to 369** — that is a separate, explicit gate (task #12 in the session task list) requiring sign-off after 943 proves out.

---

## Self-Review

**1. Spec coverage** (against `2026-08-09-table-maintainer-design.md`):
- §2 invariant spine: (1) honest player paid/refunded → Tasks 5, 8, 13; (2) no misbehavior profit → loss/refund never rewards withholding, Task 8 refundStale returns *stake only*, no split; (3) per-(operator,token) closed ledger, token-agnostic, balance-delta, isolation → Tasks 1,3,9; (4) graceful bankruptcy → `EscrowLib.lock` revert, Tasks 4,13; (5) zero protocol solvency risk via full pre-collateralization → Tasks 4,9 (I1). ✓
- §3.1 OperatorRegistry → Task 2. §3.2 GameEscrow (fund-and-verify, settle, rake, isolation) → Tasks 3,4,5,9,10. §3.3 Bond custody → Task 6. §3.4 capital model (house-banked bankroll pre-collateralization) → Tasks 4,5,8. §3.5 BYO + default vault → Task 7 + architecture note. ✓
- §4 wiring onto reference game (CoinFlipTables → escrow-backed) → Task 8. ✓
- §5 error handling (under-deliver revert, insufficient bankroll, hostile token contained, reentrancy) → Tasks 3,4,9,10. ✓
- §6 testing/rollout (Foundry invariants, MCOPY gate, 943 live, 369 gated) → Tasks 9,10,11,12,13. ✓
- §7 out of scope (B/C/D) → not built; bond slash path built as primitive only (Task 6), noted. ✓

**2. Placeholder scan:** deploy-script specifics (Task 12) intentionally defer to "match the existing convention" because the repo's deploy tooling is the source of truth — the step says to read it first; that is direction, not a placeholder. The `EscrowHandler` (Task 9) is described by its full action surface + line budget + model files rather than transcribed in full; acceptable for an invariant handler. No `TBD`/`TODO` in production code.

**3. Type consistency:** `EscrowLib.Ledger{bankroll,locked,rake}` used identically in Tasks 1,3,4,5. `Bet{game,operator,token,player,payout,stake,open}` defined Task 4, consumed Task 5. `lockExposure(betId,operator,token,player,stake,payout)` signature identical in Tasks 4,5(test),8. `settleWin/settleLoss/refund(betId)` identical Tasks 5,8. `rakeBps(operator,game)`/`rakeRecipientOf(operator,token)` identical Tasks 2,5. `depositBankroll(operator,token,amount)` identical Tasks 3,7,8. Ledger key `keccak256(abi.encode(operator,token))` identical everywhere. ✓

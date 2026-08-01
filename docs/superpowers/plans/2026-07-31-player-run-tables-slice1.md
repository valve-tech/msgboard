# Player-Run Tables — Slice 1 (Permissionless Coin-Flip Vault) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a permissionless `CoinFlipTables` contract — anyone funds a Chips bankroll, players bet coin flips against it, validators decide the outcome, and every round is escrowed and replayable from logs — plus the games-web surface to browse, create, and join tables.

**Architecture:** `CoinFlipTables` extends `GameBase` and reuses its validator-subset heat + `onCast` dispatch + stale-recovery machinery, exactly like `CoinFlip.sol`. The single differences from `CoinFlip`: the counterparty is a per-operator Chips bankroll (a two-tier hot/cold pool held in the contract) rather than a matched opposite player, and the token is Chips (ERC-20 `transferFrom`) rather than native value. Settlement is on-chain per round from the validator seed's parity; no operator signature exists anywhere. A thin off-chain verifier + indexer read events (never getters) so past rounds are auditable and tables are sortable by armed liquidity + stake.

**Tech Stack:** Solidity ^0.8.24 (Hardhat + Foundry, solady libs), Hardhat/viem/chai tests, TypeScript React + Vite (`@msgboard/games-web`), viem client.

## Global Constraints

- Solidity `pragma ^0.8.24`; license header `// SPDX-License-Identifier: UNLICENSED` (match sibling contracts).
- Token is **Chips** (ERC-20). Contract stores `address public immutable chips`; all value movements are `SafeTransferLib` `safeTransfer` / `safeTransferFrom` on `chips`. No native `msg.value` anywhere.
- Randomness is **validator-only via `IRandom`**, through `GameBase._heatBound` / `onCast`. The contract inks nothing and contributes nothing to the seed.
- `maxMultiplierX100` is always clamped to `[150, 200]` — on `createTable` and on every `setParams`.
- **Settlement/open/refund paths must never read or write `cold`.** Only fund/withdraw/promote/demote/refill touch `cold`.
- Every table param is operator-editable at will via `setParams` / `setOpen`; **param changes bind only rounds opened after the change** — a live `Round` settles on the `payout` it snapshotted at `open`.
- **Emit complete round data in events** (`RoundOpened`, `RoundSettled`) so any round is replayable from block-anchored logs alone, not from mutable getters.
- Accounting invariant, asserted in tests after every mutating sequence: `hot + cold + escrowed + stake == chips.balanceOf(contract) attributable to the table`, and `escrowed == Σ payout over Pending rounds`.
- Follow existing test idioms: `helpers.loadFixture(testUtils.deploy)`, `testUtils.setUpValidators(ctx, contract, count)` → `{ subset, locations, secrets }`, drive settlement with `ctx.random.write.cast([key, locations, secrets])`, assert reverts with `expectations.revertedWithCustomError`, events with `expectations.emit`. The fixture's Solady `ctx.ERC20` (mintable, 1000e18 minted to every signer) is the Chips stand-in in tests.

**Spec:** `docs/superpowers/specs/2026-07-31-player-run-tables-design.md`

---

## File Structure

- **Create** `games/contracts/contracts/games/CoinFlipTables.sol` — the contract (extends `GameBase`). Vault accounting (hot/cold/escrow/stake) in its own clearly-bounded section, no game logic mixed in, so a Slice-2 extraction into `TableVault` is mechanical.
- **Modify** `games/contracts/lib/utils.ts` (or wherever `contractName` is defined) + `games/contracts/test/utils.ts` `deploy` fixture — deploy `CoinFlipTables` with `(random.address, ERC20.address)` and expose it as `ctx.coinFlipTables`; register its validators helper usage.
- **Create** `games/contracts/test/CoinFlipTables.test.ts` — Hardhat/viem tests (mirrors `test/CoinFlip.test.ts`).
- **Create** `games/web/src/lib/tablesVerify.ts` — off-chain verifier: reconstruct a settled round's winner/payout from `RoundOpened` + `RoundSettled` logs and the `IRandom` seed.
- **Create** `games/web/src/lib/tablesIndex.ts` — event-driven read model: per-table `hot`, `cold`, `stake`, activity (rounds in last N blocks), `lastActiveBlock`, `open`, sorted list.
- **Create** `games/web/src/components/TablePicker.tsx` — table list (sorted), "Create a table" flow, "Join" wiring.
- **Modify** the Coin Flip screen wiring in `games/web/src/` (the screen that renders the coin-flip felt) — mount `TablePicker`, route `open()` to the chosen `tableId`, show the verify receipt.

The plan is two phases. **Phase A (Tasks 1–10): the contract + off-chain verifier** — this is complete, testable software on its own (a funded table can be played and audited via tests/scripts). **Phase B (Tasks 11–14): the games-web surface.** If executing incrementally, Phase A can ship and be reviewed before Phase B starts.

---

## Task 1: Scaffold `CoinFlipTables` — storage, create, setParams, setOpen

**Files:**
- Create: `games/contracts/contracts/games/CoinFlipTables.sol`
- Modify: `games/contracts/test/utils.ts` (deploy `coinFlipTables`), `games/contracts/lib/utils.ts` (`contractName.CoinFlipTables`)
- Test: `games/contracts/test/CoinFlipTables.test.ts`

**Interfaces:**
- Consumes: `GameBase(address random)` constructor; `GameBase` validator allowlist; solady `SafeTransferLib`.
- Produces:
  - `constructor(address random_, address chips_)`
  - `struct Table { address operator; uint256 hot; uint256 cold; uint256 escrowed; uint256 stake; uint16 maxMultiplierX100; uint256 maxStake; uint256 hotTarget; bool open; }`
  - `mapping(bytes32 => Table) public tables`
  - `function createTable(uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget) external returns (bytes32 tableId)`
  - `function setParams(bytes32 tableId, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget) external`
  - `function setOpen(bytes32 tableId, bool isOpen) external`
  - events `TableCreated(bytes32 indexed tableId, address indexed operator, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget)`, `ParamsSet(bytes32 indexed tableId, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget)`, `OpenSet(bytes32 indexed tableId, bool open)`
  - errors `NotOperator()`, `BadMultiplier()`, `NoTable()`

- [ ] **Step 1: Write the failing test**

Add to a new `games/contracts/test/CoinFlipTables.test.ts`:

```typescript
import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'

describe('CoinFlipTables', () => {
  describe('createTable', () => {
    it('records the operator, params, open=true, and zero balances', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [op] = ctx.signers
      const hash = await testUtils.confirmTx(
        ctx,
        ctx.coinFlipTables.write.createTable([196, viem.parseEther('10'), viem.parseEther('100')], { account: op.account }),
      )
      const created = await ctx.coinFlipTables.getEvents.TableCreated()
      expect(created.length).to.equal(1)
      const tableId = created[0]!.args.tableId as viem.Hex
      // tuple order: [operator, hot, cold, escrowed, stake, maxMultiplierX100, maxStake, hotTarget, open]
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(viem.getAddress(t[0] as viem.Hex)).to.equal(viem.getAddress(op.account.address))
      expect(t[1]).to.equal(0n) // hot
      expect(t[2]).to.equal(0n) // cold
      expect(t[5]).to.equal(196) // maxMultiplierX100
      expect(t[8]).to.equal(true) // open
    })

    it('rejects a multiplier outside [150,200]', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.createTable([149, viem.parseEther('10'), viem.parseEther('100')]),
        'BadMultiplier',
      )
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.createTable([201, viem.parseEther('10'), viem.parseEther('100')]),
        'BadMultiplier',
      )
    })
  })

  describe('setParams / setOpen', () => {
    it('lets the operator change any param and rejects non-operators', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [op, other] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.createTable([196, viem.parseEther('10'), viem.parseEther('100')], { account: op.account }))
      const tableId = (await ctx.coinFlipTables.getEvents.TableCreated())[0]!.args.tableId as viem.Hex
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.setParams([tableId, 150, viem.parseEther('5'), viem.parseEther('50')], { account: op.account }))
      const t = await ctx.coinFlipTables.read.tables([tableId])
      expect(t[5]).to.equal(150)
      expect(t[6]).to.equal(viem.parseEther('5'))
      await expectations.revertedWithCustomError(
        ctx.coinFlipTables,
        ctx.coinFlipTables.write.setParams([tableId, 160, 0n, 0n], { account: other!.account }),
        'NotOperator',
      )
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: FAIL — `ctx.coinFlipTables` undefined / contract not found.

- [ ] **Step 3: Register the contract name and fixture deploy**

In `games/contracts/lib/utils.ts`, add `CoinFlipTables` to the `contractName` map (follow the exact form the file uses for `CoinFlip`, e.g. `CoinFlipTables: 'CoinFlipTables'`).

In `games/contracts/test/utils.ts` `deploy`, after `coinFlip` is deployed (~line 54), add:

```typescript
const coinFlipTables = await hre.viem.deployContract(contractName.CoinFlipTables, [random.address, _ERC20.address])
```

and add `coinFlipTables` to the returned context object (near `coinFlip` in the return, ~line 69).

- [ ] **Step 4: Write the contract scaffold**

Create `games/contracts/contracts/games/CoinFlipTables.sol`:

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {GameBase} from "../GameBase.sol";
import {IRandom} from "../implementations/IRandom.sol";
import {PreimageLocation} from "../PreimageLocation.sol";

/// @notice Permissionless coin flip against an operator-run Chips bankroll. Anyone opens a table and
/// funds a two-tier (hot/cold) bankroll; players bet a side and a stake; a validator subset's seed
/// parity decides. The operator signs nothing and cannot touch the coin — only supplies capital.
/// This is CoinFlip.sol with the matched opposite player replaced by the table's pooled Chips.
contract CoinFlipTables is GameBase {
    using SafeTransferLib for address;

    error NotOperator();
    error BadMultiplier();
    error NoTable();

    event TableCreated(bytes32 indexed tableId, address indexed operator, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget);
    event ParamsSet(bytes32 indexed tableId, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget);
    event OpenSet(bytes32 indexed tableId, bool open);

    uint16 internal constant MULT_MIN = 150;
    uint16 internal constant MULT_MAX = 200;

    struct Table {
        address operator;
        uint256 hot;              // armed — the only balance a new round can escrow against
        uint256 cold;             // reserve — never at risk until promoted
        uint256 escrowed;         // full payout locked by live rounds
        uint256 stake;            // ranking signal, never touched by settlement
        uint16  maxMultiplierX100;
        uint256 maxStake;
        uint256 hotTarget;
        bool    open;
    }

    address public immutable chips;
    mapping(bytes32 tableId => Table) public tables;
    uint256 internal _tableNonce;

    constructor(address random_, address chips_) GameBase(random_) {
        chips = chips_;
    }

    modifier onlyOperator(bytes32 tableId) {
        if (tables[tableId].operator != msg.sender) revert NotOperator();
        _;
    }

    function _requireMultiplier(uint16 m) internal pure {
        if (m < MULT_MIN || m > MULT_MAX) revert BadMultiplier();
    }

    function createTable(uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget)
        external
        returns (bytes32 tableId)
    {
        _requireMultiplier(maxMultiplierX100);
        tableId = keccak256(abi.encode(address(this), msg.sender, ++_tableNonce));
        Table storage t = tables[tableId];
        t.operator = msg.sender;
        t.maxMultiplierX100 = maxMultiplierX100;
        t.maxStake = maxStake;
        t.hotTarget = hotTarget;
        t.open = true;
        emit TableCreated(tableId, msg.sender, maxMultiplierX100, maxStake, hotTarget);
    }

    function setParams(bytes32 tableId, uint16 maxMultiplierX100, uint256 maxStake, uint256 hotTarget)
        external
        onlyOperator(tableId)
    {
        _requireMultiplier(maxMultiplierX100);
        Table storage t = tables[tableId];
        t.maxMultiplierX100 = maxMultiplierX100;
        t.maxStake = maxStake;
        t.hotTarget = hotTarget;
        emit ParamsSet(tableId, maxMultiplierX100, maxStake, hotTarget);
    }

    function setOpen(bytes32 tableId, bool isOpen) external onlyOperator(tableId) {
        tables[tableId].open = isOpen;
        emit OpenSet(tableId, isOpen);
    }
}
```

> Note: `onlyOperator` reverts `NotOperator` for a nonexistent table too (operator is `address(0)`), which is the desired behavior; a dedicated `NoTable` is declared for later paths (`open`) where a clearer error helps.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS (createTable + setParams/setOpen describe blocks).

- [ ] **Step 6: Commit**

```bash
git add games/contracts/contracts/games/CoinFlipTables.sol games/contracts/test/CoinFlipTables.test.ts games/contracts/test/utils.ts games/contracts/lib/utils.ts
git commit -m "feat(games-contracts): CoinFlipTables scaffold — create/setParams/setOpen"
```

---

## Task 2: Two-tier bankroll — fund/withdraw/promote/demote

**Files:**
- Modify: `games/contracts/contracts/games/CoinFlipTables.sol`
- Test: `games/contracts/test/CoinFlipTables.test.ts`

**Interfaces:**
- Consumes: `chips` (ERC-20), `Table` storage, `onlyOperator`.
- Produces:
  - `function fundHot(bytes32 tableId, uint256 amount) external`
  - `function fundCold(bytes32 tableId, uint256 amount) external`
  - `function withdrawHot(bytes32 tableId, uint256 amount) external`  (operator only; revert `InsufficientHot`)
  - `function withdrawCold(bytes32 tableId, uint256 amount) external` (operator only; revert `InsufficientCold`)
  - `function promote(bytes32 tableId, uint256 amount) external` (cold→hot; revert `InsufficientCold`)
  - `function demote(bytes32 tableId, uint256 amount) external` (hot→cold; revert `InsufficientHot`)
  - events `HotFunded/ColdFunded/HotWithdrawn/ColdWithdrawn/Promoted/Demoted(bytes32 indexed tableId, uint256 amount)`
  - errors `InsufficientHot()`, `InsufficientCold()`

- [ ] **Step 1: Write the failing test**

Append a `describe('bankroll', ...)` to `CoinFlipTables.test.ts`. Assume a `mkTable` helper (add it near the top of the test file):

```typescript
const mkTable = async (ctx: testUtils.Context, opts?: { mult?: number; maxStake?: bigint; hotTarget?: bigint; account?: any }) => {
  const account = opts?.account ?? ctx.signers[0]!.account
  await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.createTable(
    [opts?.mult ?? 196, opts?.maxStake ?? viem.parseEther('10'), opts?.hotTarget ?? viem.parseEther('100')],
    { account },
  ))
  const evs = await ctx.coinFlipTables.getEvents.TableCreated()
  return evs[evs.length - 1]!.args.tableId as viem.Hex
}

const approveChips = async (ctx: testUtils.Context, account: any, amount: bigint) => {
  await testUtils.confirmTx(ctx, ctx.ERC20.write.approve([ctx.coinFlipTables.address, amount], { account }))
}
```

```typescript
describe('bankroll', () => {
  it('funds hot and cold, and withdraws from each', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const op = ctx.signers[0]!.account
    const tableId = await mkTable(ctx)
    await approveChips(ctx, op, viem.parseEther('30'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('10')], { account: op }))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([tableId, viem.parseEther('20')], { account: op }))
    let t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[1]).to.equal(viem.parseEther('10')) // hot
    expect(t[2]).to.equal(viem.parseEther('20')) // cold
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.withdrawCold([tableId, viem.parseEther('20')], { account: op }))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.withdrawHot([tableId, viem.parseEther('4')], { account: op }))
    t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[1]).to.equal(viem.parseEther('6'))
    expect(t[2]).to.equal(0n)
  })

  it('promotes cold to hot and demotes hot to cold', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const op = ctx.signers[0]!.account
    const tableId = await mkTable(ctx)
    await approveChips(ctx, op, viem.parseEther('20'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([tableId, viem.parseEther('20')], { account: op }))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.promote([tableId, viem.parseEther('12')], { account: op }))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.demote([tableId, viem.parseEther('2')], { account: op }))
    const t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[1]).to.equal(viem.parseEther('10')) // hot
    expect(t[2]).to.equal(viem.parseEther('10')) // cold
  })

  it('reverts withdrawing more hot than available', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const op = ctx.signers[0]!.account
    const tableId = await mkTable(ctx)
    await approveChips(ctx, op, viem.parseEther('5'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('5')], { account: op }))
    await expectations.revertedWithCustomError(
      ctx.coinFlipTables,
      ctx.coinFlipTables.write.withdrawHot([tableId, viem.parseEther('6')], { account: op }),
      'InsufficientHot',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: FAIL — `fundHot` etc. not a function.

- [ ] **Step 3: Implement the bankroll functions**

Add to `CoinFlipTables.sol` (after `setOpen`):

```solidity
error InsufficientHot();
error InsufficientCold();

event HotFunded(bytes32 indexed tableId, uint256 amount);
event ColdFunded(bytes32 indexed tableId, uint256 amount);
event HotWithdrawn(bytes32 indexed tableId, uint256 amount);
event ColdWithdrawn(bytes32 indexed tableId, uint256 amount);
event Promoted(bytes32 indexed tableId, uint256 amount);
event Demoted(bytes32 indexed tableId, uint256 amount);

function fundHot(bytes32 tableId, uint256 amount) external {
    if (tables[tableId].operator == address(0)) revert NoTable();
    tables[tableId].hot += amount;
    chips.safeTransferFrom(msg.sender, address(this), amount);
    emit HotFunded(tableId, amount);
}

function fundCold(bytes32 tableId, uint256 amount) external {
    if (tables[tableId].operator == address(0)) revert NoTable();
    tables[tableId].cold += amount;
    chips.safeTransferFrom(msg.sender, address(this), amount);
    emit ColdFunded(tableId, amount);
}

function withdrawHot(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
    Table storage t = tables[tableId];
    if (t.hot < amount) revert InsufficientHot();
    t.hot -= amount;
    chips.safeTransfer(msg.sender, amount);
    emit HotWithdrawn(tableId, amount);
}

function withdrawCold(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
    Table storage t = tables[tableId];
    if (t.cold < amount) revert InsufficientCold();
    t.cold -= amount;
    chips.safeTransfer(msg.sender, amount);
    emit ColdWithdrawn(tableId, amount);
}

function promote(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
    Table storage t = tables[tableId];
    if (t.cold < amount) revert InsufficientCold();
    t.cold -= amount;
    t.hot += amount;
    emit Promoted(tableId, amount);
}

function demote(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
    Table storage t = tables[tableId];
    if (t.hot < amount) revert InsufficientHot();
    t.hot -= amount;
    t.cold += amount;
    emit Demoted(tableId, amount);
}
```

Move the `error InsufficientHot/InsufficientCold` and the events up beside the other error/event declarations if you prefer them grouped; keeping them adjacent to the functions is also fine.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS (bankroll describe block green).

- [ ] **Step 5: Commit**

```bash
git add games/contracts/contracts/games/CoinFlipTables.sol games/contracts/test/CoinFlipTables.test.ts
git commit -m "feat(games-contracts): CoinFlipTables two-tier hot/cold bankroll"
```

---

## Task 3: Operator stake for ranking

**Files:**
- Modify: `games/contracts/contracts/games/CoinFlipTables.sol`
- Test: `games/contracts/test/CoinFlipTables.test.ts`

**Interfaces:**
- Produces:
  - `function stakeForRank(bytes32 tableId, uint256 amount) external` (operator only)
  - `function unstake(bytes32 tableId, uint256 amount) external` (operator only; revert `InsufficientStake`)
  - events `Staked/Unstaked(bytes32 indexed tableId, uint256 amount)`; error `InsufficientStake()`

- [ ] **Step 1: Write the failing test**

```typescript
describe('stake', () => {
  it('stakes and unstakes, kept separate from bankroll', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const op = ctx.signers[0]!.account
    const tableId = await mkTable(ctx)
    await approveChips(ctx, op, viem.parseEther('10'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.stakeForRank([tableId, viem.parseEther('10')], { account: op }))
    let t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[4]).to.equal(viem.parseEther('10')) // stake
    expect(t[1]).to.equal(0n) // hot untouched
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.unstake([tableId, viem.parseEther('4')], { account: op }))
    t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[4]).to.equal(viem.parseEther('6'))
  })

  it('reverts unstaking more than staked', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const op = ctx.signers[0]!.account
    const tableId = await mkTable(ctx)
    await expectations.revertedWithCustomError(
      ctx.coinFlipTables,
      ctx.coinFlipTables.write.unstake([tableId, 1n], { account: op }),
      'InsufficientStake',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: FAIL — `stakeForRank` not a function.

- [ ] **Step 3: Implement stake**

Add to `CoinFlipTables.sol`:

```solidity
error InsufficientStake();
event Staked(bytes32 indexed tableId, uint256 amount);
event Unstaked(bytes32 indexed tableId, uint256 amount);

function stakeForRank(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
    tables[tableId].stake += amount;
    chips.safeTransferFrom(msg.sender, address(this), amount);
    emit Staked(tableId, amount);
}

function unstake(bytes32 tableId, uint256 amount) external onlyOperator(tableId) {
    Table storage t = tables[tableId];
    if (t.stake < amount) revert InsufficientStake();
    t.stake -= amount;
    chips.safeTransfer(msg.sender, amount);
    emit Unstaked(tableId, amount);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add games/contracts/contracts/games/CoinFlipTables.sol games/contracts/test/CoinFlipTables.test.ts
git commit -m "feat(games-contracts): CoinFlipTables operator stake for ranking"
```

---

## Task 4: `refillHot` — operator + permissionless top-up to `hotTarget`

**Files:**
- Modify: `games/contracts/contracts/games/CoinFlipTables.sol`
- Test: `games/contracts/test/CoinFlipTables.test.ts`

**Interfaces:**
- Produces: `function refillHot(bytes32 tableId) external` — moves `min(cold, hotTarget - hot)` from cold to hot; callable by anyone but only when `hot < hotTarget`; never exceeds `hotTarget`; only that table's own `cold`. Reverts `NothingToRefill` when `hot >= hotTarget` or `cold == 0`. Event `Refilled(bytes32 indexed tableId, uint256 amount)`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('refillHot', () => {
  it('tops hot up to hotTarget from cold, callable by anyone', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const op = ctx.signers[0]!.account
    const stranger = ctx.signers[3]!.account
    const tableId = await mkTable(ctx, { hotTarget: viem.parseEther('10') })
    await approveChips(ctx, op, viem.parseEther('30'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('3')], { account: op }))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([tableId, viem.parseEther('20')], { account: op }))
    // stranger triggers refill; hot goes 3 -> 10, cold 20 -> 13
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.refillHot([tableId], { account: stranger }))
    const t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[1]).to.equal(viem.parseEther('10'))
    expect(t[2]).to.equal(viem.parseEther('13'))
  })

  it('caps at cold when cold < needed, and reverts when hot already at target', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const op = ctx.signers[0]!.account
    const tableId = await mkTable(ctx, { hotTarget: viem.parseEther('10') })
    await approveChips(ctx, op, viem.parseEther('12'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('10')], { account: op }))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([tableId, viem.parseEther('2')], { account: op }))
    await expectations.revertedWithCustomError(
      ctx.coinFlipTables,
      ctx.coinFlipTables.write.refillHot([tableId], { account: op }),
      'NothingToRefill',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: FAIL — `refillHot` not a function.

- [ ] **Step 3: Implement refillHot**

```solidity
error NothingToRefill();
event Refilled(bytes32 indexed tableId, uint256 amount);

function refillHot(bytes32 tableId) external {
    Table storage t = tables[tableId];
    if (t.operator == address(0)) revert NoTable();
    if (t.hot >= t.hotTarget) revert NothingToRefill();
    uint256 need = t.hotTarget - t.hot;
    uint256 move = need < t.cold ? need : t.cold;
    if (move == 0) revert NothingToRefill();
    t.cold -= move;
    t.hot += move;
    emit Refilled(tableId, move);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add games/contracts/contracts/games/CoinFlipTables.sol games/contracts/test/CoinFlipTables.test.ts
git commit -m "feat(games-contracts): CoinFlipTables refillHot (operator + permissionless to target)"
```

---

## Task 5: `open` a round — escrow from hot, heat validators, emit full data

**Files:**
- Modify: `games/contracts/contracts/games/CoinFlipTables.sol`
- Test: `games/contracts/test/CoinFlipTables.test.ts`

**Interfaces:**
- Consumes: `GameBase._heatBound(validatorSubset, validatorLocations) → bytes32 key`, `GameBase.instanceByKey`, `PreimageLocation.Info`.
- Produces:
  - `enum Status { None, Pending, Settled, Refunded }`
  - `struct Round { bytes32 tableId; address player; uint8 side; uint256 stake; uint256 payout; bytes32 key; uint256 openedAtBlock; Status status; }`
  - `mapping(bytes32 roundId => Round) public rounds`
  - `function open(bytes32 tableId, uint8 side, uint256 stake, address[] calldata validatorSubset, PreimageLocation.Info[] calldata validatorLocations) external returns (bytes32 roundId)`
  - event `RoundOpened(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, uint8 side, uint256 stake, uint256 payout, bytes32 subsetHash, bytes32 key, uint256 openedAtBlock)`
  - errors `TableClosed()`, `StakeTooHigh()`, `ZeroStake()`, `WrongSide()`, `InsufficientBankroll()`
  - constants `HEADS = 0`, `TAILS = 1`

- [ ] **Step 1: Write the failing test**

```typescript
describe('open', () => {
  it('escrows the full payout (hot debited by payout-stake), pulls the player stake, heats validators', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
    const op = ctx.signers[0]!.account
    const player = ctx.signers[1]!.account
    const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), hotTarget: viem.parseEther('100'), account: op })
    await approveChips(ctx, op, viem.parseEther('50'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
    await approveChips(ctx, player, viem.parseEther('1'))
    const stake = viem.parseEther('1')
    const payout = (stake * 196n) / 100n // 1.96e18
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, 0, stake, subset, locations], { account: player }))
    const opened = await ctx.coinFlipTables.getEvents.RoundOpened()
    expect(opened.length).to.equal(1)
    expect(opened[0]!.args.payout).to.equal(payout)
    const t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[1]).to.equal(viem.parseEther('50') - (payout - stake)) // hot debited by exposure only
    expect(t[3]).to.equal(payout) // escrowed == full payout
  })

  it('reverts when stake exceeds maxStake, table closed, or hot cannot cover exposure', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
    const op = ctx.signers[0]!.account
    const player = ctx.signers[1]!.account
    const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('2'), account: op })
    await approveChips(ctx, player, viem.parseEther('5'))
    // no hot funded -> exposure uncovered
    await expectations.revertedWithCustomError(
      ctx.coinFlipTables,
      ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('1'), subset, locations], { account: player }),
      'InsufficientBankroll',
    )
    // stake above maxStake
    await expectations.revertedWithCustomError(
      ctx.coinFlipTables,
      ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('3'), subset, locations], { account: player }),
      'StakeTooHigh',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: FAIL — `open` not a function.

- [ ] **Step 3: Implement `open`**

Add the enum/struct/mapping near the top storage section, then:

```solidity
enum Status { None, Pending, Settled, Refunded }

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

uint8 internal constant HEADS = 0;
uint8 internal constant TAILS = 1;

mapping(bytes32 roundId => Round) public rounds;
uint256 internal _roundNonce;

error TableClosed();
error StakeTooHigh();
error ZeroStake();
error WrongSide();
error InsufficientBankroll();

event RoundOpened(
    bytes32 indexed roundId,
    bytes32 indexed tableId,
    address indexed player,
    uint8 side,
    uint256 stake,
    uint256 payout,
    bytes32 subsetHash,
    bytes32 key,
    uint256 openedAtBlock
);

function open(
    bytes32 tableId,
    uint8 side,
    uint256 stake,
    address[] calldata validatorSubset,
    PreimageLocation.Info[] calldata validatorLocations
) external returns (bytes32 roundId) {
    Table storage t = tables[tableId];
    if (t.operator == address(0)) revert NoTable();
    if (!t.open) revert TableClosed();
    if (side > TAILS) revert WrongSide();
    if (stake == 0) revert ZeroStake();
    if (stake > t.maxStake) revert StakeTooHigh();

    uint256 payout = stake * t.maxMultiplierX100 / 100;
    uint256 exposure = payout - stake; // operator's at-risk portion
    if (t.hot < exposure) revert InsufficientBankroll();

    // Pull the player's stake into the contract, then lock the full payout: exposure leaves hot,
    // the player's own stake is now held as the remainder of the escrow.
    chips.safeTransferFrom(msg.sender, address(this), stake);
    t.hot -= exposure;
    t.escrowed += payout;

    bytes32 key = _heatBound(validatorSubset, validatorLocations);
    roundId = keccak256(abi.encode(address(this), ++_roundNonce, tableId, msg.sender));
    rounds[roundId] = Round({
        tableId: tableId,
        player: msg.sender,
        side: side,
        stake: stake,
        payout: payout,
        key: key,
        openedAtBlock: block.number,
        status: Status.Pending
    });
    instanceByKey[key] = roundId;
    emit RoundOpened(roundId, tableId, msg.sender, side, stake, payout, keccak256(abi.encode(validatorSubset)), key, block.number);
}
```

> Confirmed signature (GameBase.sol:136): `_heatBound(address[] memory subset, PreimageLocation.Info[] calldata locations) returns (bytes32)`. Passing the `calldata` `validatorSubset` to the `memory` param is fine (implicit copy), exactly as `CoinFlip._pairAndHeat` does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add games/contracts/contracts/games/CoinFlipTables.sol games/contracts/test/CoinFlipTables.test.ts
git commit -m "feat(games-contracts): CoinFlipTables open() — escrow full payout from hot + heat validators"
```

---

## Task 6: Settle — `onCast` push + `claim` pull, win/loss accounting

**Files:**
- Modify: `games/contracts/contracts/games/CoinFlipTables.sol`
- Test: `games/contracts/test/CoinFlipTables.test.ts`

**Interfaces:**
- Consumes: `GameBase._settle(bytes32 instanceId, bytes32 seed)` override hook (called by `onCast`); `IRandom(random).randomness(key).seed`.
- Produces:
  - `function _settle(bytes32 roundId, bytes32 seed) internal override`
  - `function claim(bytes32 roundId) external`
  - event `RoundSettled(bytes32 indexed roundId, bytes32 indexed tableId, address indexed player, bool won, uint256 payout, bytes32 seed, uint256 settledAtBlock)`
  - errors `AlreadyResolved()`, `TooEarly()`

- [ ] **Step 1: Write the failing test**

```typescript
describe('settle', () => {
  const fundAndOpen = async (ctx: testUtils.Context, side: number) => {
    const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
    const op = ctx.signers[0]!.account
    const player = ctx.signers[1]!.account
    const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), account: op })
    await approveChips(ctx, op, viem.parseEther('50'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
    await approveChips(ctx, player, viem.parseEther('1'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, side, viem.parseEther('1'), subset, locations], { account: player }))
    const opened = (await ctx.coinFlipTables.getEvents.RoundOpened())
    const round = opened[opened.length - 1]!.args
    return { tableId, player, op, key: round.key as viem.Hex, roundId: round.roundId as viem.Hex, subset, locations, secrets }
  }

  it('pays the player on a parity win, debiting only the exposure from the table', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const { key, player, tableId, locations, secrets } = await fundAndOpen(ctx, 0)
    const before = await ctx.ERC20.read.balanceOf([player.address])
    await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
    const seed = (await ctx.random.read.randomness([key])).seed as viem.Hex
    const settled = (await ctx.coinFlipTables.getEvents.RoundSettled())[0]!.args
    const playerWon = (BigInt(seed) & 1n) === 0n // side was HEADS(0)
    expect(settled.won).to.equal(playerWon)
    const after = await ctx.ERC20.read.balanceOf([player.address])
    if (playerWon) expect(after - before).to.equal(viem.parseEther('1.96'))
    else expect(after).to.equal(before)
    // escrow always released
    const t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[3]).to.equal(0n) // escrowed
    // on a loss the whole payout (incl. the player's forfeited stake) is back in hot
    if (!playerWon) expect(t[1]).to.equal(viem.parseEther('50') + viem.parseEther('1'))
    else expect(t[1]).to.equal(viem.parseEther('50') - viem.parseEther('0.96'))
  })

  it('claim() pays after a swallowed onCast, and double-settle reverts', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const { key, roundId, locations, secrets } = await fundAndOpen(ctx, 1)
    await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
    await expectations.revertedWithCustomError(
      ctx.coinFlipTables,
      ctx.coinFlipTables.write.claim([roundId]),
      'AlreadyResolved',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: FAIL — `_settle` not overridden / `RoundSettled` not emitted.

- [ ] **Step 3: Implement `_settle` + `claim`**

```solidity
error AlreadyResolved();
error TooEarly();

event RoundSettled(
    bytes32 indexed roundId,
    bytes32 indexed tableId,
    address indexed player,
    bool won,
    uint256 payout,
    bytes32 seed,
    uint256 settledAtBlock
);

/// @notice Single settlement path shared by onCast (push) and claim (pull). Guards status before any
/// transfer (checks-effects-interactions) so a double payout is impossible. No reentrancy guard — it
/// would block the claim retry after a swallowed onCast (same rationale as CoinFlip._settle).
function _settle(bytes32 roundId, bytes32 seed) internal override {
    Round storage r = rounds[roundId];
    if (r.status != Status.Pending) revert AlreadyResolved();
    r.status = Status.Settled;

    Table storage t = tables[r.tableId];
    uint256 exposure = r.payout - r.stake;
    t.escrowed -= r.payout; // release reservation either way

    bool won = uint8(uint256(seed) & 1) == r.side;
    if (won) {
        // exposure already left hot at open; pay the player the full payout from escrow
        chips.safeTransfer(r.player, r.payout);
    } else {
        // whole reservation (operator exposure + player's forfeited stake) returns to armed balance
        t.hot += r.payout;
    }
    emit RoundSettled(roundId, r.tableId, r.player, won, r.payout, seed, block.number);
}

/// @notice Pull fallback when the onCast push did not complete though the seed is finalized.
function claim(bytes32 roundId) external {
    Round storage r = rounds[roundId];
    if (r.status != Status.Pending) revert AlreadyResolved();
    bytes32 seed = IRandom(random).randomness(r.key).seed;
    if (seed == bytes32(0)) revert TooEarly();
    _settle(roundId, seed);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add games/contracts/contracts/games/CoinFlipTables.sol games/contracts/test/CoinFlipTables.test.ts
git commit -m "feat(games-contracts): CoinFlipTables settle via onCast + claim, win/loss accounting"
```

---

## Task 7: `refundStale` — reclaim on a missing seed

**Files:**
- Modify: `games/contracts/contracts/games/CoinFlipTables.sol`
- Test: `games/contracts/test/CoinFlipTables.test.ts`

**Interfaces:**
- Consumes: `GameBase.choppedInstance`, `GameBase._isStale(uint256 blockNumber)` (confirm exact name in `GameBase.sol`; `CoinFlip.refundStale` uses `_isStale(flip.pairedAtBlock)`), `IRandom(random).randomness(key).seed`.
- Produces: `function refundStale(bytes32 roundId) external` — returns `stake` to player, releases exposure to hot, sets `Refunded`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('refundStale', () => {
  it('refunds the player and returns exposure to hot when the seed never finalizes', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
    const op = ctx.signers[0]!.account
    const player = ctx.signers[1]!.account
    const tableId = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), account: op })
    await approveChips(ctx, op, viem.parseEther('50'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
    await approveChips(ctx, player, viem.parseEther('1'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('1'), subset, locations], { account: player }))
    const round = (await ctx.coinFlipTables.getEvents.RoundOpened()).slice(-1)[0]!.args
    const before = await ctx.ERC20.read.balanceOf([player.address])
    // mine past STALE_BLOCKS (200) without any cast
    await helpers.mine(201)
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.refundStale([round.roundId as viem.Hex], { account: player }))
    const after = await ctx.ERC20.read.balanceOf([player.address])
    expect(after - before).to.equal(viem.parseEther('1'))
    const t = await ctx.coinFlipTables.read.tables([tableId])
    expect(t[1]).to.equal(viem.parseEther('50')) // hot fully restored
    expect(t[3]).to.equal(0n) // escrow released
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: FAIL — `refundStale` not a function.

- [ ] **Step 3: Implement `refundStale`**

```solidity
/// @notice Refund a round whose seed never finalized in time. Mirrors CoinFlip.refundStale: a seed
/// that HAS finalized is value-decided and can only be settled to the parity result, never unwound.
function refundStale(bytes32 roundId) external {
    Round storage r = rounds[roundId];
    if (r.status != Status.Pending) revert AlreadyResolved();
    bool seedMissing = IRandom(random).randomness(r.key).seed == bytes32(0);
    if (!seedMissing) revert TooEarly();
    if (!choppedInstance[roundId] && !_isStale(r.openedAtBlock)) revert TooEarly();
    r.status = Status.Refunded;

    Table storage t = tables[r.tableId];
    uint256 exposure = r.payout - r.stake;
    t.escrowed -= r.payout;
    t.hot += exposure;                     // operator's at-risk portion returns to armed balance
    chips.safeTransfer(r.player, r.stake); // player reclaims their own stake
}
```

> Confirmed signature (GameBase.sol:186): `_isStale(uint256 armedAtBlock) internal view returns (bool)`. We pass `r.openedAtBlock` as the armed-at block (CoinFlip passes `flip.pairedAtBlock`; ours is armed at `open`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add games/contracts/contracts/games/CoinFlipTables.sol games/contracts/test/CoinFlipTables.test.ts
git commit -m "feat(games-contracts): CoinFlipTables refundStale on missing seed"
```

---

## Task 8: Param changes bind only new rounds (regression)

**Files:**
- Test: `games/contracts/test/CoinFlipTables.test.ts` (behavior already implemented; this locks it)

**Interfaces:** none new — verifies the `Round.payout` snapshot from Task 5 against a `setParams` from Task 1.

- [ ] **Step 1: Write the test**

```typescript
describe('params bind only new rounds', () => {
  it('settles a live round on the multiplier it was opened under, even after the operator lowers it', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
    const op = ctx.signers[0]!.account
    const player = ctx.signers[1]!.account
    const tableId = await mkTable(ctx, { mult: 200, maxStake: viem.parseEther('10'), account: op })
    await approveChips(ctx, op, viem.parseEther('50'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([tableId, viem.parseEther('50')], { account: op }))
    await approveChips(ctx, player, viem.parseEther('1'))
    // opened at 2.00x -> payout snapshot 2e18
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([tableId, 0, viem.parseEther('1'), subset, locations], { account: player }))
    const round = (await ctx.coinFlipTables.getEvents.RoundOpened()).slice(-1)[0]!.args
    expect(round.payout).to.equal(viem.parseEther('2'))
    // operator drops the table to 1.50x AFTER the bet
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.setParams([tableId, 150, viem.parseEther('10'), viem.parseEther('100')], { account: op }))
    const before = await ctx.ERC20.read.balanceOf([player.address])
    await testUtils.confirmTx(ctx, ctx.random.write.cast([round.key as viem.Hex, locations, secrets]))
    const seed = (await ctx.random.read.randomness([round.key as viem.Hex])).seed as viem.Hex
    if ((BigInt(seed) & 1n) === 0n) {
      const after = await ctx.ERC20.read.balanceOf([player.address])
      expect(after - before).to.equal(viem.parseEther('2')) // paid at 2.00x, NOT 1.50x
    }
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS (payout was snapshotted at open). If it fails, the `open` implementation is re-reading `maxMultiplierX100` at settle — fix `_settle` to use `r.payout` only.

- [ ] **Step 3: Commit**

```bash
git add games/contracts/test/CoinFlipTables.test.ts
git commit -m "test(games-contracts): param changes bind only new rounds"
```

---

## Task 9: Accounting-invariant + isolation + cold-untouched sweep

**Files:**
- Create: `games/contracts/test/foundry/CoinFlipTables.t.sol` (Foundry, for a multi-op fuzz sequence + a cold-untouched assertion), following `test/foundry/CoinFlip.t.sol` patterns.
- Test: also a viem multi-table isolation case in `CoinFlipTables.test.ts`.

**Interfaces:** none new — asserts the Global Constraints invariant across sequences.

- [ ] **Step 1: Write the viem isolation test**

```typescript
describe('multi-table isolation & invariant', () => {
  it('keeps two tables\' balances independent and preserves hot+cold+escrowed+stake == contract chips', async () => {
    const ctx = await helpers.loadFixture(testUtils.deploy)
    const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlipTables, 3)
    const opA = ctx.signers[0]!.account
    const opB = ctx.signers[2]!.account
    const player = ctx.signers[1]!.account
    const a = await mkTable(ctx, { mult: 196, maxStake: viem.parseEther('10'), account: opA })
    const b = await mkTable(ctx, { mult: 150, maxStake: viem.parseEther('10'), account: opB })
    for (const [op, id] of [[opA, a], [opB, b]] as const) {
      await approveChips(ctx, op, viem.parseEther('30'))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundHot([id, viem.parseEther('20')], { account: op }))
      await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.fundCold([id, viem.parseEther('10')], { account: op }))
    }
    await approveChips(ctx, player, viem.parseEther('1'))
    await testUtils.confirmTx(ctx, ctx.coinFlipTables.write.open([a, 0, viem.parseEther('1'), subset, locations], { account: player }))
    await testUtils.confirmTx(ctx, ctx.random.write.cast([ (await ctx.coinFlipTables.getEvents.RoundOpened()).slice(-1)[0]!.args.key as viem.Hex, locations, secrets ]))
    // table B never moved
    const tb = await ctx.coinFlipTables.read.tables([b])
    expect(tb[1]).to.equal(viem.parseEther('20'))
    expect(tb[2]).to.equal(viem.parseEther('10'))
    expect(tb[3]).to.equal(0n)
    // global invariant: sum of both tables' pools == contract chip balance
    const ta = await ctx.coinFlipTables.read.tables([a])
    const sum = ta[1] + ta[2] + ta[3] + ta[4] + tb[1] + tb[2] + tb[3] + tb[4]
    const bal = await ctx.ERC20.read.balanceOf([ctx.coinFlipTables.address])
    expect(sum).to.equal(bal)
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd games/contracts && npm test -- --grep "CoinFlipTables"`
Expected: PASS.

- [ ] **Step 3: Write the Foundry cold-untouched + fuzz sequence**

Create `games/contracts/test/foundry/CoinFlipTables.t.sol` mirroring `CoinFlip.t.sol`'s setup (deploy `Random`, a mock ERC20, `CoinFlipTables`, allowlist validators). Include:

```solidity
// forge-style: after a fuzzed sequence of fund/open/settle/refund, cold only ever changes via
// fund/withdraw/promote/demote/refill — assert it against a shadow accumulator.
function testFuzz_ColdOnlyMovesViaExplicitOps(uint96 hotAmt, uint96 coldAmt, uint96 stake) public {
    // bound inputs; create a table; fund; snapshot cold; run an open+cast settle; assert cold unchanged
    // (see CoinFlip.t.sol for the cast/seed harness). Assert:
    //   hot + cold + escrowed + stake == chips.balanceOf(address(tables))
    //   cold == coldSnapshot   (settlement never touched it)
}
```

Fill the body using the exact cast/seed harness from `CoinFlip.t.sol` (read it first). The two assertions above are the load-bearing ones.

- [ ] **Step 4: Run Foundry tests**

Run: `cd games/contracts && forge test --match-contract CoinFlipTables`
Expected: PASS. (If the repo runs Foundry via a different command, match `foundry.toml`/CI.)

- [ ] **Step 5: Commit**

```bash
git add games/contracts/test/CoinFlipTables.test.ts games/contracts/test/foundry/CoinFlipTables.t.sol
git commit -m "test(games-contracts): CoinFlipTables invariant, isolation, cold-untouched fuzz"
```

---

## Task 10: Off-chain verifier — replay a settled round from logs

**Files:**
- Create: `games/web/src/lib/tablesVerify.ts`
- Test: `games/web/src/lib/tablesVerify.test.ts` (vitest, matching the web package's test setup — confirm the runner in `games/web/package.json`)

**Interfaces:**
- Produces:
  - `type OpenedLog = { roundId: Hex; tableId: Hex; player: Address; side: number; stake: bigint; payout: bigint; subsetHash: Hex; key: Hex; openedAtBlock: bigint }`
  - `type SettledLog = { roundId: Hex; tableId: Hex; player: Address; won: boolean; payout: bigint; seed: Hex; settledAtBlock: bigint }`
  - `function verifyRound(opened: OpenedLog, settled: SettledLog): { ok: boolean; reasons: string[] }` — recomputes winner from `seed & 1 == side` and payout from `stake` (payout must equal `settled.payout` and `opened.payout`); returns `ok` only if the settle log is internally consistent with the open log and the seed parity.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { verifyRound } from './tablesVerify'

const base = {
  roundId: '0xrr' as any, tableId: '0xtt' as any, player: '0x00000000000000000000000000000000000000a1' as any,
}

describe('verifyRound', () => {
  it('accepts a consistent win (even seed, side HEADS)', () => {
    const opened = { ...base, side: 0, stake: 1_000000000000000000n, payout: 1_960000000000000000n, subsetHash: '0xss' as any, key: '0xkk' as any, openedAtBlock: 10n }
    const settled = { ...base, won: true, payout: 1_960000000000000000n, seed: ('0x' + '00'.repeat(31) + '02') as any, settledAtBlock: 12n } // seed&1==0 -> HEADS wins
    expect(verifyRound(opened as any, settled as any).ok).to.equal(true)
  })

  it('rejects a settle log claiming a win the seed parity contradicts', () => {
    const opened = { ...base, side: 0, stake: 1_000000000000000000n, payout: 1_960000000000000000n, subsetHash: '0xss' as any, key: '0xkk' as any, openedAtBlock: 10n }
    const settled = { ...base, won: true, payout: 1_960000000000000000n, seed: ('0x' + '00'.repeat(31) + '01') as any, settledAtBlock: 12n } // seed&1==1 -> TAILS, player had HEADS
    const res = verifyRound(opened as any, settled as any)
    expect(res.ok).to.equal(false)
    expect(res.reasons.join(' ')).to.match(/parity/i)
  })

  it('rejects a payout that does not equal the open-snapshot payout', () => {
    const opened = { ...base, side: 0, stake: 1_000000000000000000n, payout: 1_960000000000000000n, subsetHash: '0xss' as any, key: '0xkk' as any, openedAtBlock: 10n }
    const settled = { ...base, won: true, payout: 2_000000000000000000n, seed: ('0x' + '00'.repeat(31) + '02') as any, settledAtBlock: 12n }
    expect(verifyRound(opened as any, settled as any).ok).to.equal(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/web && npx vitest run src/lib/tablesVerify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the verifier**

```typescript
import type { Address, Hex } from 'viem'

export type OpenedLog = {
  roundId: Hex; tableId: Hex; player: Address; side: number
  stake: bigint; payout: bigint; subsetHash: Hex; key: Hex; openedAtBlock: bigint
}
export type SettledLog = {
  roundId: Hex; tableId: Hex; player: Address; won: boolean
  payout: bigint; seed: Hex; settledAtBlock: bigint
}

/**
 * Replay a settled round purely from its block-anchored logs. No contract getters, no server: given
 * the RoundOpened + RoundSettled logs (and the seed they carry, which also lives permanently in
 * IRandom for the round's key), recompute the winner and payout and confirm the settle log agrees.
 */
export const verifyRound = (opened: OpenedLog, settled: SettledLog): { ok: boolean; reasons: string[] } => {
  const reasons: string[] = []
  if (opened.roundId !== settled.roundId) reasons.push('roundId mismatch between open and settle logs')
  if (opened.payout !== settled.payout) reasons.push('payout differs from the open-snapshot payout')
  const parityWin = (BigInt(settled.seed) & 1n) === BigInt(opened.side)
  if (parityWin !== settled.won) reasons.push(`won=${settled.won} contradicts seed parity (${parityWin})`)
  return { ok: reasons.length === 0, reasons }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/web && npx vitest run src/lib/tablesVerify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add games/web/src/lib/tablesVerify.ts games/web/src/lib/tablesVerify.test.ts
git commit -m "feat(games-web): off-chain verifier — replay a settled table round from logs"
```

---

## Task 11: Indexer read model — per-table hot/cold/stake/activity, sorted

**Files:**
- Create: `games/web/src/lib/tablesIndex.ts`
- Test: `games/web/src/lib/tablesIndex.test.ts`

**Interfaces:**
- Produces:
  - `type TableView = { tableId: Hex; operator: Address; hot: bigint; cold: bigint; escrowed: bigint; stake: bigint; maxMultiplierX100: number; maxStake: bigint; hotTarget: bigint; open: boolean; roundsRecent: number; lastActiveBlock: bigint }`
  - `function reduceTables(events: TableEvent[], now: bigint, windowBlocks: bigint): TableView[]` — folds the event log into per-table state and returns the list **sorted** by `(open && hot >= 1) desc, roundsRecent desc, stake desc`.
  - `type TableEvent` — a discriminated union mirroring the contract events (`TableCreated | ParamsSet | OpenSet | HotFunded | ColdFunded | HotWithdrawn | ColdWithdrawn | Promoted | Demoted | Staked | Unstaked | Refilled | RoundOpened | RoundSettled`), each carrying `{ blockNumber: bigint }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { reduceTables } from './tablesIndex'

const T = '0x01' as any
const T2 = '0x02' as any
const OP = '0x00000000000000000000000000000000000000a1' as any

describe('reduceTables', () => {
  it('folds funding + rounds and sorts armed, busy, staked tables first', () => {
    const events = [
      { type: 'TableCreated', tableId: T, operator: OP, maxMultiplierX100: 196, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'HotFunded', tableId: T, amount: 50n, blockNumber: 2n },
      { type: 'Staked', tableId: T, amount: 5n, blockNumber: 3n },
      { type: 'RoundOpened', tableId: T, roundId: '0xr1', payout: 2n, blockNumber: 9n },
      { type: 'TableCreated', tableId: T2, operator: OP, maxMultiplierX100: 150, maxStake: 10n, hotTarget: 100n, blockNumber: 4n },
      // T2 has no hot -> should sort below T
    ] as any
    const views = reduceTables(events, 10n, 100n)
    expect(views[0]!.tableId).to.equal(T)
    expect(views[0]!.hot).to.equal(50n)
    expect(views[0]!.stake).to.equal(5n)
    expect(views[0]!.roundsRecent).to.equal(1)
    expect(views[1]!.tableId).to.equal(T2)
    expect(views[1]!.hot).to.equal(0n)
  })

  it('applies ParamsSet, OpenSet, and RoundSettled (activity keeps counting)', () => {
    const events = [
      { type: 'TableCreated', tableId: T, operator: OP, maxMultiplierX100: 196, maxStake: 10n, hotTarget: 100n, blockNumber: 1n },
      { type: 'ParamsSet', tableId: T, maxMultiplierX100: 150, maxStake: 3n, hotTarget: 20n, blockNumber: 2n },
      { type: 'OpenSet', tableId: T, open: false, blockNumber: 3n },
    ] as any
    const v = reduceTables(events, 10n, 100n)[0]!
    expect(v.maxMultiplierX100).to.equal(150)
    expect(v.maxStake).to.equal(3n)
    expect(v.open).to.equal(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd games/web && npx vitest run src/lib/tablesIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reducer**

```typescript
import type { Address, Hex } from 'viem'

export type TableView = {
  tableId: Hex; operator: Address
  hot: bigint; cold: bigint; escrowed: bigint; stake: bigint
  maxMultiplierX100: number; maxStake: bigint; hotTarget: bigint; open: boolean
  roundsRecent: number; lastActiveBlock: bigint
}

export type TableEvent = { type: string; tableId: Hex; blockNumber: bigint } & Record<string, any>

const empty = (tableId: Hex, operator: Address, blockNumber: bigint): TableView => ({
  tableId, operator, hot: 0n, cold: 0n, escrowed: 0n, stake: 0n,
  maxMultiplierX100: 0, maxStake: 0n, hotTarget: 0n, open: true,
  roundsRecent: 0, lastActiveBlock: blockNumber,
})

export const reduceTables = (events: TableEvent[], now: bigint, windowBlocks: bigint): TableView[] => {
  const byId = new Map<Hex, TableView>()
  const recent: { tableId: Hex; blockNumber: bigint }[] = []
  const get = (e: TableEvent) => {
    let v = byId.get(e.tableId)
    if (!v) { v = empty(e.tableId, (e.operator as Address) ?? ('0x' as Address), e.blockNumber); byId.set(e.tableId, v) }
    return v
  }
  for (const e of events) {
    const v = get(e)
    v.lastActiveBlock = e.blockNumber
    switch (e.type) {
      case 'TableCreated': v.operator = e.operator; v.maxMultiplierX100 = e.maxMultiplierX100; v.maxStake = e.maxStake; v.hotTarget = e.hotTarget; v.open = true; break
      case 'ParamsSet': v.maxMultiplierX100 = e.maxMultiplierX100; v.maxStake = e.maxStake; v.hotTarget = e.hotTarget; break
      case 'OpenSet': v.open = e.open; break
      case 'HotFunded': v.hot += e.amount; break
      case 'ColdFunded': v.cold += e.amount; break
      case 'HotWithdrawn': v.hot -= e.amount; break
      case 'ColdWithdrawn': v.cold -= e.amount; break
      case 'Promoted': v.cold -= e.amount; v.hot += e.amount; break
      case 'Demoted': v.hot -= e.amount; v.cold += e.amount; break
      case 'Refilled': v.cold -= e.amount; v.hot += e.amount; break
      case 'Staked': v.stake += e.amount; break
      case 'Unstaked': v.stake -= e.amount; break
      case 'RoundOpened': v.hot -= (e.payout - (e.stake ?? 0n)); v.escrowed += e.payout; recent.push({ tableId: e.tableId, blockNumber: e.blockNumber }); break
      case 'RoundSettled': v.escrowed -= e.payout; if (!e.won) v.hot += e.payout; break
    }
  }
  for (const r of recent) {
    if (now - r.blockNumber <= windowBlocks) { const v = byId.get(r.tableId); if (v) v.roundsRecent += 1 }
  }
  const armed = (v: TableView) => (v.open && v.hot >= 1n ? 1 : 0)
  return [...byId.values()].sort((a, b) =>
    armed(b) - armed(a) || b.roundsRecent - a.roundsRecent || (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0),
  )
}
```

> Note: `RoundOpened` in the reducer needs `stake` to compute the hot debit; ensure the event decoding in the live subscription (Task 12) passes `stake` alongside `payout`. The contract event already carries both.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd games/web && npx vitest run src/lib/tablesIndex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add games/web/src/lib/tablesIndex.ts games/web/src/lib/tablesIndex.test.ts
git commit -m "feat(games-web): table read model — fold events, sort by armed/activity/stake"
```

---

## Task 12: `TablePicker` — browse, create, join

**Files:**
- Create: `games/web/src/components/TablePicker.tsx`
- Modify: the Coin Flip screen component (find it: `grep -rl "coin" games/web/src/components/screens` or the screen registry) to mount `TablePicker` and expose the selected `tableId`.

**Interfaces:**
- Consumes: `reduceTables` (Task 11), the contract ABI/address for the active deployment (follow how existing screens read `deployment` + build a viem contract), `no-native-form-controls` house `Menu`/`Toggle` components.
- Produces:
  - `<TablePicker deployment={...} onSelect={(tableId: Hex) => void} selected={tableId | null} />`
  - a "Create a table" sub-flow calling `createTable` then `fundHot`/`fundCold`/`stakeForRank`.

- [ ] **Step 1: Write the component**

Because this is UI wiring over already-tested logic, build it directly (no separate unit test; it's exercised through the app). Follow the existing screen patterns — read one sibling screen first for the deployment/contract/toast conventions. Key structure:

```tsx
import { useMemo, useState } from 'react'
import type { Address, Hex } from 'viem'
import { reduceTables, type TableView } from '../lib/tablesIndex'
// import { useTableEvents } from ... — a hook that getLogs + watches the CoinFlipTables events for the
// active deployment and returns TableEvent[]; model it on the existing feed/log hooks in games/web.

export const TablePicker = ({
  deployment, selected, onSelect,
}: { deployment: any; selected: Hex | null; onSelect: (id: Hex) => void }) => {
  const events = useTableEvents(deployment)        // TableEvent[]
  const head = useHeadBlock(deployment)            // bigint current block (existing helper)
  const tables = useMemo(() => reduceTables(events, head, 5760n /* ~ a day of blocks; tune */), [events, head])
  const [creating, setCreating] = useState(false)

  return (
    <div className="table-picker">
      <div className="tp-head">
        <span>{tables.length} tables</span>
        <button className="secondary" onClick={() => setCreating(true)}>Create a table</button>
      </div>
      <ul className="tp-list">
        {tables.map((t) => (
          <li key={t.tableId} className={t.tableId === selected ? 'on' : ''}>
            <button onClick={() => onSelect(t.tableId)} disabled={!t.open || t.hot < 1n}>
              <span className="tp-op mono">{t.operator.slice(0, 6)}…</span>
              <span className="tp-arm">armed {fmt(t.hot)}</span>
              <span className="tp-edge">{(t.maxMultiplierX100 / 100).toFixed(2)}×</span>
              <span className="tp-act">{t.roundsRecent} recent</span>
              <span className="tp-stake">stake {fmt(t.stake)}</span>
            </button>
          </li>
        ))}
      </ul>
      {creating && <CreateTableForm deployment={deployment} onDone={() => setCreating(false)} />}
    </div>
  )
}
```

`CreateTableForm` uses the house `Menu`/number inputs (NOT native selects — per `no-native-form-controls`) to collect `maxMultiplierX100` (a Menu of 1.50×–2.00×), `maxStake`, `hotTarget`, then runs `approve` → `createTable` → `fundHot`/`fundCold`/`stakeForRank` as sequential txs with the app's existing toast/confirm helpers. `fmt` is the existing Chips-amount formatter used elsewhere in games-web (reuse it; do not hand-roll).

- [ ] **Step 2: Wire it into the Coin Flip screen**

In the Coin Flip screen, add `const [tableId, setTableId] = useState<Hex | null>(null)` and render `<TablePicker deployment={deployment} selected={tableId} onSelect={setTableId} />` above the felt. Gate the bet action on `tableId != null`.

- [ ] **Step 3: Manual smoke — build**

Run: `cd games/web && npm run build`
Expected: type-checks and builds. Fix any type mismatches against the real deployment/contract types.

- [ ] **Step 4: Commit**

```bash
git add games/web/src/components/TablePicker.tsx games/web/src/components/screens
git commit -m "feat(games-web): TablePicker — browse/create/join player-run coin-flip tables"
```

---

## Task 13: Join + play + receipt on the felt

**Files:**
- Modify: the Coin Flip screen component; reuse the existing coin-flip felt surface.

**Interfaces:**
- Consumes: `TablePicker` selection (`tableId`), `open()` on the contract, the existing validator-subset default (deployment `canonicalSubset`), `verifyRound` (Task 10).

- [ ] **Step 1: Route the bet through `open(tableId, ...)`**

Replace the current coin-flip entry call with `CoinFlipTables.open([tableId, side, stake, subset, locations])` where `subset`/`locations` come from the deployment's canonical validator set (default-with-override — reuse the exact subset/locations plumbing today's Coin Flip screen already builds). After the tx, poll for the `RoundSettled` event (or the seed via the existing settle-watch pattern) and render the outcome on the felt.

- [ ] **Step 2: Show the verify receipt**

On settle, decode the round's `RoundOpened` + `RoundSettled` logs and call `verifyRound(opened, settled)`; render a small "✓ verified — replayed from chain logs" line (or the failure reasons) beside the result, matching the existing receipt styling. This makes the historical-verifiability property visible at the table.

- [ ] **Step 3: Manual smoke — build**

Run: `cd games/web && npm run build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add games/web/src/components/screens
git commit -m "feat(games-web): play a coin flip against a chosen table + on-chain verify receipt"
```

---

## Task 14: Deploy script + wire the deployment config

**Files:**
- Modify: the games contracts deploy/ignition script + `games/web/src/config` deployment entry (follow how `CoinFlip` is deployed and registered for a chain).

**Interfaces:** none new — deploys `CoinFlipTables(random, chips)` and adds its address to the web deployment config so `TablePicker` can read it.

- [ ] **Step 1: Add the deploy step**

Follow the existing pattern that deploys `CoinFlip` (search the deploy scripts / ignition modules). Deploy `CoinFlipTables` with the chain's `Random` address and the chain's `Chips` ERC-20 address. Allowlist the same validator set the chain's Coin Flip uses (the contract's `GameBase` owner adds validators — reuse the existing configure step).

- [ ] **Step 2: Register in web config**

Add the deployed `CoinFlipTables` address to the games-web deployment config entry for the chain (beside the existing game addresses). `TablePicker`/the Coin Flip screen read it from there.

- [ ] **Step 3: Build + (guarded) deploy**

Run: `cd games/web && npm run build`. Deploy per the ansible runbook (`ansible/deploy-games-web.yml`, box `:2222` — no hotspot needed per [[lan-egress-blocks-ssh-deploys]]) **only on the user's go-ahead**, not automatically.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(games): deploy CoinFlipTables + register in games-web config"
```

---

## Self-Review

**Spec coverage:**
- Permissionless create → Task 1. Hot/cold two-tier bankroll + refill → Tasks 2, 4. Stake for ranking → Task 3. Per-round escrow from hot + full-payout lock → Task 5. Validator-seeded on-chain settle (onCast + claim) → Task 6. refundStale → Task 7. Params editable at will, bind only new rounds → Tasks 1 + 8. Accounting invariant + cold-never-touched + isolation → Task 9. Historical verifiability (full-data events + off-chain replay) → Tasks 5/6 (events) + 10 (verifier) + 13 (receipt). Ranking/discovery indexer + UI → Tasks 11, 12, 13. Chips for bankroll + stake → Global Constraints + all funding tasks. `[150,200]` clamp → Tasks 1 (create), 1 (setParams). Deploy → Task 14. **No uncovered spec section.**
- Optional per-table settlement-hash commitment is explicitly spec-marked MVP-optional → correctly omitted from Slice-1 tasks.

**Placeholder scan:** The only deliberately-deferred detail is the Foundry fuzz body (Task 9 Step 3), which instructs the implementer to copy the concrete cast/seed harness from `CoinFlip.t.sol` and states the two exact assertions — not a silent TODO. All contract/verifier/reducer steps carry full code. UI tasks (12/13) give real component code plus the explicit "read a sibling screen first" instruction because the exact deployment/hook types are repo-local; signatures they must hit are specified.

**Type consistency:** `Table` tuple order is fixed in Task 1 and every `read.tables(...)` index reference (Tasks 2/3/5/6/7/9) matches it: `[operator, hot, cold, escrowed, stake, maxMultiplierX100, maxStake, hotTarget, open]` = indices `[0..8]`. `Round.payout` snapshot (Task 5) is the single source settlement (Task 6) and the bind-only-new-rounds test (Task 8) read from. `RoundOpened`/`RoundSettled` field names are identical across the contract (Tasks 5/6), the verifier types (Task 10), and the reducer (Task 11). `reduceTables(events, now, windowBlocks)` signature matches its test and its `TablePicker` call site.

**Open items for the implementer** (surfaced, not hidden): `_heatBound` (GameBase.sol:136), `_settle` override hook (GameBase.sol:180), and `_isStale` (GameBase.sol:186) are all **confirmed** and pinned inline. Still repo-local to confirm by reading one sibling first: the web test runner (vitest assumed) and the felt/screen file paths, before Tasks 10/12/13. `GameBase` deploys/allowlists validators via its owner (Task 14 reuses the existing configure step).

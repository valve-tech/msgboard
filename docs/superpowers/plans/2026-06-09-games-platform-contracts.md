# Games Platform — On-Chain Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a shared `GameBase` contract from the existing `CoinFlip`, rework `CoinFlip` to validator-only entropy on top of it, and add a `Raffle` (closest-guess) game — all with Hardhat + viem tests — so two provably-fair games share one audited base.

**Architecture:** `GameBase is ConsumerReceiver` holds the five shared pieces (core Random reference, native escrow helpers, an owner-managed validator allowlist behind a swappable seam, the binding-plus-membership heat helper `_heatBound`, the `onCast` dispatch reverse-index with its guards, and the timeout-recovery surface). `CoinFlip is GameBase` and `Raffle is GameBase` add only their own matching, entry structs, and `_settle` body. Validator-only entropy means the games ink nothing and contribute nothing to the seed; players commit for scoring only.

**Tech Stack:** Solidity 0.8.25 (viaIR, optimizer 1000 runs, **evmVersion shanghai** for every deployed game contract — chain 943 rejects MCOPY/TSTORE), Hardhat 2.22 + `hardhat-toolbox-viem`, viem, Mocha/Chai, solady `SafeTransferLib`. All contracts live in `~/Documents/gibsfinance/github/random/packages/contracts`.

**Repository note:** The contract repo is `gibsfinance/github/random`, NOT the msgboard repo this plan file lives in. Every path below is relative to `~/Documents/gibsfinance/github/random/packages/contracts` unless stated otherwise. Run all commands from that directory.

**Spec:** `~/Documents/valve-tech/github/msgboard/docs/superpowers/specs/2026-06-09-games-platform-design.md`

---

## Pre-flight: read these before starting

The implementer should open and read, in `packages/contracts`:

- `contracts/CoinFlip.sol` — the contract being split. Its matching, escrow, `onCast`/`claim`/`refundStale`, and tombstone-scan logic are the source material for `GameBase` and the reworked `CoinFlip`.
- `contracts/implementations/ConsumerReceiver.sol` — the abstract base both games already declare (`onReverse`, `onCast`, `onChop`).
- `contracts/implementations/IRandom.sol` — the `heat` / `randomness` signatures the games call.
- `contracts/PreimageLocation.sol` — the `Info` struct and `location`/`section` helpers.
- `contracts/Random.sol` lines 539–711 — `chop`, `cast`, `_call`, `_shouldCall`, `_random`. Confirms: `cast` sets `seed = keccak256(concat(revealed secrets))` and fires `onCast(key, seed)` only when no secret is missing; `chop` only acts (and fires `onChop(key)`) when `_seed[key] == 0` (seed never formed). `_call` swallows a reverting callback.
- `test/utils.ts` — the `deploy` fixture, `inkValidatorPool`, `confirmTx`, `createTestPreimages`, `selectPreimages`, and `contractName` usage.
- `test/expectations.ts` — `revertedWithCustomError`, `emit`, `not.emit`, `changeEtherBalances`.
- `test/CoinFlip.test.ts` — the existing test patterns to mirror.
- `lib/utils.ts` — `contractName` registry, `defaultSection`, `toSeed`, `createTestPreimages`.
- `hardhat.config.ts` — the `solidity.overrides` block (the shanghai/943 nuance).

### Design facts that the tasks below depend on

1. **The seed.** Core Random sets `seed = keccak256(concat(revealed 32-byte secrets))` (`Random.sol:665`). On-chain, games read it via `IRandom(random).randomness(key).seed`. Off-chain (Plan 2) the same value is `keccak256(concatHex(secrets))` — already the `toSeed` helper in `lib/utils.ts`.
2. **`onCast` fires only on a fully-formed seed**; `onChop` fires only when the seed never formed. So a "no-contest" round (seed exists, zero player reveals) had no chopped validator — the no-contest pot goes to the whole declared subset. A chopped round (`onChop`) is a liveness failure → the refund path.
3. **`heat(required, settings, info[], useTSTORE)`** returns the request key. `required` is the secret count. `settings.callAtChange = true` is what arms the `onCast` callback; `settings.provider = address(this)` names the game as request owner.
4. **A validator's preimages are inked under the validator's own address** as `provider` at a price-0 section (see `inkValidatorPool` in `test/utils.ts`). So a heat location's `provider` field *is* the validator address — which is what `_heatBound` binds against.
5. **Abstract contracts cannot be deployed.** `GameBase` is abstract; its internal helpers are exercised through a concrete `contracts/test/GameBaseHarness.sol` that exposes them.

---

## File structure

Create:
- `contracts/IValidatorRegistry.sol` — the swappable allowlist seam (interface).
- `contracts/GameBase.sol` — the shared abstract base.
- `contracts/Raffle.sol` — the closest-guess raffle game.
- `contracts/test/GameBaseHarness.sol` — concrete subclass exposing `GameBase` internals for unit tests.
- `test/GameBase.test.ts` — `GameBase` unit tests (via the harness).
- `test/Raffle.test.ts` — `Raffle` unit tests + security-invariant tests.

Modify:
- `contracts/CoinFlip.sol` — rework to `is GameBase`, delete player-secret machinery, add the per-instance validator subset.
- `test/CoinFlip.test.ts` — update for the new entry shape and subset parameter.
- `test/utils.ts` — add `Raffle` and `GameBaseHarness` to the deploy fixture and a `setUpValidators` helper.
- `lib/utils.ts` — add `GameBase`, `Raffle`, `GameBaseHarness` to `contractName`.
- `hardhat.config.ts` — add shanghai `overrides` for `GameBase.sol`, `Raffle.sol`, the harness.
- `ignition/modules/` — add a `Raffle.ts` deployment module (mirrors `CoinFlip.ts`).

---

## Part A — GameBase and the CoinFlip rework

### Task 1: Register the new contracts and set the compiler overrides

**Files:**
- Modify: `lib/utils.ts` (the `contractName` object, around line 204)
- Modify: `hardhat.config.ts` (the `solidity.overrides` block)

- [ ] **Step 1: Add the new names to the `contractName` registry**

In `lib/utils.ts`, inside the `contractName` object, add three entries beside `CoinFlip`:

```ts
  CoinFlip: 'contracts/CoinFlip.sol:CoinFlip',
  GameBase: 'contracts/GameBase.sol:GameBase',
  Raffle: 'contracts/Raffle.sol:Raffle',
  GameBaseHarness: 'contracts/test/GameBaseHarness.sol:GameBaseHarness',
```

- [ ] **Step 2: Add shanghai overrides so the deployed games run on chain 943**

In `hardhat.config.ts`, the `solidity.overrides` object currently has one key, `'contracts/CoinFlip.sol'`. Add the same shanghai settings for the new game files (copy the exact settings object already used for `CoinFlip.sol`):

```ts
    overrides: {
      'contracts/CoinFlip.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
      'contracts/GameBase.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
      'contracts/Raffle.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
      'contracts/test/GameBaseHarness.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
    },
```

> Why: the override on a file applies to its compilation job, and imports are compiled in that job. Without the shanghai override, viaIR + cancun emits MCOPY, which reverts on 943 as "invalid opcode: MCOPY." `GameBase` is inherited by both games; pinning it shanghai keeps the inherited bytecode 943-safe.

- [ ] **Step 3: Commit**

```bash
git add lib/utils.ts hardhat.config.ts
git commit -m "build: register GameBase/Raffle, shanghai overrides for 943"
```

---

### Task 2: The IValidatorRegistry seam

**Files:**
- Create: `contracts/IValidatorRegistry.sol`

- [ ] **Step 1: Write the interface**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice The swappable allowlist seam. GameBase reads validator membership through this shape;
/// version one answers it from an owner-managed mapping inside GameBase itself, but a later
/// version can point GameBase at an external multisig- or bond-governed registry implementing
/// this interface without touching either game.
interface IValidatorRegistry {
    function isValidator(address account) external view returns (bool);
}
```

- [ ] **Step 2: Compile**

Run: `npx hardhat compile`
Expected: compiles clean (no contract uses it yet; this just verifies syntax).

- [ ] **Step 3: Commit**

```bash
git add contracts/IValidatorRegistry.sol
git commit -m "feat: IValidatorRegistry allowlist seam"
```

---

### Task 3: GameBase — escrow, allowlist, ownership

Build `GameBase` incrementally. This task lands the contract with ownership, the allowlist, and escrow; later tasks add `_heatBound` and the dispatch surface. Tests run through the harness.

**Files:**
- Create: `contracts/GameBase.sol`
- Create: `contracts/test/GameBaseHarness.sol`
- Create: `test/GameBase.test.ts`
- Modify: `test/utils.ts` (deploy the harness)

- [ ] **Step 1: Write `GameBase.sol` with ownership, allowlist, and escrow**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ConsumerReceiver} from "./implementations/ConsumerReceiver.sol";
import {IRandom} from "./implementations/IRandom.sol";
import {PreimageLocation} from "./PreimageLocation.sol";

/// @notice Shared base for the games platform. Holds everything CoinFlip and Raffle share and
/// nothing game-specific: the core Random reference, native-token escrow helpers, an owner-managed
/// validator allowlist (read through a swappable seam), the binding-plus-membership heat helper,
/// the onCast dispatch reverse index with its guards, and the timeout-recovery surface. The games
/// ink nothing and contribute nothing to the seed — entropy is validator-only and pinned.
abstract contract GameBase is ConsumerReceiver {
    using SafeTransferLib for address;

    error OnlyRandom();
    error OnlyOwner();
    error NotAllowlisted();
    error BadSubset();
    error SubsetMismatch();
    error StakeMismatch();

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);

    /// @notice core Random.
    address public immutable random;
    /// @notice owner address controlling the validator allowlist and fees (a plain address in v1).
    address public owner;

    /// @notice the owner-managed allowlist (the validator "universe"). Read through _isAllowlisted
    /// so a future version can override to delegate to an external IValidatorRegistry.
    mapping(address validator => bool allowed) public isValidator;
    uint256 public validatorCount;

    /// @notice minimum distinct validators a game instance's declared subset must span. The
    /// safety floor: a subset with at least one honest validator defeats selection-grinding.
    uint256 public constant MIN_SUBSET = 3;

    /// @notice blocks after a draw is armed before its escrow becomes reclaimable if the seed
    /// never finalizes (the liveness timeout). Matches the prior CoinFlip constant.
    uint256 public constant STALE_BLOCKS = 200;

    /// @notice canonical heat settings: native token, price 0, fixed duration. The duration is the
    /// expiry window the cast must land within.
    bool internal constant DURATION_IS_TIMESTAMP = false;
    uint256 public constant HEAT_DURATION = 12;
    address internal constant HEAT_TOKEN = address(0);

    /// @notice reverse index from a Random request key to the game instance it settles.
    mapping(bytes32 key => bytes32 instanceId) public instanceByKey;
    /// @notice instances whose draw was chopped at expiry (seed never formed) — a liveness failure.
    mapping(bytes32 instanceId => bool chopped) public choppedInstance;

    constructor(address _random) {
        random = _random;
        owner = msg.sender;
        emit OwnerTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addValidator(address validator) external onlyOwner {
        if (!isValidator[validator]) {
            isValidator[validator] = true;
            unchecked { ++validatorCount; }
            emit ValidatorAdded(validator);
        }
    }

    function removeValidator(address validator) external onlyOwner {
        if (isValidator[validator]) {
            isValidator[validator] = false;
            unchecked { --validatorCount; }
            emit ValidatorRemoved(validator);
        }
    }

    /// @notice The swappable membership seam. Defaults to the local owner-managed allowlist.
    function _isAllowlisted(address validator) internal view virtual returns (bool) {
        return isValidator[validator];
    }

    // --- native-token escrow ---

    /// @notice Assert the value sent equals the expected stake. Native escrow needs no pull: the
    /// value already arrived with the call. This validates at the boundary and fails fast.
    function _take(uint256 expected) internal view {
        if (msg.value != expected) revert StakeMismatch();
    }

    /// @notice Pay a winner.
    function _pay(address to, uint256 amount) internal {
        to.safeTransferETH(amount);
    }

    /// @notice Refund an escrowed stake.
    function _refund(address to, uint256 amount) internal {
        to.safeTransferETH(amount);
    }

    // --- ConsumerReceiver callbacks (filled in by Task 5) ---
    function onReverse(bytes32, address, uint256) external virtual override {}
}
```

- [ ] **Step 2: Write the test harness**

`contracts/test/GameBaseHarness.sol`:

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameBase} from "../GameBase.sol";
import {PreimageLocation} from "../PreimageLocation.sol";

/// @notice Concrete GameBase so its internals can be unit-tested (GameBase is abstract). Exposes
/// the escrow, subset-validation, and heat helpers, and supplies the abstract members.
contract GameBaseHarness is GameBase {
    bytes32 public lastSettledInstance;
    bytes32 public lastSettledSeed;

    constructor(address _random) GameBase(_random) {}

    function takeStake(uint256 expected) external payable {
        _take(expected);
    }

    function payOut(address to, uint256 amount) external {
        _pay(to, amount);
    }

    function validateSubset(address[] calldata subset) external view {
        _validateSubset(subset);
    }

    function heatBound(address[] calldata subset, PreimageLocation.Info[] calldata locations)
        external
        returns (bytes32 key)
    {
        key = _heatBound(subset, locations);
    }

    function bindInstance(bytes32 key, bytes32 instanceId) external {
        instanceByKey[key] = instanceId;
    }

    function _settle(bytes32 instanceId, bytes32 seed) internal override {
        lastSettledInstance = instanceId;
        lastSettledSeed = seed;
    }

    // accept escrow in tests
    receive() external payable {}
}
```

> `_validateSubset`, `_heatBound`, and `_settle` are added to `GameBase` in Tasks 4 and 5; this harness references them so it will not compile until those land. That is expected — Step 4 of this task only tests escrow and the allowlist. Comment out the `validateSubset`, `heatBound`, and `_settle` members for now, OR write the harness in full and accept that `npx hardhat compile` fails until Task 5. **Choose: write the harness in full now and let Task 5 close the loop; tests added in this task only call escrow/allowlist methods.** To keep this task green, temporarily stub the three not-yet-existing members:

Replace the three forward-referencing members with stubs for this task only (Task 5 replaces them):

```solidity
    function validateSubset(address[] calldata) external view {}
    function heatBound(address[] calldata, PreimageLocation.Info[] calldata) external returns (bytes32) { return bytes32(0); }
    function _settle(bytes32, bytes32) internal {}
```

- [ ] **Step 3: Deploy harness + Raffle placeholders in the fixture**

In `test/utils.ts`, in the `deploy` function after `const coinFlip = ...`, add:

```ts
  const gameBaseHarness = await hre.viem.deployContract(contractName.GameBaseHarness, [random.address])
```

and add `gameBaseHarness` to the `deployedContracts` object.

- [ ] **Step 4: Write the failing test for escrow and the allowlist**

`test/GameBase.test.ts`:

```ts
import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'

describe('GameBase', () => {
  describe('ownership and allowlist', () => {
    it('sets the deployer as owner', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const owner = await ctx.gameBaseHarness.read.owner()
      expect(viem.getAddress(owner)).to.equal(viem.getAddress(ctx.signers[0].account.address))
    })

    it('lets the owner add and remove validators and tracks the count', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const v = ctx.signers[5].account.address
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.addValidator([v]))
      expect(await ctx.gameBaseHarness.read.isValidator([v])).to.equal(true)
      expect(await ctx.gameBaseHarness.read.validatorCount()).to.equal(1n)
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.removeValidator([v]))
      expect(await ctx.gameBaseHarness.read.isValidator([v])).to.equal(false)
      expect(await ctx.gameBaseHarness.read.validatorCount()).to.equal(0n)
    })

    it('rejects allowlist changes from a non-owner', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.addValidator([ctx.signers[5].account.address], { account: ctx.signers[1].account }),
        'OnlyOwner',
      )
    })
  })

  describe('escrow', () => {
    it('accepts a matching stake and reverts a mismatch', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.takeStake([viem.parseEther('1')], { value: viem.parseEther('1') }))
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.takeStake([viem.parseEther('1')], { value: viem.parseEther('2') }),
        'StakeMismatch',
      )
    })
  })
})
```

- [ ] **Step 5: Run the test to verify it fails, then compiles and passes**

Run: `npx hardhat test test/GameBase.test.ts`
Expected first run: FAIL (contracts not compiled / `gameBaseHarness` undefined). After Steps 1–3 are in place, re-run.
Expected: PASS for all five tests.

- [ ] **Step 6: Commit**

```bash
git add contracts/GameBase.sol contracts/test/GameBaseHarness.sol test/GameBase.test.ts test/utils.ts
git commit -m "feat: GameBase ownership, allowlist, escrow"
```

---

### Task 4: GameBase — subset validation and `_heatBound`

**Files:**
- Modify: `contracts/GameBase.sol`
- Modify: `contracts/test/GameBaseHarness.sol` (replace the `validateSubset`/`heatBound` stubs with real forwards)
- Modify: `test/GameBase.test.ts`
- Modify: `test/utils.ts` (add a `setUpValidators` helper)

- [ ] **Step 1: Write the failing tests for subset validation and bound heat**

Add a helper to `test/utils.ts` that allowlists a set of the always-on randomness providers and inks one price-0 pool per provider, returning the per-validator location and secret so a test can build a heat selection:

```ts
/**
 * Allowlist `count` of the always-on randomness providers on a GameBase-derived contract and ink
 * one price-0 preimage per provider under that provider's own address. Returns, per validator, the
 * address, its heat location (offset 0, index 0), and its secret — the shape a declared subset and
 * its heat selection take.
 */
export const setUpValidators = async (
  ctx: Context,
  game: viem.GetContractReturnType,
  count = 3,
) => {
  const rand = await ctx.hre.viem.getContractAt(contractName.Random, ctx.random.address)
  const providers = (await getRandomnessProviders(ctx.hre)).slice(0, count)
  const validators = await Promise.all(
    providers.map(async (provider) => {
      await confirmTx(ctx, game.write.addValidator([provider.account!.address]))
      const section = {
        ...utils.defaultSection,
        provider: provider.account!.address,
        price: 0n,
        offset: 0n,
        index: 0n,
      }
      const secret = viem.keccak256(viem.toHex(`gamebase-validator-${provider.account!.address}`))
      const preimage = viem.keccak256(secret)
      await confirmTx(
        ctx,
        rand.write.ink([section, preimage], { account: provider.account!, value: 0n }),
      )
      return { address: provider.account!.address, location: { ...section, index: 0n }, secret, preimage }
    }),
  )
  return {
    subset: validators.map((v) => v.address),
    locations: validators.map((v) => v.location),
    secrets: validators.map((v) => v.secret),
    validators,
  }
}
```

Add to `test/GameBase.test.ts`:

```ts
  describe('subset validation', () => {
    it('accepts a distinct allowlisted subset of at least MIN_SUBSET', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await ctx.gameBaseHarness.read.validateSubset([subset]) // view; no revert == pass
    })

    it('rejects a subset smaller than MIN_SUBSET', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.validateSubset([subset.slice(0, 2)]),
        'BadSubset',
      )
    })

    it('rejects a subset with a duplicate', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.validateSubset([[subset[0], subset[1], subset[0]]]),
        'BadSubset',
      )
    })

    it('rejects a non-allowlisted member', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      const outsider = ctx.signers[9].account.address
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.validateSubset([[subset[0], subset[1], outsider]]),
        'NotAllowlisted',
      )
    })
  })

  describe('_heatBound', () => {
    it('heats when locations equal the declared subset and returns a key', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      const receipt = await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.heatBound([subset, locations]))
      const starts = await ctx.random.getEvents.Start({}, { blockHash: receipt.blockHash })
      expect(starts.length).to.equal(1)
    })

    it('reverts when a location provider does not match the declared subset (bait-and-switch)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      const swapped = [locations[0], locations[1], { ...locations[2], provider: subset[0] }]
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.heatBound([subset, swapped]),
        'SubsetMismatch',
      )
    })

    it('reverts when location count differs from the subset (no slack)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.heatBound([subset, locations.slice(0, 2)]),
        'SubsetMismatch',
      )
    })

    it('reverts when a subset member was de-allowlisted after creation', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.gameBaseHarness, 3)
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.removeValidator([subset[2]]))
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.heatBound([subset, locations]),
        'NotAllowlisted',
      )
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx hardhat test test/GameBase.test.ts --grep "subset|_heatBound"`
Expected: FAIL (the stubbed `validateSubset` does not revert; `heatBound` returns zero and emits no Start).

- [ ] **Step 3: Implement `_validateSubset` and `_heatBound` in `GameBase.sol`**

Add inside `GameBase` (after the escrow helpers):

```solidity
    /// @notice Validate a declared subset at instance creation: at least MIN_SUBSET members, all
    /// distinct, all allowlisted. Distinctness is enforced here (once, cheaply); _heatBound's
    /// binding then guarantees the heated set equals this validated subset.
    function _validateSubset(address[] calldata subset) internal view {
        uint256 n = subset.length;
        if (n < MIN_SUBSET) revert BadSubset();
        for (uint256 i = 0; i < n; ++i) {
            address v = subset[i];
            if (!_isAllowlisted(v)) revert NotAllowlisted();
            for (uint256 j = i + 1; j < n; ++j) {
                if (subset[j] == v) revert BadSubset();
            }
        }
    }

    /// @notice Heat exactly the declared subset's preimages, with this contract as request owner and
    /// the change callback on (so Random calls onCast at finalization). Enforces:
    ///   binding — locations.length == subset.length (required == count, no slack) and each
    ///     location's provider equals the subset member at the same index (no sybil substitution);
    ///   membership — each subset member is still allowlisted at heat time (protects a raw-contract
    ///     caller who never touched the front end).
    /// Provider-level binding suffices: a subset containing one honest provider defeats grinding
    /// regardless of which of that provider's preimages is chosen, because the attacker never
    /// learns the honest secret.
    function _heatBound(address[] memory subset, PreimageLocation.Info[] calldata locations)
        internal
        returns (bytes32 key)
    {
        uint256 n = subset.length;
        if (locations.length != n) revert SubsetMismatch();
        for (uint256 i = 0; i < n; ++i) {
            if (locations[i].provider != subset[i]) revert SubsetMismatch();
            if (!_isAllowlisted(subset[i])) revert NotAllowlisted();
        }
        PreimageLocation.Info memory settings = PreimageLocation.Info({
            provider: address(this),
            callAtChange: true,
            durationIsTimestamp: DURATION_IS_TIMESTAMP,
            duration: HEAT_DURATION,
            token: HEAT_TOKEN,
            price: 0,
            offset: 0,
            index: 0
        });
        key = IRandom(random).heat(n, settings, locations, false);
    }
```

- [ ] **Step 4: Replace the harness stubs with real forwards**

In `contracts/test/GameBaseHarness.sol`, replace the `validateSubset` and `heatBound` stubs with:

```solidity
    function validateSubset(address[] calldata subset) external view {
        _validateSubset(subset);
    }

    function heatBound(address[] calldata subset, PreimageLocation.Info[] calldata locations)
        external
        returns (bytes32 key)
    {
        key = _heatBound(subset, locations);
    }
```

(Leave the `_settle` stub; Task 5 replaces it.)

- [ ] **Step 5: Run to verify pass**

Run: `npx hardhat test test/GameBase.test.ts`
Expected: PASS for all subset and `_heatBound` tests (plus the Task 3 tests still green).

- [ ] **Step 6: Commit**

```bash
git add contracts/GameBase.sol contracts/test/GameBaseHarness.sol test/GameBase.test.ts test/utils.ts
git commit -m "feat: GameBase subset validation and bound heat"
```

---

### Task 5: GameBase — onCast dispatch, onChop, and the stale check

**Files:**
- Modify: `contracts/GameBase.sol`
- Modify: `contracts/test/GameBaseHarness.sol` (real `_settle` recording; expose `_isStale`)
- Modify: `test/GameBase.test.ts`

- [ ] **Step 1: Write the failing tests for dispatch and onChop**

Add to `test/GameBase.test.ts`:

```ts
  describe('dispatch', () => {
    it('routes onCast to _settle for the bound instance and rejects a non-Random caller', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const key = viem.keccak256(viem.toHex('key-1'))
      const instanceId = viem.keccak256(viem.toHex('instance-1'))
      const seed = viem.keccak256(viem.toHex('seed-1'))
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.bindInstance([key, instanceId]))
      // a direct (non-Random) onCast call must revert
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.onCast([key, seed]),
        'OnlyRandom',
      )
    })

    it('records a chopped instance from onChop', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const key = viem.keccak256(viem.toHex('key-2'))
      const instanceId = viem.keccak256(viem.toHex('instance-2'))
      await testUtils.confirmTx(ctx, ctx.gameBaseHarness.write.bindInstance([key, instanceId]))
      await expectations.revertedWithCustomError(
        ctx.gameBaseHarness,
        ctx.gameBaseHarness.write.onChop([key]),
        'OnlyRandom',
      )
    })
  })
```

> Note: `onCast`/`onChop` are `OnlyRandom`-guarded, so a direct test call reverts. The *successful* dispatch path (Random actually calling back) is covered end-to-end in the CoinFlip and Raffle settlement tests, which drive a real `cast`. These unit tests assert the guard.

- [ ] **Step 2: Run to verify failure**

Run: `npx hardhat test test/GameBase.test.ts --grep "dispatch"`
Expected: FAIL (`onCast`/`onChop` not yet declared on `GameBase`).

- [ ] **Step 3: Implement the dispatch surface in `GameBase.sol`**

Replace the placeholder `onReverse` line at the end of `GameBase` with the full callback surface plus the abstract settle and the stale helper:

```solidity
    // --- ConsumerReceiver callbacks and dispatch ---

    /// @notice Core Random calls this when a request's seed finalizes (callAtChange was set on
    /// heat). Looks up the instance by key and routes to the game's _settle.
    function onCast(bytes32 key, bytes32 seed) external override {
        if (msg.sender != random) revert OnlyRandom();
        _settle(instanceByKey[key], seed);
    }

    /// @notice Core Random calls this when a request is chopped at expiry (the seed never formed).
    /// Records the instance as a liveness failure so the game's refund path can fire.
    function onChop(bytes32 key) external override {
        if (msg.sender != random) revert OnlyRandom();
        bytes32 instanceId = instanceByKey[key];
        choppedInstance[instanceId] = true;
        _onChop(instanceId);
    }

    function onReverse(bytes32, address, uint256) external override {}

    /// @notice The game-specific settlement, invoked by onCast (push) and the game's pull fallback.
    function _settle(bytes32 instanceId, bytes32 seed) internal virtual;

    /// @notice Optional hook for a game to react to a chop beyond the recorded flag.
    function _onChop(bytes32 instanceId) internal virtual {}

    /// @notice True once `armedAtBlock + STALE_BLOCKS` has passed.
    function _isStale(uint256 armedAtBlock) internal view returns (bool) {
        return block.number >= armedAtBlock + STALE_BLOCKS;
    }
```

Remove the temporary placeholder `onReverse` from Task 3 (the one with the empty body before the callbacks section) so there is exactly one `onReverse`.

- [ ] **Step 4: Make the harness `_settle` real and expose `_isStale`**

In `contracts/test/GameBaseHarness.sol`, replace the `_settle` stub with the recording override (already drafted in Task 3 Step 2) and add an `_isStale` forward:

```solidity
    function _settle(bytes32 instanceId, bytes32 seed) internal override {
        lastSettledInstance = instanceId;
        lastSettledSeed = seed;
    }

    function isStale(uint256 armedAtBlock) external view returns (bool) {
        return _isStale(armedAtBlock);
    }
```

Delete the now-unneeded `_settle` placeholder from Task 4 if present.

- [ ] **Step 5: Run all GameBase tests**

Run: `npx hardhat test test/GameBase.test.ts`
Expected: PASS for ownership, escrow, subset, `_heatBound`, and dispatch.

- [ ] **Step 6: Commit**

```bash
git add contracts/GameBase.sol contracts/test/GameBaseHarness.sol test/GameBase.test.ts
git commit -m "feat: GameBase onCast/onChop dispatch and stale check"
```

---

### Task 6: Rework CoinFlip onto GameBase (delete player-secret machinery)

This is a refactor: `CoinFlip is GameBase`, the game inks nothing, the match key gains a validator-subset dimension, and heat goes through `_heatBound`. The matching, `cancel`, `refundStale`, parity settle, and push-plus-pull payout are kept; the player-preimage machinery is deleted.

**Files:**
- Modify: `contracts/CoinFlip.sol` (substantial rewrite)
- Modify: `test/CoinFlip.test.ts`
- Modify: `test/utils.ts` (the existing `inkValidatorPool` is replaced at call sites by `setUpValidators`; keep `inkValidatorPool` if other tests use it, otherwise remove)

- [ ] **Step 1: Rewrite `CoinFlip.sol`**

Replace the entire file with:

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameBase} from "./GameBase.sol";
import {IRandom} from "./implementations/IRandom.sol";
import {PreimageLocation} from "./PreimageLocation.sol";

/// @notice Two-person coin flip on validator-only entropy. Players escrow a stake and a side and
/// declare a validator subset; opposite-side equal-stake entrants on the same subset are matched
/// first-in-first-out, the subset's preimages are heated through GameBase's bound heat, and the
/// parity of the validator-produced seed decides the winner. The game inks nothing and contributes
/// nothing to the seed; players hold no entropy.
contract CoinFlip is GameBase {
    error WrongSide();
    error ZeroStake();
    error NotEntrant();
    error AlreadyResolved();
    error TooEarly();

    event Entered(uint256 indexed id, address indexed player, uint8 side, uint256 stake, bytes32 subsetHash);
    event Cancelled(uint256 indexed id);
    event Paired(bytes32 indexed flipId, address heads, address tails, uint256 stake);
    event Heated(bytes32 indexed flipId, bytes32 indexed key);
    event Settled(bytes32 indexed flipId, address indexed winner, uint8 winningSide, uint256 payout, bytes32 seed);

    enum Status { None, Pending, Settled, Refunded }

    struct Entry {
        address player;
        uint8 side;
        uint256 stake;
        bytes32 subsetHash;
        uint256 enteredAtBlock;
        bool active;
    }

    struct Flip {
        address heads;
        address tails;
        uint256 stake;
        bytes32 key;
        uint256 pairedAtBlock;
        Status status;
    }

    uint8 internal constant HEADS = 0;
    uint8 internal constant TAILS = 1;
    uint256 internal constant MAX_QUEUE_SCAN = 32;

    uint256 public nextEntrant;
    mapping(uint256 id => Entry entry) public entries;

    // stake => subsetHash => side => first-in-first-out queue of entry ids, with a moving head.
    mapping(uint256 => mapping(bytes32 => mapping(uint8 => uint256[]))) internal _queue;
    mapping(uint256 => mapping(bytes32 => mapping(uint8 => uint256))) internal _queueHead;

    mapping(bytes32 flipId => Flip flip) public flips;
    uint256 internal _flipNonce;

    constructor(address _random) GameBase(_random) {}

    /// @notice Enter a side at the sent stake on a declared validator subset. If an opposite-side
    /// equal-stake entry waits on the same subset, pair and heat in one transaction (supply the
    /// subset's heat locations); otherwise queue (pass an empty locations array).
    function enterAndMatch(
        uint8 side,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) external payable returns (uint256 id) {
        if (side > TAILS) revert WrongSide();
        if (msg.value == 0) revert ZeroStake();
        _validateSubset(validatorSubset);
        bytes32 subsetHash = keccak256(abi.encode(validatorSubset));

        id = ++nextEntrant;
        entries[id] = Entry({
            player: msg.sender,
            side: side,
            stake: msg.value,
            subsetHash: subsetHash,
            enteredAtBlock: block.number,
            active: true
        });
        emit Entered(id, msg.sender, side, msg.value, subsetHash);

        uint8 opposite = side == HEADS ? TAILS : HEADS;
        uint256 matchedId = _popQueued(msg.value, subsetHash, opposite);
        if (matchedId == 0) {
            _queue[msg.value][subsetHash][side].push(id);
            return id;
        }
        _pairAndHeat(matchedId, id, msg.value, validatorSubset, validatorLocations);
    }

    function _popQueued(uint256 stake, bytes32 subsetHash, uint8 side) internal returns (uint256 id) {
        uint256[] storage q = _queue[stake][subsetHash][side];
        uint256 head = _queueHead[stake][subsetHash][side];
        uint256 scanned;
        while (head < q.length && scanned < MAX_QUEUE_SCAN) {
            uint256 candidate = q[head];
            unchecked { ++head; ++scanned; }
            if (entries[candidate].active) {
                _queueHead[stake][subsetHash][side] = head;
                return candidate;
            }
        }
        _queueHead[stake][subsetHash][side] = head;
        return 0;
    }

    /// @notice A still-waiting entrant reclaims their stake; the entry stays an inactive tombstone.
    function cancel(uint256 id) external {
        Entry storage e = entries[id];
        if (e.player != msg.sender) revert NotEntrant();
        if (!e.active) revert AlreadyResolved();
        e.active = false;
        emit Cancelled(id);
        _refund(e.player, e.stake);
    }

    /// @notice Refund both players of a paired flip whose seed never finalized in time.
    function refundStale(bytes32 flipId) external {
        Flip storage flip = flips[flipId];
        if (flip.status != Status.Pending) revert AlreadyResolved();
        if (!_isStale(flip.pairedAtBlock)) revert TooEarly();
        flip.status = Status.Refunded;
        _refund(flip.heads, flip.stake);
        _refund(flip.tails, flip.stake);
    }

    function _pairAndHeat(
        uint256 aId,
        uint256 bId,
        uint256 stake,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) internal {
        Entry storage a = entries[aId];
        Entry storage b = entries[bId];
        a.active = false;
        b.active = false;
        (Entry storage heads, Entry storage tails) = a.side == HEADS ? (a, b) : (b, a);

        bytes32 key = _heatBound(validatorSubset, validatorLocations);

        bytes32 flipId = keccak256(abi.encode(address(this), ++_flipNonce, heads.player, tails.player));
        flips[flipId] = Flip({
            heads: heads.player,
            tails: tails.player,
            stake: stake,
            key: key,
            pairedAtBlock: block.number,
            status: Status.Pending
        });
        instanceByKey[key] = flipId;
        emit Paired(flipId, heads.player, tails.player, stake);
        emit Heated(flipId, key);
    }

    /// @notice The single settlement path, shared by onCast (push) and claim (pull). Guards status
    /// before transfer (checks-effects-interactions); this is what makes a double payout impossible.
    /// Do NOT add a reentrancy guard — it would block the claim retry after a swallowed onCast.
    function _settle(bytes32 flipId, bytes32 seed) internal override {
        Flip storage flip = flips[flipId];
        if (flip.status != Status.Pending) revert AlreadyResolved();
        flip.status = Status.Settled;
        uint8 winningSide = uint8(uint256(seed) & 1);
        address winner = winningSide == HEADS ? flip.heads : flip.tails;
        uint256 payout = flip.stake * 2;
        emit Settled(flipId, winner, winningSide, payout, seed);
        _pay(winner, payout);
    }

    /// @notice Pull fallback when the onCast push did not complete though the seed is finalized.
    function claim(bytes32 flipId) external {
        Flip storage flip = flips[flipId];
        if (flip.status != Status.Pending) revert AlreadyResolved();
        bytes32 seed = IRandom(random).randomness(flip.key).seed;
        if (seed == bytes32(0)) revert TooEarly();
        _settle(flipId, seed);
    }
}
```

> Deleted vs the old file: `IRandomInk` and the `ink` call, `WALK_AWAY_SECRET`/`WALK_AWAY_PREIMAGE`, `FLIP_TOKEN`/`FLIP_DURATION`/`FLIP_DURATION_IS_TIMESTAMP` constants (now `GameBase.HEAT_*`), `_playerInkOffset` and `playerSection`/`_playerLocation`, the `preimage` fields on `Entry`/`Flip`, the `InvalidPreimage` guard, and the `OnlyRandom`/`onCast`/`onChop`/`onReverse` members (now inherited from `GameBase`). `STALE_BLOCKS` moves to `GameBase`.

- [ ] **Step 2: Update the CoinFlip tests for the new signatures**

The old tests call `enterAndMatch([side, preimage, locations])`. The new signature is `enterAndMatch([side, validatorSubset, validatorLocations])`. Rewrite `test/CoinFlip.test.ts` to:

- replace `testUtils.inkValidatorPool(ctx, 3)` with `testUtils.setUpValidators(ctx, ctx.coinFlip, 3)`, which returns `{ subset, locations, secrets }`;
- pass `subset` (and `[]` for a queuing entry, `locations` for the matching entry) instead of preimages;
- drop the `preimage`/`InvalidPreimage`/`WALK_AWAY` tests entirely (those behaviors are deleted);
- update the `entries` tuple-order assertions to `[player, side, stake, subsetHash, enteredAtBlock, active]`.

Full replacement for the `enter` and `matching` describe blocks:

```ts
import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'

describe('CoinFlip', () => {
  describe('enter', () => {
    it('escrows the stake and records an active entry', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [player] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: player.account }))
      const publicClient = await ctx.hre.viem.getPublicClient()
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(stake)
      const entry = await ctx.coinFlip.read.entries([1n])
      // tuple order: [player, side, stake, subsetHash, enteredAtBlock, active]
      expect(entry[2]).to.equal(stake)
      expect(entry[5]).to.equal(true)
    })

    it('rejects a zero stake', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: 0n }),
        'ZeroStake',
      )
    })

    it('rejects an invalid side', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.enterAndMatch([2, subset, []], { value: viem.parseEther('1') }),
        'WrongSide',
      )
    })

    it('rejects an unvalidatable subset', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      await expectations.revertedWithCustomError(
        ctx.coinFlip,
        ctx.coinFlip.write.enterAndMatch([0, [ctx.signers[9].account.address], []], { value: viem.parseEther('1') }),
        'BadSubset',
      )
    })
  })

  describe('matching', () => {
    it('queues same-side entrants and pairs the first opposite-side entrant on the same subset', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [a, b, c] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: b.account }))
      expect((await ctx.coinFlip.getEvents.Paired()).length).to.equal(0)
      await expectations.emit(ctx,
        ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: c.account }),
        ctx.coinFlip, 'Paired',
      )
    })
  })
})
```

- [ ] **Step 3: Add the full-lifecycle CoinFlip settlement test (drives a real cast)**

This is the end-to-end on-chain test that also exercises `GameBase.onCast` dispatch. Add to `test/CoinFlip.test.ts`:

```ts
  describe('settlement', () => {
    it('pays the parity-selected winner via onCast after a real cast', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [, heads, tails] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
      const heated = (await ctx.coinFlip.getEvents.Heated({}, { blockHash: matchReceipt.blockHash }))[0]
      const key = heated.args.key as viem.Hex
      // cast the validator secrets in heat order (== subset order)
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      const settled = await ctx.coinFlip.getEvents.Settled()
      expect(settled.length).to.equal(1)
      const seed = (await ctx.random.read.randomness([key])).seed as viem.Hex
      const expectedWinner = (BigInt(seed) & 1n) === 0n ? heads.account.address : tails.account.address
      expect(viem.getAddress(settled[0].args.winner as viem.Hex)).to.equal(viem.getAddress(expectedWinner))
    })

    it('refundStale returns both stakes when no cast happens before the timeout', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [, heads, tails] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
      const flipId = (await ctx.coinFlip.getEvents.Paired({}, { blockHash: matchReceipt.blockHash }))[0].args.flipId as viem.Hex
      await helpers.mine(201)
      await expectations.changeEtherBalances(ctx,
        ctx.coinFlip.write.refundStale([flipId]),
        [heads.account.address, tails.account.address],
        [stake, stake],
      )
    })
  })
```

- [ ] **Step 4: Run the CoinFlip tests**

Run: `npx hardhat test test/CoinFlip.test.ts`
Expected: PASS. (If `inkValidatorPool` is now unused, remove it from `test/utils.ts` in this step and re-run.)

- [ ] **Step 5: Commit**

```bash
git add contracts/CoinFlip.sol test/CoinFlip.test.ts test/utils.ts
git commit -m "refactor: CoinFlip on GameBase, validator-only entropy"
```

---

### Task 7: Verify CoinFlip inks nothing (deletion proof)

**Files:**
- Modify: `test/CoinFlip.test.ts`

- [ ] **Step 1: Write the deletion-proof test**

A test that asserts no `Ink` event is emitted by the game across a full flip (the game must contribute nothing to the seed):

```ts
  describe('validator-only entropy', () => {
    it('emits no Ink event during a full flip (the game inks nothing)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.coinFlip, 3)
      const [, heads, tails] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, subset, []], { value: stake, account: heads.account }))
      const matchReceipt = await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, subset, locations], { value: stake, account: tails.account }))
      // No Ink event in the match block originating from the game's own ink (the game has no ink path).
      const inkEvents = await ctx.random.getEvents.Ink({}, { blockHash: matchReceipt.blockHash })
      const gameInks = inkEvents.filter((e) => viem.getAddress((e.args as any).provider) === viem.getAddress(ctx.coinFlip.address))
      expect(gameInks.length).to.equal(0)
    })
  })
```

> The validator inks happen in `setUpValidators` (a separate setup transaction, under validator addresses), not in the match block and not under the game's address — so this asserts the *game* never inks.

- [ ] **Step 2: Run to verify pass**

Run: `npx hardhat test test/CoinFlip.test.ts --grep "validator-only"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/CoinFlip.test.ts
git commit -m "test: prove CoinFlip inks nothing"
```

---

## Part B — The Raffle game

### Task 8: Raffle — round model, commit, cancel

**Files:**
- Create: `contracts/Raffle.sol`
- Create: `test/Raffle.test.ts`
- Modify: `test/utils.ts` (deploy `Raffle` in the fixture)
- Create: `ignition/modules/Raffle.ts`

- [ ] **Step 1: Write `Raffle.sol` with the round model, commit, and cancel**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameBase} from "./GameBase.sol";
import {IRandom} from "./implementations/IRandom.sol";
import {PreimageLocation} from "./PreimageLocation.sol";

/// @notice Closest-guess raffle on validator-only entropy. Players commit a hidden, address-bound
/// guess in [1..256] at an equal per-guess stake into a round keyed by its parameter tuple. When
/// the round has at least its threshold of commits and a period has elapsed, an operator arms it
/// (heating the declared validator subset through GameBase's bound heat). A validator cast sets the
/// seed; the contract records the draw and opens a claim window in which committers reveal; the
/// closest revealed guess takes the pot less the fee. Non-revealers forfeit; nothing a player does
/// can stall, abort, or grind the draw.
contract Raffle is GameBase {
    error BadParams();
    error NotFilling();
    error ThresholdNotMet();
    error PeriodNotElapsed();
    error NotTicketOwner();
    error TicketInactive();
    error WrongRoundState();
    error WindowClosed();
    error WindowOpen();
    error BadReveal();
    error AlreadyRevealed();
    error GuessOutOfRange();
    error TooEarly();
    error NothingToRefund();
    error BadFee();

    event RoundOpened(bytes32 indexed roundId, uint256 stake, uint256 threshold, uint256 period, bytes32 subsetHash);
    event Committed(uint256 indexed ticketId, bytes32 indexed roundId, address indexed player, bytes32 commitment);
    event TicketCancelled(uint256 indexed ticketId);
    event Armed(bytes32 indexed roundId, bytes32 indexed key);
    event Drawn(bytes32 indexed roundId, uint256 draw, uint256 claimDeadline);
    event Revealed(uint256 indexed ticketId, bytes32 indexed roundId, uint256 guess, uint256 distance, bool leading);
    event Finalised(bytes32 indexed roundId, address indexed winner, uint256 payout, uint256 fee);
    event NoContest(bytes32 indexed roundId, uint256 potPerValidator);
    event TicketRefunded(uint256 indexed ticketId);

    enum Status { None, Filling, Drawing, Claiming, Paid, Refunded }

    struct Round {
        uint256 stake;
        uint256 threshold;
        uint256 period;
        bytes32 subsetHash;
        uint256 createdAtBlock;
        uint256 commitCount;
        uint256 pot;
        Status status;
        bytes32 key;
        uint256 armedAtBlock;
        uint256 draw;
        uint256 claimDeadline;
        uint256 bestTicket;
        uint256 bestDistance;
        uint256 settledPot;
    }

    struct Ticket {
        bytes32 roundId;
        address player;
        bytes32 commitment;
        uint256 committedAtBlock;
        bool active;
        bool revealed;
    }

    uint256 public constant RANGE = 256; // draws and guesses are in [1..256]
    uint256 public constant CLAIM_BLOCKS = 100;
    uint256 public constant BIPS = 10_000;

    /// @notice owner-adjustable rake, in basis points, default zero; a percentage so a nonzero
    /// value self-taxes raffle flooding.
    uint256 public feeBips;
    address public feeRecipient;

    mapping(bytes32 roundId => Round) public rounds;
    mapping(bytes32 roundId => address[] subset) internal _roundSubset;
    mapping(uint256 ticketId => Ticket) public tickets;
    uint256 public nextTicket;

    /// @notice the currently-filling round for a parameter tuple, so commits with the same tuple
    /// concentrate into one round; cleared when that round arms so the next commit opens a fresh one.
    mapping(bytes32 tupleHash => bytes32 roundId) public activeRound;
    uint256 internal _roundNonce;

    constructor(address _random) GameBase(_random) {
        feeRecipient = msg.sender;
    }

    function setFee(uint256 newFeeBips, address newRecipient) external onlyOwner {
        if (newFeeBips > BIPS) revert BadFee();
        feeBips = newFeeBips;
        feeRecipient = newRecipient;
    }

    /// @notice Commit a hidden guess into the round for these parameters at the sent stake.
    /// commitment = keccak256(abi.encode(guess, salt, msg.sender)). Opens a new round if none is
    /// filling for this tuple.
    function commit(
        uint256 stake,
        uint256 threshold,
        uint256 period,
        address[] calldata validatorSubset,
        bytes32 commitment
    ) external payable returns (uint256 ticketId) {
        if (stake == 0 || threshold == 0 || period == 0) revert BadParams();
        _take(stake);
        _validateSubset(validatorSubset);
        bytes32 subsetHash = keccak256(abi.encode(validatorSubset));
        bytes32 tupleHash = keccak256(abi.encode(stake, threshold, period, subsetHash));

        bytes32 roundId = activeRound[tupleHash];
        if (roundId == bytes32(0) || rounds[roundId].status != Status.Filling) {
            roundId = keccak256(abi.encode(address(this), ++_roundNonce, tupleHash));
            rounds[roundId] = Round({
                stake: stake,
                threshold: threshold,
                period: period,
                subsetHash: subsetHash,
                createdAtBlock: block.number,
                commitCount: 0,
                pot: 0,
                status: Status.Filling,
                key: bytes32(0),
                armedAtBlock: 0,
                draw: 0,
                claimDeadline: 0,
                bestTicket: 0,
                bestDistance: 0,
                settledPot: 0
            });
            _roundSubset[roundId] = validatorSubset;
            activeRound[tupleHash] = roundId;
            emit RoundOpened(roundId, stake, threshold, period, subsetHash);
        }

        Round storage round = rounds[roundId];
        ticketId = ++nextTicket;
        tickets[ticketId] = Ticket({
            roundId: roundId,
            player: msg.sender,
            commitment: commitment,
            committedAtBlock: block.number,
            active: true,
            revealed: false
        });
        unchecked {
            ++round.commitCount;
            round.pot += stake;
        }
        emit Committed(ticketId, roundId, msg.sender, commitment);
    }

    /// @notice Reclaim a still-waiting ticket while its round is filling (the per-ticket escape).
    function cancel(uint256 ticketId) external {
        Ticket storage ticket = tickets[ticketId];
        if (ticket.player != msg.sender) revert NotTicketOwner();
        if (!ticket.active) revert TicketInactive();
        Round storage round = rounds[ticket.roundId];
        if (round.status != Status.Filling) revert WrongRoundState();
        ticket.active = false;
        unchecked {
            --round.commitCount;
            round.pot -= round.stake;
        }
        emit TicketCancelled(ticketId);
        _refund(ticket.player, round.stake);
    }

    function roundSubset(bytes32 roundId) external view returns (address[] memory) {
        return _roundSubset[roundId];
    }
}
```

- [ ] **Step 2: Deploy `Raffle` in the fixture**

In `test/utils.ts`, after the harness deploy, add:

```ts
  const raffle = await hre.viem.deployContract(contractName.Raffle, [random.address])
```

and add `raffle` to `deployedContracts`.

- [ ] **Step 3: Add the ignition module**

`ignition/modules/Raffle.ts` (mirror `ignition/modules/CoinFlip.ts`; open that file and copy its shape, substituting `Raffle`):

```ts
import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('RaffleModule', (m) => {
  const random = m.getParameter('random')
  const raffle = m.contract('Raffle', [random])
  return { raffle }
})
```

> If `CoinFlip.ts` uses a hardcoded Random address rather than a parameter, match that pattern instead. Read it first.

- [ ] **Step 4: Write the failing tests for commit and cancel**

`test/Raffle.test.ts`:

```ts
import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'
import * as testUtils from './utils'

const RANGE = 256n

const commitmentFor = (guess: bigint, salt: viem.Hex, player: viem.Hex): viem.Hex =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [guess, salt, player]))

describe('Raffle', () => {
  const stake = viem.parseEther('1')
  const threshold = 3n
  const period = 5n

  describe('commit and cancel', () => {
    it('opens a round on the first commit and escrows the stake', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, p] = ctx.signers
      const salt = viem.keccak256(viem.toHex('salt-1'))
      const commitment = commitmentFor(7n, salt, p.account.address)
      await expectations.emit(ctx,
        ctx.raffle.write.commit([stake, threshold, period, subset, commitment], { value: stake, account: p.account }),
        ctx.raffle, 'RoundOpened',
      )
      const publicClient = await ctx.hre.viem.getPublicClient()
      expect(await publicClient.getBalance({ address: ctx.raffle.address })).to.equal(stake)
    })

    it('concentrates commits of the same tuple into one round', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, a, b] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.raffle.write.commit([stake, threshold, period, subset, commitmentFor(1n, viem.keccak256(viem.toHex('sa')), a.account.address)], { value: stake, account: a.account }))
      const opened = await ctx.raffle.getEvents.RoundOpened()
      const roundId = opened[0].args.roundId as viem.Hex
      await testUtils.confirmTx(ctx, ctx.raffle.write.commit([stake, threshold, period, subset, commitmentFor(2n, viem.keccak256(viem.toHex('sb')), b.account.address)], { value: stake, account: b.account }))
      expect((await ctx.raffle.getEvents.RoundOpened()).length).to.equal(1) // no new round
      const round = await ctx.raffle.read.rounds([roundId])
      // tuple order matches the Round struct; commitCount is field index 5
      expect(round[5]).to.equal(2n)
    })

    it('cancels a waiting ticket and refunds the stake', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, p] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.raffle.write.commit([stake, threshold, period, subset, commitmentFor(7n, viem.keccak256(viem.toHex('s')), p.account.address)], { value: stake, account: p.account }))
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.cancel([1n], { account: p.account }),
        [p.account.address],
        [stake],
      )
    })

    it('rejects a cancel from a non-owner of the ticket', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const [, p, other] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.raffle.write.commit([stake, threshold, period, subset, commitmentFor(7n, viem.keccak256(viem.toHex('s')), p.account.address)], { value: stake, account: p.account }))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.cancel([1n], { account: other.account }),
        'NotTicketOwner',
      )
    })
  })
})
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx hardhat test test/Raffle.test.ts`
Expected: PASS for the commit/cancel tests.

- [ ] **Step 6: Commit**

```bash
git add contracts/Raffle.sol test/Raffle.test.ts test/utils.ts ignition/modules/Raffle.ts
git commit -m "feat: Raffle round model, commit, cancel"
```

---

### Task 9: Raffle — arm and draw

**Files:**
- Modify: `contracts/Raffle.sol`
- Modify: `test/Raffle.test.ts`

- [ ] **Step 1: Write the failing tests for arm and draw**

Add to `test/Raffle.test.ts`:

```ts
  describe('arm and draw', () => {
    const fillRound = async (ctx: any, subset: viem.Hex[], guesses: bigint[], salts: viem.Hex[]) => {
      const players = ctx.signers.slice(1, 1 + guesses.length)
      for (let i = 0; i < guesses.length; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(guesses[i], salts[i], players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
      }
      const roundId = (await ctx.raffle.getEvents.RoundOpened())[0].args.roundId as viem.Hex
      return { roundId, players }
    }

    it('reverts arm before the period elapses', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const { roundId } = await fillRound(ctx, subset, [1n, 2n, 3n], ['0x01', '0x02', '0x03'].map((s) => viem.padHex(s as viem.Hex, { size: 32 })))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.arm([roundId, locations]),
        'PeriodNotElapsed',
      )
    })

    it('reverts arm below the threshold', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const { roundId } = await fillRound(ctx, subset, [1n, 2n], ['0x01', '0x02'].map((s) => viem.padHex(s as viem.Hex, { size: 32 })))
      await helpers.mine(6)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.arm([roundId, locations]),
        'ThresholdNotMet',
      )
    })

    it('arms a filled round, casts, and records a draw in [1..256] without paying', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const salts = ['0x01', '0x02', '0x03'].map((s) => viem.padHex(s as viem.Hex, { size: 32 }))
      const { roundId } = await fillRound(ctx, subset, [1n, 2n, 3n], salts)
      await helpers.mine(6)
      const armReceipt = await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
      const key = (await ctx.raffle.getEvents.Armed({}, { blockHash: armReceipt.blockHash }))[0].args.key as viem.Hex
      const publicClient = await ctx.hre.viem.getPublicClient()
      const potBefore = await publicClient.getBalance({ address: ctx.raffle.address })
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      const drawn = await ctx.raffle.getEvents.Drawn()
      expect(drawn.length).to.equal(1)
      const draw = drawn[0].args.draw as bigint
      expect(draw).to.be.greaterThanOrEqual(1n)
      expect(draw).to.be.lessThanOrEqual(RANGE)
      // no payout on draw
      expect(await publicClient.getBalance({ address: ctx.raffle.address })).to.equal(potBefore)
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx hardhat test test/Raffle.test.ts --grep "arm and draw"`
Expected: FAIL (`arm` not defined).

- [ ] **Step 3: Implement `arm`, `_settle`, and `recordDraw` in `Raffle.sol`**

Add to `Raffle`:

```solidity
    /// @notice Operator step: heat the round's declared validator subset once it is at threshold and
    /// a period has elapsed. Permissionless, but bound — _heatBound permits only locations matching
    /// the declared subset, and the threshold and filling-status checks make arming one-shot.
    function arm(bytes32 roundId, PreimageLocation.Info[] calldata validatorLocations) external {
        Round storage round = rounds[roundId];
        if (round.status != Status.Filling) revert NotFilling();
        if (round.commitCount < round.threshold) revert ThresholdNotMet();
        if (block.number < round.createdAtBlock + round.period) revert PeriodNotElapsed();

        round.status = Status.Drawing;
        round.armedAtBlock = block.number;
        round.settledPot = round.pot;
        // the next commit for this tuple opens a fresh round
        bytes32 tupleHash = keccak256(abi.encode(round.stake, round.threshold, round.period, round.subsetHash));
        if (activeRound[tupleHash] == roundId) {
            activeRound[tupleHash] = bytes32(0);
        }

        bytes32 key = _heatBound(_roundSubset[roundId], validatorLocations);
        round.key = key;
        instanceByKey[key] = roundId;
        emit Armed(roundId, key);
    }

    /// @notice Record the draw and open the claim window (does not pay). Invoked by onCast (push)
    /// via GameBase and by recordDraw (pull fallback).
    function _settle(bytes32 roundId, bytes32 seed) internal override {
        Round storage round = rounds[roundId];
        if (round.status != Status.Drawing) revert WrongRoundState();
        round.status = Status.Claiming;
        round.draw = 1 + (uint256(seed) % RANGE);
        round.claimDeadline = block.number + CLAIM_BLOCKS;
        emit Drawn(roundId, round.draw, round.claimDeadline);
    }

    /// @notice Pull fallback when the onCast push did not complete though the seed is finalized.
    function recordDraw(bytes32 roundId) external {
        Round storage round = rounds[roundId];
        if (round.status != Status.Drawing) revert WrongRoundState();
        bytes32 seed = IRandom(random).randomness(round.key).seed;
        if (seed == bytes32(0)) revert TooEarly();
        _settle(roundId, seed);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx hardhat test test/Raffle.test.ts --grep "arm and draw"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/Raffle.sol test/Raffle.test.ts
git commit -m "feat: Raffle arm, draw recording, and pull fallback"
```

---

### Task 10: Raffle — reveal, overwrite, and the tiebreak

**Files:**
- Modify: `contracts/Raffle.sol`
- Modify: `test/Raffle.test.ts`

- [ ] **Step 1: Write the failing reveal/overwrite tests**

Add a `describe('reveal', ...)` to `test/Raffle.test.ts` that fills, arms, casts, then reveals. Because the draw depends on the cast secrets (and is hard to predict), the tests assert *relative* outcomes (a closer guess overwrites a farther one) rather than a fixed winner. Use a helper that returns the recorded draw:

```ts
  describe('reveal and overwrite', () => {
    const armAndDraw = async (ctx: any) => {
      const { subset, locations, secrets } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const players = ctx.signers.slice(1, 4)
      const salts = players.map((_p: any, i: number) => viem.keccak256(viem.toHex(`salt-${i}`)))
      const guesses = [10n, 128n, 250n]
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(guesses[i], salts[i], players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
      }
      const roundId = (await ctx.raffle.getEvents.RoundOpened())[0].args.roundId as viem.Hex
      await helpers.mine(6)
      const armReceipt = await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
      const key = (await ctx.raffle.getEvents.Armed({}, { blockHash: armReceipt.blockHash }))[0].args.key as viem.Hex
      await testUtils.confirmTx(ctx, ctx.random.write.cast([key, locations, secrets]))
      const draw = (await ctx.raffle.getEvents.Drawn())[0].args.draw as bigint
      return { roundId, players, salts, guesses, draw }
    }

    it('accepts a valid reveal and rejects a guess that does not match the commitment', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { players, salts, guesses } = await armAndDraw(ctx)
      // ticket 1 belongs to players[0]; revealing the wrong guess fails the hash
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([1n, guesses[0] + 1n, salts[0]], { account: players[0].account }),
        'BadReveal',
      )
      await expectations.emit(ctx,
        ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }),
        ctx.raffle, 'Revealed',
      )
    })

    it('rejects a reveal replayed from a different sender (address binding)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { players, salts, guesses } = await armAndDraw(ctx)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[1].account }),
        'BadReveal',
      )
    })

    it('keeps the closest revealer as the provisional winner regardless of reveal order', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses, draw } = await armAndDraw(ctx)
      // reveal all three; compute who should lead off-chain
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([BigInt(i + 1), guesses[i], salts[i]], { account: players[i].account }))
      }
      const distances = guesses.map((g) => (g > draw ? g - draw : draw - g))
      let bestIdx = 0
      for (let i = 1; i < 3; i++) if (distances[i] < distances[bestIdx]) bestIdx = i
      const round = await ctx.raffle.read.rounds([roundId])
      // bestTicket is field index 12 in the Round struct tuple
      expect(round[12]).to.equal(BigInt(bestIdx + 1))
    })
  })
```

> The `round[12]` index assumes the field order in the `Round` struct from Task 8. If you reorder fields, update the index. The order is: 0 stake, 1 threshold, 2 period, 3 subsetHash, 4 createdAtBlock, 5 commitCount, 6 pot, 7 status, 8 key, 9 armedAtBlock, 10 draw, 11 claimDeadline, 12 bestTicket, 13 bestDistance, 14 settledPot.

- [ ] **Step 2: Run to verify failure**

Run: `npx hardhat test test/Raffle.test.ts --grep "reveal and overwrite"`
Expected: FAIL (`reveal` not defined).

- [ ] **Step 3: Implement `reveal` in `Raffle.sol`**

```solidity
    /// @notice Reveal a committed guess during the claim window. Verifies the commitment against
    /// (guess, salt, msg.sender) — the address binding is what stops a front-runner replaying a
    /// revealed guess from the mempool. Overwrites the provisional winner if strictly closer, ties
    /// broken by earliest commit block then ticket id (so the winner is independent of reveal order).
    function reveal(uint256 ticketId, uint256 guess, bytes32 salt) external {
        Ticket storage ticket = tickets[ticketId];
        Round storage round = rounds[ticket.roundId];
        if (round.status != Status.Claiming) revert WrongRoundState();
        if (block.number > round.claimDeadline) revert WindowClosed();
        if (!ticket.active) revert TicketInactive();
        if (ticket.revealed) revert AlreadyRevealed();
        if (guess < 1 || guess > RANGE) revert GuessOutOfRange();
        if (keccak256(abi.encode(guess, salt, msg.sender)) != ticket.commitment) revert BadReveal();

        ticket.revealed = true;
        uint256 distance = guess > round.draw ? guess - round.draw : round.draw - guess;

        bool leading;
        if (round.bestTicket == 0) {
            leading = true;
        } else if (distance < round.bestDistance) {
            leading = true;
        } else if (distance == round.bestDistance) {
            Ticket storage best = tickets[round.bestTicket];
            if (ticket.committedAtBlock < best.committedAtBlock) {
                leading = true;
            } else if (ticket.committedAtBlock == best.committedAtBlock && ticketId < round.bestTicket) {
                leading = true;
            }
        }
        if (leading) {
            round.bestTicket = ticketId;
            round.bestDistance = distance;
        }
        emit Revealed(ticketId, ticket.roundId, guess, distance, leading);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx hardhat test test/Raffle.test.ts --grep "reveal and overwrite"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/Raffle.sol test/Raffle.test.ts
git commit -m "feat: Raffle reveal, overwrite, deterministic tiebreak"
```

---

### Task 11: Raffle — finalise, fee, no-contest, and per-ticket refund

**Files:**
- Modify: `contracts/Raffle.sol`
- Modify: `test/Raffle.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/Raffle.test.ts` (reuse the `armAndDraw` helper — lift it to the top-level `describe` scope so finalise tests can call it):

```ts
  describe('finalise', () => {
    it('pays the winner the pot less fee after the window closes', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      // set a 5% fee
      await testUtils.confirmTx(ctx, ctx.raffle.write.setFee([500n, ctx.signers[11].account.address]))
      const { roundId, players, salts, guesses, draw } = await armAndDraw(ctx)
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([BigInt(i + 1), guesses[i], salts[i]], { account: players[i].account }))
      }
      const distances = guesses.map((g) => (g > draw ? g - draw : draw - g))
      let bestIdx = 0
      for (let i = 1; i < 3; i++) if (distances[i] < distances[bestIdx]) bestIdx = i
      await helpers.mine(101) // past the claim window
      const pot = stake * 3n
      const fee = (pot * 500n) / 10_000n
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.finalise([roundId]),
        [players[bestIdx].account.address, ctx.signers[11].account.address],
        [pot - fee, fee],
      )
    })

    it('routes the pot to the validators when nobody reveals (no-contest)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId } = await armAndDraw(ctx)
      const subset = await ctx.raffle.read.roundSubset([roundId])
      await helpers.mine(101)
      const pot = stake * 3n
      const perValidator = pot / 3n
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.finalise([roundId]),
        subset as viem.Hex[],
        [perValidator, perValidator, perValidator],
      )
    })

    it('reverts finalise before the window closes', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.finalise([roundId]),
        'WindowOpen',
      )
    })
  })

  describe('liveness refund', () => {
    it('lets each committer reclaim their ticket when the seed never finalises', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const players = ctx.signers.slice(1, 4)
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(BigInt(i + 1), viem.keccak256(viem.toHex(`s${i}`)), players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
      }
      const roundId = (await ctx.raffle.getEvents.RoundOpened())[0].args.roundId as viem.Hex
      await helpers.mine(6)
      await testUtils.confirmTx(ctx, ctx.raffle.write.arm([roundId, locations]))
      // never cast; pass the stale timeout
      await helpers.mine(201)
      await expectations.changeEtherBalances(ctx,
        ctx.raffle.write.refundTicket([1n], { account: players[0].account }),
        [players[0].account.address],
        [stake],
      )
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx hardhat test test/Raffle.test.ts --grep "finalise|liveness"`
Expected: FAIL (`finalise`, `refundTicket` not defined).

- [ ] **Step 3: Implement `finalise` and `refundTicket`**

```solidity
    /// @notice After the claim window, pay the closest revealer the pot less the fee; if nobody
    /// revealed, route the pot to the round's contributing validators (the no-contest case — the
    /// seed finalised, so no validator was chopped). Non-revealers' stakes are part of the pot.
    function finalise(bytes32 roundId) external {
        Round storage round = rounds[roundId];
        if (round.status != Status.Claiming) revert WrongRoundState();
        if (block.number <= round.claimDeadline) revert WindowOpen();
        round.status = Status.Paid;

        uint256 pot = round.settledPot;
        if (round.bestTicket == 0) {
            address[] storage subset = _roundSubset[roundId];
            uint256 n = subset.length;
            uint256 share = pot / n;
            for (uint256 i = 0; i < n; ++i) {
                _pay(subset[i], i + 1 == n ? pot - share * (n - 1) : share);
            }
            emit NoContest(roundId, share);
            return;
        }

        uint256 fee = (pot * feeBips) / BIPS;
        address winner = tickets[round.bestTicket].player;
        emit Finalised(roundId, winner, pot - fee, fee);
        if (fee > 0) _pay(feeRecipient, fee);
        _pay(winner, pot - fee);
    }

    /// @notice Liveness exit: when an armed round's seed never finalised (chopped or stale), each
    /// committer reclaims their own ticket's stake. Pull, per-ticket, so a large round needs no push.
    function refundTicket(uint256 ticketId) external {
        Ticket storage ticket = tickets[ticketId];
        if (ticket.player != msg.sender) revert NotTicketOwner();
        if (!ticket.active) revert TicketInactive();
        Round storage round = rounds[ticket.roundId];
        if (round.status != Status.Drawing) revert WrongRoundState();
        bool seedMissing = IRandom(random).randomness(round.key).seed == bytes32(0);
        if (!seedMissing) revert TooEarly();
        if (!choppedInstance[ticket.roundId] && !_isStale(round.armedAtBlock)) revert TooEarly();
        ticket.active = false;
        emit TicketRefunded(ticketId);
        _refund(ticket.player, round.stake);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx hardhat test test/Raffle.test.ts`
Expected: PASS for the whole Raffle suite.

- [ ] **Step 5: Commit**

```bash
git add contracts/Raffle.sol test/Raffle.test.ts
git commit -m "feat: Raffle finalise, fee, no-contest, per-ticket refund"
```

---

### Task 12: Security-invariant tests

These encode *why* the design is safe, per the spec's Security model. They must fail if the safety properties regress.

**Files:**
- Modify: `test/Raffle.test.ts`
- Modify: `test/CoinFlip.test.ts`

- [ ] **Step 1: Write the no-last-revealer-abort and guess-freeze invariants (Raffle)**

```ts
  describe('security invariants', () => {
    it('settlement cannot be blocked by any player action (no last-revealer-abort)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      // only the first player reveals; the others withhold. The window still closes and finalise pays.
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      await helpers.mine(101)
      // finalise succeeds and pays player 0 (the only revealer) — withholding cannot abort it
      await expectations.emit(ctx, ctx.raffle.write.finalise([roundId]), ctx.raffle, 'Finalised')
    })

    it('the draw is fixed at cast and independent of any reveal (seed is validator-only)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      const drawAfterCast = (await ctx.raffle.read.rounds([roundId]))[10] as bigint
      await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([1n, guesses[0], salts[0]], { account: players[0].account }))
      const drawAfterReveal = (await ctx.raffle.read.rounds([roundId]))[10] as bigint
      expect(drawAfterReveal).to.equal(drawAfterCast)
    })

    it('a reveal with an altered guess reverts (guess freeze)', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { players, salts, guesses } = await armAndDraw(ctx)
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.reveal([1n, (guesses[0] % RANGE) + 1n, salts[0]], { account: players[0].account }),
        'BadReveal',
      )
    })
  })
```

- [ ] **Step 2: Write a selection-diversity invariant (CoinFlip + Raffle share `_heatBound`)**

The grinding defence is that an instance cannot heat a non-allowlisted or substituted provider. The `_heatBound` tests in Task 4 already prove substitution and non-membership revert. Add one explicit framing test in `test/Raffle.test.ts` that an `arm` with a sybil-substituted location reverts:

```ts
    it('arm cannot substitute a sybil validator for the declared subset', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const { subset, locations } = await testUtils.setUpValidators(ctx, ctx.raffle, 3)
      const players = ctx.signers.slice(1, 4)
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.commit(
          [stake, threshold, period, subset, commitmentFor(BigInt(i + 1), viem.keccak256(viem.toHex(`x${i}`)), players[i].account.address)],
          { value: stake, account: players[i].account },
        ))
      }
      const roundId = (await ctx.raffle.getEvents.RoundOpened())[0].args.roundId as viem.Hex
      await helpers.mine(6)
      const sybil = [locations[0], locations[1], { ...locations[2], provider: subset[0] }]
      await expectations.revertedWithCustomError(
        ctx.raffle,
        ctx.raffle.write.arm([roundId, sybil]),
        'SubsetMismatch',
      )
    })
```

- [ ] **Step 3: Run to verify pass**

Run: `npx hardhat test test/Raffle.test.ts --grep "security invariants|sybil"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/Raffle.test.ts test/CoinFlip.test.ts
git commit -m "test: security invariants — no-abort, guess freeze, no sybil"
```

---

### Task 13: Value-conservation and full-suite gate

**Files:**
- Modify: `test/Raffle.test.ts`

- [ ] **Step 1: Write a value-conservation test**

After a full raffle (commit → arm → cast → reveals → finalise), the contract balance for that round nets to zero (every escrowed stake left as a payout, fee, or no-contest distribution):

```ts
  describe('value conservation', () => {
    it('a finalised round leaves no stuck balance attributable to it', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const publicClient = await ctx.hre.viem.getPublicClient()
      const before = await publicClient.getBalance({ address: ctx.raffle.address })
      const { roundId, players, salts, guesses } = await armAndDraw(ctx)
      for (let i = 0; i < 3; i++) {
        await testUtils.confirmTx(ctx, ctx.raffle.write.reveal([BigInt(i + 1), guesses[i], salts[i]], { account: players[i].account }))
      }
      await helpers.mine(101)
      await testUtils.confirmTx(ctx, ctx.raffle.write.finalise([roundId]))
      const after = await publicClient.getBalance({ address: ctx.raffle.address })
      expect(after).to.equal(before) // the round's three stakes all left the contract
    })
  })
```

- [ ] **Step 2: Run the entire contract suite**

Run: `pnpm test`
Expected: PASS for all of `GameBase`, `CoinFlip`, `Raffle`, and the pre-existing `Random`/`Reader`/`Consumer` suites (unchanged by this work).

- [ ] **Step 3: Run coverage to confirm the new contracts are exercised**

Run: `pnpm coverage`
Expected: `GameBase.sol`, `CoinFlip.sol`, `Raffle.sol` appear with high statement/branch coverage. Note any uncovered branch and add a test if it is a real path (not an unreachable guard).

- [ ] **Step 4: Commit**

```bash
git add test/Raffle.test.ts
git commit -m "test: raffle value conservation; full-suite green"
```

---

## Deferred to a follow-up (out of scope for this plan)

- **Foundry invariant/fuzz tests.** Introduce Foundry into `packages/contracts` and port the security invariants (selection-grind fuzz, value conservation, draw uniformity, winner-is-closest, status monotonicity) to native `forge` invariant/fuzz testing once both games are stable. This was deferred per the toolchain decision (Hardhat now, Foundry later). It re-introduces the 943/shanghai compiler concern under `forge`, which is why it is a separate effort.

## Open items resolved with defaults in this plan (flag if you disagree)

- `MIN_SUBSET = 3` and the default instance subset size live as the `MIN_SUBSET` constant; canonical preset *sizes* are a front-end concern (Plan 2). The spec left N open as a config constant; 3 is the chosen default.
- `feeBips` defaults to 0 for both games (spec). `setFee` caps at `BIPS` (100%).
- `CLAIM_BLOCKS = 100` and `STALE_BLOCKS = 200` are chosen constants; adjust if the spec author wants different windows.
- Canonical-preset enforcement is a UI nudge plus an optional on-chain recommended list; the contract does not hard-whitelist tuples (binding already constrains the validators). No on-chain preset list is built here.

## Self-review notes

- **Spec coverage:** GameBase (escrow, allowlist behind seam, `_heatBound` binding+membership, onCast dispatch, refund/chop surface) — Tasks 3–5. Validator-only CoinFlip with deleted player-secret machinery — Tasks 6–7. Raffle round/commit/cancel/arm/draw/reveal/overwrite/finalise/no-contest/per-ticket-refund/fee — Tasks 8–11. Security invariants (no-abort, guess freeze, seed independence, no sybil) — Task 12. Value conservation — Task 13. Foundry fuzz — deferred section.
- **Cross-layer parity** (off-chain `settle` names the same winner the contract pays) is in **Plan 2**, where both layers exist.
- The seed reduction `1 + (uint256(seed) % 256)` and parity `seed & 1` are implemented identically to how Plan 2's off-chain `settle` must compute them.

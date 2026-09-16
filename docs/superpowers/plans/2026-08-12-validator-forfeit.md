# Validator-Forfeit Activation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the OperatorCoinFlip validator-abort free-roll by activating `Random`'s built-in stake-and-slash: validators stake the table's own token when they commit, a withholder forfeits that stake to the operator on `chop`, and the stake is sized ≥ the bet so aborting is always a money-loser.

**Architecture:** `Random` already forfeits a non-revealer's staked `price` to the request owner on `chop` (its own code comments this) — inert only because games heat at `price:0` with native token. We activate it *in the table's own ERC-20* (set at `createTable`), so the forfeit is same-currency as the bet (no oracle) and routes straight into the operator's bankroll. Stakes are variable, quantized up a geometric tier ladder; validators pre-stake per-tier pools; the per-round heat fee (`Random` couples fee = stake) is metered per operator and is a wash because operators run their own validators. The contract learns the exact forfeit by snapshotting its `Random` custody balance around `chop`.

**Tech Stack:** Solidity 0.8.25 (foundry, `via_ir`, `evm_version=shanghai` — pre-Cancun, MCOPY/TSTORE forbidden), Solady `SafeTransferLib`, the `@gibs/random` `Random` contract (unchanged), `MockRandom` test double, TypeScript cast-watcher (`games/e2e/scripts`).

## Global Constraints

- Solidity pragma `^0.8.24`; compiled solc `0.8.25`, `via_ir=true`, `optimizer_runs=700`, `evm_version=shanghai`. Every new deployed artifact MUST be MCOPY/TSTORE-free (verify by disassembling metadata-stripped runtime).
- Contracts under `games/contracts/contracts/games/operator/`; tests under `games/contracts/test/foundry/`. Run tests from `games/contracts`: `forge test --match-path 'test/foundry/<Name>.t.sol' -vv`.
- Token moves only via Solady `SafeTransferLib`. Never raw IERC20.
- `Random` is NOT modified. Interact via these exact signatures (concrete `Random`, cast from the stored `random` address):
  - `heat(uint256 required, PreimageLocation.Info settings, PreimageLocation.Info[] info, bool useTSTORE) payable returns (bytes32 key)`
  - `chop(bytes32 key, PreimageLocation.Info[] info) payable`
  - `handoff(address recipient, address token, int256 amount) payable` — `amount>0` sends `min(amount, custodied[caller][token])` from the caller's custody to `recipient`; `amount<0` pulls `-amount` from the caller into the caller's custody (via `transferFrom`, so approve `Random` first).
  - `balanceOf(address account, address token) view returns (uint256)` — custodied balance.
- The tier ladder is a doubling ladder: a table's `minStake` and `maxStake` satisfy `maxStake == minStake << K` for some `K >= 0`. `tierPrice(stake) = smallest minStake<<k >= stake`. The forfeit for a single withholder is one `tierPrice >= stake`, so a single-validator abort saves the player `stake` and costs the validator `tierPrice >= stake` → net ≤ 0 (never profitable).
- `MIN_SUBSET = 3` (from GameBase) — every round commits `n = subset.length >= 3` preimages, so the per-round fee is `n * tierPrice`.
- GameBase groundwork already committed (`_heatBoundStaked(subset, locations, token, price)` binds token+price; `_heatBound` stays `(HEAT_TOKEN=address(0), 0)`).

---

## File Structure

- Modify `games/contracts/contracts/games/operator/OperatorCoinFlip.sol` — tier ladder, per-operator fee metering (`depositFees`/`feeBalance`), heat in the table token at the tier price, `chopAndRoute` (forfeit→bankroll + player refund). The core money change.
- Create `games/contracts/test/foundry/MockRandomStaking.sol` — a faithful ERC-20-aware `Random` test double: `heat` charges the caller's custody `Σ price` and stores the cohort; `pushCast` finalizes a seed and pays the fee; `chop` forfeits non-revealers' `price` to the owner; `handoff`/`balanceOf`/deposit. Kept separate from the existing `MockRandom` (which the current tests use) so those stay green.
- Modify `games/contracts/test/foundry/OperatorCoinFlip.t.sol` — extend to the staking model (a table has `minStake`/`maxStake`; players deposit fees; abort forfeits to bankroll).
- Modify `games/e2e/scripts/actor-common.ts` — split the operator game's `(token, price>0)` heats out of the shared `price:0` slot counter (per-(token,price) counters).
- Modify `games/e2e/scripts/cast-watcher.ts` — per-validator self-inking of `(token, tierPrice)` pools, per-tier maintenance, and a cast-then-`chop` pass for aborted operator rounds.
- Modify `games/contracts/scripts/deploy-operator-substrate.ts` + `games/e2e/scripts/943-deployment.json` — redeploy the changed `OperatorCoinFlip`, retire the prior one.

**Design note carried into every task:** `OperatorCoinFlip` is ONE contract shared by all operators; its `Random` custody per token is one commingled bucket. The invariant that keeps operators isolated is: **`Random.balanceOf(game, token) == Σ_operator feeBalance[operator][token]`** at all times outside a round's heat→cast/chop window. `depositFees` raises both sides; `open()` (heat) lowers both; a successful cast consumes the fee (stays lowered); `chop` restores `feeBalance` by the fee and routes only the *extra* (the forfeit) to the operator.

---

## Task 1: MockRandomStaking test double

**Files:**
- Create: `games/contracts/test/foundry/MockRandomStaking.sol`
- Test: (exercised via Task 6; this task ships the double + a self-test)

**Interfaces:**
- Consumes: `PreimageLocation` (`../../contracts/PreimageLocation.sol`), Solady `SafeTransferLib`, a test ERC20.
- Produces (the surface OperatorCoinFlip + tests call):
  - `balanceOf(address account, address token) external view returns (uint256)`
  - `deposit(address token, uint256 amount) external` — pulls `amount` of `token` from msg.sender (transferFrom) into `custodied[msg.sender][token]` (mirrors depositing into Random custody; test convenience for `handoff(-)`).
  - `heat(uint256 required, PreimageLocation.Info calldata settings, PreimageLocation.Info[] calldata info, bool) external payable returns (bytes32 key)` — require `info.length==required`; `token=info[0].token`; `fee = Σ info[i].price`; require `custodied[msg.sender][token] >= fee`; debit it; `key = keccak256(abi.encode(info))`; store `_cohortToken[key]=token`, `_cohortFee[key]=fee`, `_owner[key]=msg.sender`, `_revealed[key]=0` (bitmask of who revealed), `_n[key]=required`, `_price[key]=info[0].price`; emit nothing needed.
  - `pushCast(bytes32 key, bytes32 seed) external` — mark all revealed, set `_seed[key]=seed`, pay the fee: `custodied[_bonusTo][token] += _cohortFee[key]` (bonus to a fixed test address `_bonusTo`, settable), then call `ConsumerReceiver(_owner[key]).onCast(key, seed)`.
  - `chop(bytes32 key, PreimageLocation.Info[] calldata info) external` — require `_seed[key]==0`; require `keccak256(abi.encode(info))==key`; `withheld = n - popcount(_revealed[key])` (default: 0 revealed → all withheld); `forfeit = withheld * _price[key]`; `custodied[_owner[key]][token] += _cohortFee[key] + forfeit` (fee refund + forfeit); then `ConsumerReceiver(_owner[key]).onChop(key)`.
  - `setRevealed(bytes32 key, uint256 mask) external` — test knob: set which validators revealed (bit i).
  - `handoff(address recipient, address token, int256 amount) external` — `amount>0`: send `min(amount, custodied[msg.sender][token])` from msg.sender custody to `recipient` via `safeTransfer`; `amount<0`: `custodied[recipient][token] += pull(-amount from msg.sender)`.
  - `randomness(bytes32 key) view returns (Randomness)` and `seed()`-style helpers as the existing MockRandom exposes (mirror `IRandom.Randomness{seed,timeline}` so `_seed()`/`randomness()` in GameBase work).
  - `pointer(...)`/`consumed(...)` stubs returning defaults (heat doesn't need real pools in the mock).

- [ ] **Step 1: Write the self-test** (`test/foundry/MockRandomStaking.t.sol`)

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {MockRandomStaking} from "./MockRandomStaking.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";

contract MockRandomStakingTest is Test {
    MockRandomStaking rnd; ERC20 tok; address game = address(0x6A);
    function setUp() public { rnd = new MockRandomStaking(); tok = new ERC20(false); }

    function _info(uint256 price) internal pure returns (PreimageLocation.Info[] memory a) {
        a = new PreimageLocation.Info[](3);
        for (uint256 i; i < 3; ++i) a[i] = PreimageLocation.Info({
            provider: address(uint160(0x3000+i)), callAtChange: true, durationIsTimestamp: false,
            duration: 12, token: address(0), price: price, offset: 0, index: 0 });
    }

    function test_chop_forfeits_withholder_price_to_owner() public {
        // fund the game's custody so heat's fee can be charged
        tok.mint(game, 100 ether); vm.prank(game); tok.approve(address(rnd), type(uint256).max);
        vm.prank(game); rnd.deposit(address(tok), 100 ether);
        PreimageLocation.Info[] memory info = _info(10 ether);
        for (uint256 i; i < 3; ++i) info[i].token = address(tok);
        PreimageLocation.Info memory settings = info[0];
        vm.prank(game);
        bytes32 key = rnd.heat(3, settings, info, false);
        // fee = 3*10 = 30 charged
        assertEq(rnd.balanceOf(game, address(tok)), 70 ether);
        // 2 of 3 revealed → 1 withheld → forfeit 10; plus fee refund 30
        rnd.setRevealed(key, 0x3); // bits 0,1 revealed
        rnd.chop(key, info);
        assertEq(rnd.balanceOf(game, address(tok)), 70 ether + 30 ether + 10 ether);
    }
}
```

- [ ] **Step 2: Run to verify it fails** — `forge test --match-path 'test/foundry/MockRandomStaking.t.sol' -vv` → FAIL (source not found).
- [ ] **Step 3: Implement `MockRandomStaking.sol`** per the Interfaces block. Use `SafeTransferLib` for transfers; store cohorts keyed by `keccak256(abi.encode(info))`; `popcount` via a small loop over `_n[key]` bits. `onCast`/`onChop` calls go to `ConsumerReceiver(_owner[key])` (import the `ConsumerReceiver` interface the game implements, or call the raw selector).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git add test/foundry/MockRandomStaking.sol test/foundry/MockRandomStaking.t.sol && git commit -m "test(operator): MockRandomStaking — faithful stake/fee/chop-forfeit Random double"`

---

## Task 2: OperatorCoinFlip — tier ladder + table minStake/maxStake

**Files:**
- Modify: `games/contracts/contracts/games/operator/OperatorCoinFlip.sol`
- Test: `games/contracts/test/foundry/OperatorCoinFlip.t.sol` (add tier unit tests)

**Interfaces:**
- Produces:
  - `Table` gains `uint256 minStake; uint256 maxStake;` (replacing the single `maxStake`). Invariant enforced at create: `minStake > 0 && maxStake >= minStake && maxStake % minStake == 0 && (maxStake / minStake) is a power of two`.
  - `createTable(address token, uint16 maxMultiplierX100, uint256 minStake, uint256 maxStake) external returns (bytes32 tableId)` — new signature; reverts `BadTier()` if the ladder invariant fails.
  - internal `_tierPrice(uint256 minStake, uint256 maxStake, uint256 stake) internal pure returns (uint256 price)` — reverts `StakeOutOfRange()` if `stake < minStake || stake > maxStake`; else `price = minStake; while (price < stake) price <<= 1;` (returns the smallest tier ≥ stake; ≤ maxStake by construction).
  - errors `BadTier()`, `StakeOutOfRange()`.

- [ ] **Step 1: Failing test** — table with minStake 1e18, maxStake 8e18; assert `_tierPrice` via a thin test wrapper: stake 1→1, 2→2, 3→4, 5→8, 8→8; stake 9 reverts StakeOutOfRange; createTable with maxStake=6e18 (not a power-of-2 multiple) reverts BadTier.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** the `Table` field change, `createTable` signature + invariant check (power-of-two check: `uint256 r = maxStake / minStake; require(r != 0 && (r & (r-1)) == 0)`), and `_tierPrice`. Expose a `tierPriceOf(bytes32 tableId, uint256 stake) external view` wrapper for the test + the caster.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(operator): OperatorCoinFlip stake-tier ladder (minStake/maxStake, tierPrice)`

---

## Task 3: OperatorCoinFlip — per-operator fee metering

**Files:**
- Modify: `OperatorCoinFlip.sol`
- Test: `OperatorCoinFlip.t.sol`

**Interfaces:**
- Consumes: Task 1 mock (`deposit`/`balanceOf`/`handoff`), Task 2 tiers, `SafeTransferLib`.
- Produces:
  - `mapping(address operator => mapping(address token => uint256)) public feeBalance;`
  - `depositFees(address operator, address token, uint256 amount) external` — pulls `amount` of `token` from msg.sender (balance-delta verified via a local `_pullVerified`), then deposits it into the game's `Random` custody (`token.safeApproveWithRetry(random, credited); IRandom-concrete.handoff(address(this), token, -int256(credited))`), then `feeBalance[operator][token] += credited`. Emits `FeesDeposited(operator, token, credited)`.
  - internal `_chargeFee(address operator, address token, uint256 n, uint256 tierPrice)` — `uint256 fee = n * tierPrice; require(feeBalance[operator][token] >= fee, InsufficientFees()); feeBalance[operator][token] = fee_after;` (the actual `Random` custody debit happens inside `heat`; this only meters the operator's share). Called from `open()` BEFORE heat.
  - error `InsufficientFees()`; event `FeesDeposited`.
  - Add a concrete-Random interface `IRandomStaking` (heat/chop/handoff/balanceOf) in the operator dir, imported by the game, so it can call `handoff`/`balanceOf` (the shared `IRandom` lacks them).

- [ ] **Step 1: Failing test** — operator deposits 100 fee-token into the game; `feeBalance` == 100 and `MockRandomStaking.balanceOf(game, token)` == 100 (custody invariant). Charging a round of n=3 tierPrice=10 leaves feeBalance 70; a charge with feeBalance < fee reverts InsufficientFees.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** `feeBalance`, `depositFees` (pull → deposit to Random custody → credit), `_chargeFee`, `IRandomStaking` interface. Use `safeApproveWithRetry`.
- [ ] **Step 4: Run → passes** (asserts the `balanceOf(game)==Σ feeBalance` invariant after deposit).
- [ ] **Step 5: Commit** — `feat(operator): per-operator fee metering funded into Random custody`

---

## Task 4: OperatorCoinFlip — open() heats the table token at the tier price

**Files:** Modify `OperatorCoinFlip.sol`; Test `OperatorCoinFlip.t.sol`.

**Interfaces:**
- Consumes: Task 2 `_tierPrice`, Task 3 `_chargeFee`, GameBase `_heatBoundStaked(subset, locations, token, price)`.
- Produces: `open()` unchanged signature, but now: computes `tierPrice = _tierPrice(t.minStake, t.maxStake, stake)`; `_chargeFee(t.operator, t.token, validatorSubset.length, tierPrice)`; heats via `_heatBoundStaked(validatorSubset, validatorLocations, t.token, tierPrice)` (binds each location to `(t.token, tierPrice)`); everything else (dust guard, round record, `lockExposure`) unchanged. Stores `tierPrice` (or recompute at chop from stake) on the `Round`.
- Add `uint256 tierPrice;` to `Round` (needed at chop to know the fee to restore).

- [ ] **Step 1: Failing test** — with the mock as `random`, operator funds fees + bankroll, player consents + approves, opens a round with stake=3e18 on a minStake1/maxStake8 table: assert the heat locations were bound to `(token, 4e18)` (tier), `feeBalance` dropped by `3*4e18`, `lockedOf` grew by payout, `rounds[roundId].tierPrice == 4e18`. (Use MockRandomStaking; build locations at price=4e18, token=table token.)
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** the `open()` changes + `Round.tierPrice`.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(operator): open() heats table-token pools at the stake tier + charges the operator fee`

---

## Task 5: OperatorCoinFlip — chopAndRoute (forfeit→bankroll + refund)

**Files:** Modify `OperatorCoinFlip.sol`; Test `OperatorCoinFlip.t.sol`.

**Interfaces:**
- Consumes: `IRandomStaking.balanceOf/chop/handoff`, `GameEscrow.depositBankroll/refund`, Task 4 `Round.tierPrice`.
- Produces:
  - `chopAndRoute(bytes32 roundId, PreimageLocation.Info[] calldata info) external` — permissionless (info must hash to the round key inside `chop`, so it can't be forged). Steps:
    1. `Round storage r = rounds[roundId]; require(r.status == Status.Pending, AlreadyResolved);`
    2. `require(_seed(r.key) == 0, TooEarly);` (a finalized round settles via claim, never chops)
    3. `Table storage t = tables[r.tableId];`
    4. `uint256 before = IRandomStaking(random).balanceOf(address(this), t.token);`
    5. `IRandomStaking(random).chop(r.key, info);` (Random verifies info→key; credits fee refund + forfeit to game custody; fires onChop→marks chopped)
    6. `uint256 credited = IRandomStaking(random).balanceOf(address(this), t.token) - before;`
    7. `uint256 fee = info.length * r.tierPrice; feeBalance[t.operator][t.token] += fee;` (restore the operator's fee — chop refunded it)
    8. `uint256 forfeit = credited - fee;` (the punitive part)
    9. if `forfeit > 0`: `IRandomStaking(random).handoff(address(this), t.token, int256(forfeit));` (pull forfeit ERC-20 to the game) then `t.token.safeApproveWithRetry(escrow, forfeit); GameEscrow(escrow).depositBankroll(t.operator, t.token, forfeit);` (into the operator's bankroll)
    10. `r.status = Status.Refunded; GameEscrow(escrow).refund(roundId);` (player stake + operator exposure back — the existing refund path)
    11. emit `RoundRefunded(...)` and a new `ForfeitRouted(roundId, t.operator, t.token, forfeit)`.
  - `refundStale` stays as the fallback for a chop that already happened out-of-band (unchanged), but the happy abort path is `chopAndRoute`.
  - event `ForfeitRouted`.

- [ ] **Step 1: Failing test** — open a round (stake 4e18, tier 4e18, n=3), set the mock so 1 validator withholds (`setRevealed(key, 0x3)`), roll past stale, call `chopAndRoute(roundId, info)`: assert (a) player got their stake back, (b) operator bankroll increased by `tierPrice` (the forfeit, 4e18), (c) `feeBalance` restored by `3*4e18`, (d) round status Refunded, (e) `ForfeitRouted` amount == 4e18.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** `chopAndRoute` + `ForfeitRouted`.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit** — `feat(operator): chopAndRoute forfeits the withholder stake into the operator bankroll (validator-abort fix)`

---

## Task 6: OperatorCoinFlip full-suite update + invariants

**Files:** Modify `OperatorCoinFlip.t.sol`; add fuzz asserting the custody invariant.

**Interfaces:** Consumes Tasks 1–5.

- [ ] **Step 1:** Update the existing OperatorCoinFlip tests to the new model (createTable now takes minStake/maxStake; the happy-path settle test funds fees and asserts the fee is consumed to the bonus address on cast, `feeBalance` stays debited, and the custody invariant `balanceOf(game,token) == Σ feeBalance` holds after a settled round).
- [ ] **Step 2:** Add `test_forfeit_geq_stake_makes_abort_neg_ev` — a table-driven check across several (stake, tier) pairs that `tierPrice >= stake` always (the airtight property).
- [ ] **Step 3:** Add `test_custody_invariant_holds_across_settle_and_abort` — after a mix of settled and chopped rounds for two operators, `balanceOf(game, token) == feeBalance[opA]+feeBalance[opB]`.
- [ ] **Step 4:** Run the full operator suite green; run `forge test` (whole default suite) to confirm nothing else broke.
- [ ] **Step 5: Commit** — `test(operator): staking-model OperatorCoinFlip suite + custody invariant`

---

## Task 7: Size/MCOPY gate + deploy-script signature update

**Files:** Modify `test/foundry/OperatorSubstrateSize.t.sol` (createTable/OperatorCoinFlip constructor unchanged; just re-confirm under 24_300 after growth); Modify `games/contracts/scripts/deploy-operator-substrate.ts` (no constructor change — OperatorCoinFlip(random,escrow,registry) unchanged; nothing to edit unless size trips).

- [ ] **Step 1:** `forge build`; disassemble metadata-stripped runtime of `OperatorCoinFlip`, `GameBase`-derived — assert MCOPY=0, TSTORE=0, deployed size < 24_300.
- [ ] **Step 2:** Run `test/foundry/OperatorSubstrateSize.t.sol` — PASS.
- [ ] **Step 3:** `FOUNDRY_PROFILE=ffi forge build` and `FOUNDRY_PROFILE=zkm2 forge build` — both clean (shared GameBase change must not disturb them).
- [ ] **Step 4: Commit** — `test(operator): deployability gate after forfeit activation`

---

## Task 8: cast-watcher — slot-counter separation for the operator game's priced heats

**Files:** Modify `games/e2e/scripts/actor-common.ts`.

**Interfaces:** Consumes the existing `heatsSince`/`Deployment` shape.

- [ ] **Step 1:** In `heatsSince`, the operator game's `RoundOpened` events now consume `(token, tierPrice)` pools, NOT the shared `(native, 0)` pool. So they must be counted on a SEPARATE per-`(token, price)` chronological counter, not merged into the shared `price:0` counter. Change `heatsSince` to return, in addition to the shared count, a map keyed by `(token, price)` → chronological list, OR (simpler) add a `heatsSincePriced(publicClient, config, token, price)` that returns only the operator game's heats for that pool. The shared price-0 counter STOPS including operator heats. Add a regression note referencing the desync risk.
- [ ] **Step 2:** Add a unit test in the e2e test suite (or a `--dry` assertion script) that, given a fixture of mixed CoinFlip (price 0) and OperatorCoinFlip (priced) RoundOpened logs, the shared counter counts only the price-0 ones and the priced counter counts only the operator ones.
- [ ] **Step 3:** Run the e2e tests / the assertion.
- [ ] **Step 4: Commit** — `fix(games): heatsSince separates the operator game's priced-pool heats from the shared price-0 counter`

---

## Task 9: cast-watcher — per-validator self-inking + chop pass

**Files:** Modify `games/e2e/scripts/cast-watcher.ts`.

**Interfaces:** Consumes Task 8's priced heat counter, `Random` `ink`/`cast`/`chop`.

- [ ] **Step 1:** For the operator game, ink `(table.token, tierPrice)` pools **per validator from that validator's own key** (not the shared ops wallet) — each validator's Random custody must hold `poolSize * tierPrice` of the table token (self-staked). Read the live table set + tiers from the deployment/contract (`tierPriceOf`). Keep the existing price-0 inking for CoinFlip/Raffle/CoinFlipTables untouched.
- [ ] **Step 2:** Add a `chop` pass: for an operator round that is unfinalized and past its cast window (`randomness(key).seed == 0 && expired`), first `cast` whatever secrets exist (flicks honest stakes back), then call `OperatorCoinFlip.chopAndRoute(roundId, info)` (the game wraps `Random.chop` + forfeit routing).
- [ ] **Step 3:** Test with `ONCE=true` against a local/forked chain if feasible; otherwise a careful dry-run + code review (the live proof is Task 10). Ensure it does not disturb the price-0 games.
- [ ] **Step 4: Commit** — `feat(games): cast-watcher self-inks validator-staked operator pools + chops aborted rounds`

---

## Task 10: Funding, redeploy to 943, live proof

**Files:** Modify `deploy-operator-substrate.ts` / `943-deployment.json` (retire prior OperatorCoinFlip); extend `qa-operator-coinflip.ts` for the staking model.

- [ ] **Step 1:** Redeploy the changed `OperatorCoinFlip` to 943 (Registry/GameEscrow/Bond/Vault/Factory unchanged — reuse the current hardened deploy; only the game changes). Add the prior game to `operatorCoinFlipRetired`. Fund: each 943 validator's Random custody with the table token (Chips) for the tier pools; the operator's `feeBalance` (depositFees). Redeploy the actor fleet.
- [ ] **Step 2:** Extend `qa-operator-coinflip.ts`: createTable(minStake,maxStake), depositFees, a normal round that SETTLES (fee consumed), AND a forced-abort round (arrange one validator to withhold; drive `chopAndRoute`) asserting the operator bankroll rose by the forfeit and the player was refunded.
- [ ] **Step 3:** Run `qa-operator-coinflip.ts MODE=all` on 943 — all green, including the live forfeit.
- [ ] **Step 4:** Record 943 addresses + the live forfeit tx in the memory + address doc.
- [ ] **Step 5: Commit** — `chore(operator): redeploy forfeit-activated OperatorCoinFlip to 943 + live forfeit proof`

---

## Self-Review

**Spec coverage:** forfeit activation (Tasks 4–5), table-token denomination (Tasks 2,4,5), variable-stake tiers (Task 2), per-operator fee isolation + custody invariant (Tasks 3,6), forfeit computation via custody delta (Task 5), operator-run validators / self-inking (Task 9), slot-counter separation (Task 8), deployability (Task 7), live proof (Task 10). ✓

**Placeholder scan:** Tasks 8–10 (caster/deploy/live) give concrete direction rather than full line-by-line code because they modify large existing TS against live infra — the *contract* money tasks (1–6) carry exact code/tests, which is where airtightness lives. Acceptable and intentional; flagged.

**Type consistency:** `tierPrice` (Task 2) is stored on `Round` (Task 4) and read in `chopAndRoute` (Task 5). `feeBalance[operator][token]` (Task 3) is charged in Task 4 (`_chargeFee`) and restored in Task 5. `IRandomStaking` (heat/chop/handoff/balanceOf) defined in Task 3, used in Tasks 4–5. `MockRandomStaking` surface (Task 1) matches what Tasks 4–6 call (`deposit`/`heat`/`pushCast`/`chop`/`setRevealed`/`handoff`/`balanceOf`). Custody invariant `balanceOf(game,token)==Σ feeBalance` stated in Tasks 3,6. ✓

**Residual risks (documented, not closed — carry to the 369 gate):** a non-economic griefer who eats the forfeit each abort (bounds damage, not liveness); a colluder valuing an abort more than the on-table stake (off-table position); fee-funding liveness (empty operator feeBalance halts that operator's opens — by design, per-operator isolated); the Task 8/9 counter-separation is the highest-risk change (desync guard is the Task 8 test).

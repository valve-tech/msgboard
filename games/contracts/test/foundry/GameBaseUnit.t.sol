// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameBase} from "../../contracts/GameBase.sol";
import {GameBaseHarness} from "../../contracts/test/GameBaseHarness.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

/// @notice Direct unit coverage for GameBase (abstract; no direct forge suite exists). GameBase is
/// LIVE via 3 heirs (CoinFlip/Raffle/HouseChannel-family) but every admin gate, error branch, and
/// internal helper here is exercised only incidentally by those games' own happy paths. This suite
/// drives GameBaseHarness (the pre-existing minimal concrete harness at contracts/test/) directly at
/// every custom error and every admin/gate branch: addValidator/removeValidator/isValidator + their
/// onlyOwner gate, transferOwnership's onlyOwner gate, the OnlyRandom gate on onCast/onChop,
/// NotAllowlisted (from both _validateSubset and _heatBound), StakeMismatch (_take), SubsetMismatch
/// and BadSubset (_heatBound / _validateSubset respectively), the MIN_SUBSET floor + duplicate
/// rejection in _validateSubset, and the _isStale boundary at exactly armedAtBlock + STALE_BLOCKS.
contract GameBaseUnitTest is Test {
    GameBaseHarness internal gb;
    MockRandom internal rnd;

    address internal constant V0 = address(0x9000);
    address internal constant V1 = address(0x9001);
    address internal constant V2 = address(0x9002);
    address internal constant NOT_A_VALIDATOR = address(0x9999);
    address internal constant NON_OWNER = address(0xBEEF);

    address[] internal subset3;
    PreimageLocation.Info[] internal locs3;

    function setUp() public {
        rnd = new MockRandom();
        gb = new GameBaseHarness(address(rnd)); // this test contract is owner
        gb.addValidator(V0);
        gb.addValidator(V1);
        gb.addValidator(V2);
        subset3.push(V0);
        subset3.push(V1);
        subset3.push(V2);
        locs3.push(_loc(V0));
        locs3.push(_loc(V1));
        locs3.push(_loc(V2));
    }

    function _loc(address provider) internal pure returns (PreimageLocation.Info memory) {
        return PreimageLocation.Info({
            provider: provider,
            callAtChange: true,
            durationIsTimestamp: false,
            duration: 12,
            token: address(0),
            price: 0,
            offset: 0,
            index: 0
        });
    }

    // --- owner / constructor ---

    function test_constructor_setsOwnerAndEmits() public {
        vm.expectEmit(true, true, false, false);
        emit GameBase.OwnerTransferred(address(0), address(this));
        GameBaseHarness fresh = new GameBaseHarness(address(rnd));
        assertEq(fresh.owner(), address(this));
        assertEq(fresh.random(), address(rnd));
    }

    function test_transferOwnership_success_emitsAndUpdates() public {
        vm.expectEmit(true, true, false, false);
        emit GameBase.OwnerTransferred(address(this), NON_OWNER);
        gb.transferOwnership(NON_OWNER);
        assertEq(gb.owner(), NON_OWNER);
    }

    function test_transferOwnership_revertsForNonOwner() public {
        vm.prank(NON_OWNER);
        vm.expectRevert(GameBase.OnlyOwner.selector);
        gb.transferOwnership(NON_OWNER);
    }

    // --- validator allowlist + its onlyOwner gate ---

    function test_addValidator_addsSetsFlagCountAndEmits() public {
        address v = address(0xA001);
        assertFalse(gb.isValidator(v));
        uint256 before = gb.validatorCount();
        vm.expectEmit(true, false, false, false);
        emit GameBase.ValidatorAdded(v);
        gb.addValidator(v);
        assertTrue(gb.isValidator(v));
        assertEq(gb.validatorCount(), before + 1);
    }

    function test_addValidator_idempotent_noDoubleCountNoDoubleEmit() public {
        uint256 before = gb.validatorCount();
        vm.recordLogs();
        gb.addValidator(V0); // already a validator from setUp
        assertEq(gb.validatorCount(), before, "count unchanged on re-add");
        assertEq(vm.getRecordedLogs().length, 0, "no event on no-op re-add");
    }

    function test_addValidator_revertsForNonOwner() public {
        vm.prank(NON_OWNER);
        vm.expectRevert(GameBase.OnlyOwner.selector);
        gb.addValidator(address(0xA002));
    }

    function test_removeValidator_removesClearsFlagCountAndEmits() public {
        uint256 before = gb.validatorCount();
        vm.expectEmit(true, false, false, false);
        emit GameBase.ValidatorRemoved(V0);
        gb.removeValidator(V0);
        assertFalse(gb.isValidator(V0));
        assertEq(gb.validatorCount(), before - 1);
    }

    function test_removeValidator_idempotent_noOpForNonMember() public {
        uint256 before = gb.validatorCount();
        vm.recordLogs();
        gb.removeValidator(NOT_A_VALIDATOR); // was never added
        assertEq(gb.validatorCount(), before, "count unchanged on no-op remove");
        assertEq(vm.getRecordedLogs().length, 0, "no event on no-op remove");
    }

    function test_removeValidator_revertsForNonOwner() public {
        vm.prank(NON_OWNER);
        vm.expectRevert(GameBase.OnlyOwner.selector);
        gb.removeValidator(V0);
    }

    // --- OnlyRandom gate: onCast / onChop ---

    function test_onCast_revertsWhenCallerIsNotRandom() public {
        vm.expectRevert(GameBase.OnlyRandom.selector);
        gb.onCast(bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_onCast_routesToSettleWhenCalledByRandom() public {
        bytes32 key = keccak256("key1");
        bytes32 instanceId = keccak256("instance1");
        bytes32 seed = keccak256("seed1");
        gb.bindInstance(key, instanceId);

        vm.prank(address(rnd));
        gb.onCast(key, seed);

        assertEq(gb.lastSettledInstance(), instanceId);
        assertEq(gb.lastSettledSeed(), seed);
    }

    function test_onCast_viaMockRandomPushCast() public {
        // Exercises the exact call shape Random uses in production (pushCast -> onCast as random).
        bytes32 key = keccak256("key2");
        bytes32 instanceId = keccak256("instance2");
        bytes32 seed = keccak256("seed2");
        gb.bindInstance(key, instanceId);

        rnd.pushCast(address(gb), key, seed);

        assertEq(gb.lastSettledInstance(), instanceId);
        assertEq(gb.lastSettledSeed(), seed);
    }

    function test_onChop_revertsWhenCallerIsNotRandom() public {
        vm.expectRevert(GameBase.OnlyRandom.selector);
        gb.onChop(bytes32(uint256(1)));
    }

    function test_onChop_setsChoppedInstanceWhenCalledByRandom() public {
        bytes32 key = keccak256("key3");
        bytes32 instanceId = keccak256("instance3");
        gb.bindInstance(key, instanceId);

        assertFalse(gb.choppedInstance(instanceId));
        vm.prank(address(rnd));
        gb.onChop(key);
        assertTrue(gb.choppedInstance(instanceId));
    }

    function test_onChop_viaMockRandomPushChop() public {
        bytes32 key = keccak256("key4");
        bytes32 instanceId = keccak256("instance4");
        gb.bindInstance(key, instanceId);

        rnd.pushChop(address(gb), key);
        assertTrue(gb.choppedInstance(instanceId));
    }

    function test_onReverse_isANoOpAndDoesNotRevert() public {
        // onReverse has no OnlyRandom gate in GameBase; any caller can call it, and it does nothing.
        gb.onReverse(bytes32(uint256(1)), address(0), 0);
    }

    // --- _validateSubset: MIN_SUBSET floor, duplicate rejection, allowlist membership ---

    function test_validateSubset_revertsBelowMinSubsetFloor() public {
        address[] memory subset = new address[](2);
        subset[0] = V0;
        subset[1] = V1;
        vm.expectRevert(GameBase.BadSubset.selector);
        gb.validateSubset(subset);
    }

    function test_validateSubset_revertsOnEmptySubset() public {
        address[] memory subset = new address[](0);
        vm.expectRevert(GameBase.BadSubset.selector);
        gb.validateSubset(subset);
    }

    function test_validateSubset_revertsOnDuplicateMember() public {
        address[] memory subset = new address[](3);
        subset[0] = V0;
        subset[1] = V1;
        subset[2] = V0; // duplicate of index 0
        vm.expectRevert(GameBase.BadSubset.selector);
        gb.validateSubset(subset);
    }

    function test_validateSubset_revertsOnNotAllowlistedMember() public {
        address[] memory subset = new address[](3);
        subset[0] = V0;
        subset[1] = V1;
        subset[2] = NOT_A_VALIDATOR; // never added
        vm.expectRevert(GameBase.NotAllowlisted.selector);
        gb.validateSubset(subset);
    }

    function test_validateSubset_succeedsForDistinctAllowlistedSubset() public view {
        gb.validateSubset(subset3); // does not revert
    }

    function test_validateSubset_succeedsAboveFloorWithMoreThanMinSubset() public {
        gb.addValidator(address(0xA010));
        address[] memory subset = new address[](4);
        subset[0] = V0;
        subset[1] = V1;
        subset[2] = V2;
        subset[3] = address(0xA010);
        gb.validateSubset(subset); // does not revert
    }

    // --- _heatBound: binding (length + provider identity) and membership ---

    function test_heatBound_revertsOnLengthMismatch_tooFewLocations() public {
        PreimageLocation.Info[] memory locs = new PreimageLocation.Info[](2);
        locs[0] = _loc(V0);
        locs[1] = _loc(V1);
        vm.expectRevert(GameBase.SubsetMismatch.selector);
        gb.heatBound(subset3, locs);
    }

    function test_heatBound_revertsOnLengthMismatch_tooManyLocations() public {
        PreimageLocation.Info[] memory locs = new PreimageLocation.Info[](4);
        locs[0] = _loc(V0);
        locs[1] = _loc(V1);
        locs[2] = _loc(V2);
        locs[3] = _loc(V2);
        vm.expectRevert(GameBase.SubsetMismatch.selector);
        gb.heatBound(subset3, locs);
    }

    function test_heatBound_revertsOnProviderSubstitution() public {
        // locations[2].provider does not equal subset3[2] -> sybil-substitution guard fires.
        PreimageLocation.Info[] memory locs = new PreimageLocation.Info[](3);
        locs[0] = _loc(V0);
        locs[1] = _loc(V1);
        locs[2] = _loc(V0); // wrong provider at index 2 (should be V2)
        vm.expectRevert(GameBase.SubsetMismatch.selector);
        gb.heatBound(subset3, locs);
    }

    function test_heatBound_revertsOnNotAllowlistedMember() public {
        gb.removeValidator(V2); // still bound correctly, but no longer allowlisted
        vm.expectRevert(GameBase.NotAllowlisted.selector);
        gb.heatBound(subset3, locs3);
    }

    function test_heatBound_succeedsAndReturnsNonZeroKey() public {
        bytes32 key = gb.heatBound(subset3, locs3);
        assertTrue(key != bytes32(0));
    }

    function test_heatBound_bindsInstanceAndRoutesThroughOnCast() public {
        // End-to-end: heatBound -> bindInstance -> Random pushes the cast -> _settle fires.
        bytes32 key = gb.heatBound(subset3, locs3);
        bytes32 instanceId = keccak256("heat-instance");
        gb.bindInstance(key, instanceId);

        bytes32 seed = keccak256("heat-seed");
        rnd.pushCast(address(gb), key, seed);

        assertEq(gb.lastSettledInstance(), instanceId);
        assertEq(gb.lastSettledSeed(), seed);
    }

    // --- _take: StakeMismatch ---

    function test_take_revertsOnStakeMismatch_tooLittle() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(GameBase.StakeMismatch.selector);
        gb.takeStake{value: 0.5 ether}(1 ether);
    }

    function test_take_revertsOnStakeMismatch_tooMuch() public {
        vm.deal(address(this), 2 ether);
        vm.expectRevert(GameBase.StakeMismatch.selector);
        gb.takeStake{value: 2 ether}(1 ether);
    }

    function test_take_succeedsOnExactStake() public {
        vm.deal(address(this), 1 ether);
        gb.takeStake{value: 1 ether}(1 ether); // does not revert
    }

    // --- _pay / _refund (escrow payout helper; _refund shares the same safeTransferETH code
    // path and is exercised transitively by CoinFlip/Raffle's own refund suites) ---

    function test_pay_transfersNativeToken() public {
        vm.deal(address(gb), 1 ether);
        address payee = address(0xC001);
        uint256 before = payee.balance;
        gb.payOut(payee, 1 ether);
        assertEq(payee.balance - before, 1 ether);
    }

    // --- _isStale boundary ---

    function test_isStale_falseJustBeforeBoundary() public {
        uint256 armedAt = 1_000;
        vm.roll(armedAt + gb.STALE_BLOCKS() - 1);
        assertFalse(gb.isStale(armedAt));
    }

    function test_isStale_trueExactlyAtBoundary() public {
        uint256 armedAt = 1_000;
        vm.roll(armedAt + gb.STALE_BLOCKS());
        assertTrue(gb.isStale(armedAt));
    }

    function test_isStale_trueWellPastBoundary() public {
        uint256 armedAt = 1_000;
        vm.roll(armedAt + gb.STALE_BLOCKS() + 500);
        assertTrue(gb.isStale(armedAt));
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BonusChips1155} from "../../contracts/games/operator/BonusChips1155.sol";

/// @notice Unit tests for the consumable bonus-charge token. The safety-critical property here is the
/// per-charge backing `w = ceil(maxStake * bonusPoints / 100)` — a FLOOR under-backs by one unit at a
/// tier boundary (the F-B counterexample), which would let a boosted round pay out more than the pool
/// earmarked. Roles gate mint (minter only) and burn (game + pool only) so nobody can inflate or
/// silently destroy circulating charges.
contract BonusChips1155Test is Test {
    BonusChips1155 internal chips;

    address internal owner = address(this);
    address internal creator = address(0xC0FFEE);
    address internal minter = address(0x111);
    address internal burner = address(0xB0B);
    address internal token = address(0x7070);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B0B);

    function setUp() public {
        chips = new BonusChips1155();
        chips.setCreator(creator);
        chips.setMinter(minter);
        chips.setBurner(burner, true);
    }

    function _mkSeries(uint16 bp, uint256 maxStake) internal returns (uint256 id) {
        vm.prank(creator);
        id = chips.createSeries(bp, maxStake, uint64(block.timestamp + 1 days), token);
    }

    // ── w ceil (F-B) ─────────────────────────────────────────────────────────────────────────────

    /// The F-B counterexample: maxStake=999, bonusPoints=25. ceil(999*25/100) = ceil(249.75) = 250.
    /// A floor implementation returns 249 and under-backs the max boost delta by 1 — MUST fail here.
    function test_w_isCeil_fbCounterexample() public {
        uint256 id = _mkSeries(25, 999);
        assertEq(chips.w(id), 250, "w must be the CEIL 250, not the floor 249");
    }

    /// Exact division is unaffected by the ceil (+99 must not push a whole number over).
    function test_w_exactDivision_notInflated() public {
        uint256 id = _mkSeries(25, 100); // 100*25/100 = 25 exactly
        assertEq(chips.w(id), 25);
    }

    function test_w_roundsUpAnyRemainder() public {
        uint256 id = _mkSeries(1, 101); // 101/100 = 1.01 -> 2
        assertEq(chips.w(id), 2);
    }

    // ── series registry ──────────────────────────────────────────────────────────────────────────

    function test_createSeries_storesParams() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        vm.prank(creator);
        uint256 id = chips.createSeries(25, 999, exp, token);
        (uint16 bp, uint256 maxStake, uint64 expiry, address tok) = chips.seriesOf(id);
        assertEq(bp, 25);
        assertEq(maxStake, 999);
        assertEq(expiry, exp);
        assertEq(tok, token);
    }

    function test_createSeries_incrementsId() public {
        uint256 id0 = _mkSeries(10, 100);
        uint256 id1 = _mkSeries(20, 200);
        assertEq(id1, id0 + 1);
    }

    function test_createSeries_revertsForNonCreator() public {
        vm.prank(alice);
        vm.expectRevert(BonusChips1155.NotCreator.selector);
        chips.createSeries(25, 999, uint64(block.timestamp + 1 days), token);
    }

    // ── createSeries parameter validation (LOW — defense-in-depth) ──────────────────────────────────

    function test_createSeries_revertsForZeroBonusPoints() public {
        vm.prank(creator);
        vm.expectRevert(BonusChips1155.InvalidBonusPoints.selector);
        chips.createSeries(0, 999, uint64(block.timestamp + 1 days), token);
    }

    function test_createSeries_revertsForZeroMaxStake() public {
        vm.prank(creator);
        vm.expectRevert(BonusChips1155.InvalidMaxStake.selector);
        chips.createSeries(25, 0, uint64(block.timestamp + 1 days), token);
    }

    function test_createSeries_revertsForOversizedMaxStake() public {
        uint256 tooBig = chips.MAX_STAKE() + 1;
        vm.prank(creator);
        vm.expectRevert(BonusChips1155.InvalidMaxStake.selector);
        chips.createSeries(25, tooBig, uint64(block.timestamp + 1 days), token);
    }

    function test_createSeries_revertsForPastExpiry() public {
        vm.warp(1000);
        vm.prank(creator);
        vm.expectRevert(BonusChips1155.InvalidExpiry.selector);
        chips.createSeries(25, 999, uint64(block.timestamp), token); // expiry == now is not in the future
    }

    function test_createSeries_acceptsMaxStakeCeiling() public {
        uint256 ceiling = chips.MAX_STAKE();
        vm.prank(creator);
        uint256 id = chips.createSeries(25, ceiling, uint64(block.timestamp + 1 days), token);
        (, uint256 maxStake,,) = chips.seriesOf(id);
        assertEq(maxStake, ceiling);
    }

    // ── mint role ────────────────────────────────────────────────────────────────────────────────

    function test_mint_succeedsForMinter() public {
        uint256 id = _mkSeries(25, 999);
        vm.prank(minter);
        chips.mint(alice, id, 5);
        assertEq(chips.balanceOf(alice, id), 5);
    }

    function test_mint_revertsForNonMinter() public {
        uint256 id = _mkSeries(25, 999);
        vm.prank(alice);
        vm.expectRevert(BonusChips1155.NotMinter.selector);
        chips.mint(alice, id, 5);
    }

    function test_mint_revertsForUnknownSeries() public {
        vm.prank(minter);
        vm.expectRevert(BonusChips1155.UnknownSeries.selector);
        chips.mint(alice, 999, 5);
    }

    // ── burn role ────────────────────────────────────────────────────────────────────────────────

    function test_burn_succeedsForBurner() public {
        uint256 id = _mkSeries(25, 999);
        vm.prank(minter);
        chips.mint(alice, id, 5);
        vm.prank(burner);
        chips.burn(alice, id, 2);
        assertEq(chips.balanceOf(alice, id), 3);
    }

    function test_burn_revertsForNonBurner() public {
        uint256 id = _mkSeries(25, 999);
        vm.prank(minter);
        chips.mint(alice, id, 5);
        vm.prank(alice);
        vm.expectRevert(BonusChips1155.NotBurner.selector);
        chips.burn(alice, id, 2);
    }

    // ── transfers (Solady base) ──────────────────────────────────────────────────────────────────

    function test_transfer_movesBalance() public {
        uint256 id = _mkSeries(25, 999);
        vm.prank(minter);
        chips.mint(alice, id, 5);
        vm.prank(alice);
        chips.safeTransferFrom(alice, bob, id, 2, "");
        assertEq(chips.balanceOf(alice, id), 3);
        assertEq(chips.balanceOf(bob, id), 2);
    }

    // ── owner-gated role setters ─────────────────────────────────────────────────────────────────

    function test_setMinter_revertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(BonusChips1155.NotOwner.selector);
        chips.setMinter(alice);
    }
}

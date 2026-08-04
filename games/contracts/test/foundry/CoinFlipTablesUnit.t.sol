// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoinFlipTables} from "../../contracts/games/CoinFlipTables.sol";
import {BankrollLib} from "../../contracts/games/BankrollLib.sol";
import {GameBase} from "../../contracts/GameBase.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

/// @notice Deterministic unit coverage for CoinFlipTables: every function, custom error, and logic
/// branch not already exercised by CoinFlipTables.t.sol (fuzz + setName) or
/// CoinFlipTablesInvariant.t.sol. Each test drives one specific path with hand-picked inputs (no
/// fuzzing) so a solc/forge branch-coverage pass can attribute the hit deterministically.
contract CoinFlipTablesUnitTest is Test {
    CoinFlipTables internal tables;
    MockRandom internal rnd;
    Chips internal chips;

    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    address internal player = address(0xA11CE);
    address internal stranger = address(0xBEEF);
    address internal operatorB = address(0xB0B);
    address internal funder = address(0xF00D);

    uint16 internal constant MULT = 196; // 1.96x, mid-range
    uint256 internal constant BIG = 1_000_000 ether;

    // seeds chosen for LSB parity: EVEN seed's parity bit is 0, ODD's is 1.
    bytes32 internal constant SEED_EVEN = bytes32(uint256(2));
    bytes32 internal constant SEED_ODD = bytes32(uint256(1));

    function setUp() public {
        rnd = new MockRandom();
        chips = new Chips();
        tables = new CoinFlipTables(address(rnd), address(chips));

        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x3000 + i));
            tables.addValidator(v);
            subset.push(v);
            locs.push(PreimageLocation.Info({
                provider: v, callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(0), price: 0, offset: 0, index: 0
            }));
        }

        // test contract is both Chips owner (can mint) and the default table operator/funder.
        chips.approve(address(tables), type(uint256).max);
        vm.prank(player);
        chips.approve(address(tables), type(uint256).max);
        vm.prank(funder);
        chips.approve(address(tables), type(uint256).max);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _winSeed(uint8 side) internal pure returns (bytes32) {
        return side == 0 ? SEED_EVEN : SEED_ODD;
    }

    function _loseSeed(uint8 side) internal pure returns (bytes32) {
        return side == 0 ? SEED_ODD : SEED_EVEN;
    }

    /// @dev Creates a table operated by the test contract and funds hot from freshly minted chips.
    function _tableWithHot(uint16 mult, uint256 maxStake, uint256 hot) internal returns (bytes32 tableId) {
        tableId = tables.createTable(mult, maxStake, 0);
        if (hot > 0) {
            chips.mint(address(this), hot);
            tables.fundHot(tableId, hot);
        }
    }

    /// @dev Player opens a round on `tableId`; mints the player's stake and returns (roundId, key).
    function _open(bytes32 tableId, uint8 side, uint256 stake) internal returns (bytes32 roundId, bytes32 key) {
        chips.mint(player, stake);
        vm.prank(player);
        roundId = tables.open(tableId, side, stake, subset, locs);
        key = _roundKey(roundId);
    }

    // Single-field accessors, deliberately tiny: under the coverage profile's viaIR:false +
    // optimizer:false compile, a test function with a wide tuple destructure (9-field `tables`,
    // 8-field `rounds`) plus half a dozen of its own locals blows the legacy codegen's 16-slot
    // stack window ("stack too deep"). Routing through a one-value-returning helper keeps each
    // call site's own local count small; the helper's temporaries are freed on return.
    function _hot(bytes32 tableId) internal view returns (uint256 hot) {
        (, hot, , , , , , ,) = tables.tables(tableId);
    }

    function _cold(bytes32 tableId) internal view returns (uint256 cold) {
        (, , cold, , , , , ,) = tables.tables(tableId);
    }

    function _escrowed(bytes32 tableId) internal view returns (uint256 escrowed) {
        (, , , escrowed, , , , ,) = tables.tables(tableId);
    }

    function _roundKey(bytes32 roundId) internal view returns (bytes32 key) {
        (, , , , , key, ,) = tables.rounds(roundId);
    }

    function _roundPayout(bytes32 roundId) internal view returns (uint256 payout) {
        (, , , , payout, , ,) = tables.rounds(roundId);
    }

    function _assertStatus(bytes32 roundId, CoinFlipTables.Status expected) internal view {
        (, , , , , , , CoinFlipTables.Status status) = tables.rounds(roundId);
        assertTrue(status == expected);
    }

    // ── createTable ─────────────────────────────────────────────────────────

    function test_createTable_happy() public {
        vm.expectEmit(false, false, false, true, address(tables));
        emit CoinFlipTables.TableCreated(bytes32(0), address(this), MULT, 50 ether, 10 ether);
        bytes32 tableId = tables.createTable(MULT, 50 ether, 10 ether);

        (address op, uint256 hot, uint256 cold, uint256 escrowed, uint256 stake,
            uint16 mult, uint256 maxStake, uint256 hotTarget, bool open) = tables.tables(tableId);
        assertEq(op, address(this), "operator recorded");
        assertEq(hot, 0, "hot starts empty");
        assertEq(cold, 0, "cold starts empty");
        assertEq(escrowed, 0, "escrowed starts empty");
        assertEq(stake, 0, "stake starts empty");
        assertEq(mult, MULT, "multiplier recorded");
        assertEq(maxStake, 50 ether, "maxStake recorded");
        assertEq(hotTarget, 10 ether, "hotTarget recorded");
        assertTrue(open, "table opens by default");
    }

    function test_createTable_badMultiplier_tooLow() public {
        vm.expectRevert(CoinFlipTables.BadMultiplier.selector);
        tables.createTable(149, 1 ether, 0);
    }

    function test_createTable_badMultiplier_tooHigh() public {
        vm.expectRevert(CoinFlipTables.BadMultiplier.selector);
        tables.createTable(201, 1 ether, 0);
    }

    // ── setParams ───────────────────────────────────────────────────────────

    function test_setParams_happy() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.ParamsSet(tableId, 150, 5 ether, 2 ether);
        tables.setParams(tableId, 150, 5 ether, 2 ether);

        (, , , , , uint16 mult, uint256 maxStake, uint256 hotTarget,) = tables.tables(tableId);
        assertEq(mult, 150);
        assertEq(maxStake, 5 ether);
        assertEq(hotTarget, 2 ether);
    }

    function test_setParams_notOperator() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.setParams(tableId, 150, 5 ether, 2 ether);
    }

    function test_setParams_badMultiplier() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        vm.expectRevert(CoinFlipTables.BadMultiplier.selector);
        tables.setParams(tableId, 201, 5 ether, 2 ether);
    }

    // ── setOpen ─────────────────────────────────────────────────────────────

    function test_setOpen_happy() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.OpenSet(tableId, false);
        tables.setOpen(tableId, false);
        (, , , , , , , , bool openAfterClose) = tables.tables(tableId);
        assertFalse(openAfterClose);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.OpenSet(tableId, true);
        tables.setOpen(tableId, true);
        (, , , , , , , , bool openAfterReopen) = tables.tables(tableId);
        assertTrue(openAfterReopen);
    }

    function test_setOpen_notOperator() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.setOpen(tableId, false);
    }

    // ── fundHot / fundCold ──────────────────────────────────────────────────

    function test_fundHot_happy() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(funder, 5 ether);

        uint256 balBefore = chips.balanceOf(address(tables));
        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.HotFunded(tableId, 5 ether);
        vm.prank(funder);
        tables.fundHot(tableId, 5 ether);

        (, uint256 hot, , , , , , ,) = tables.tables(tableId);
        assertEq(hot, 5 ether, "hot credited");
        assertEq(chips.balanceOf(address(tables)), balBefore + 5 ether, "chips pulled in");
    }

    function test_fundHot_noTable() public {
        vm.expectRevert(BankrollLib.NoTable.selector);
        tables.fundHot(bytes32(uint256(0xDEAD)), 1 ether);
    }

    function test_fundCold_happy() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(funder, 5 ether);

        uint256 balBefore = chips.balanceOf(address(tables));
        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.ColdFunded(tableId, 5 ether);
        vm.prank(funder);
        tables.fundCold(tableId, 5 ether);

        (, , uint256 cold, , , , , ,) = tables.tables(tableId);
        assertEq(cold, 5 ether, "cold credited");
        assertEq(chips.balanceOf(address(tables)), balBefore + 5 ether, "chips pulled in");
    }

    function test_fundCold_noTable() public {
        vm.expectRevert(BankrollLib.NoTable.selector);
        tables.fundCold(bytes32(uint256(0xDEAD)), 1 ether);
    }

    // ── withdrawHot / withdrawCold ──────────────────────────────────────────

    function test_withdrawHot_happy() public {
        bytes32 tableId = _tableWithHot(MULT, 1 ether, 10 ether);
        uint256 balBefore = chips.balanceOf(address(this));

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.HotWithdrawn(tableId, 4 ether);
        tables.withdrawHot(tableId, 4 ether);

        (, uint256 hot, , , , , , ,) = tables.tables(tableId);
        assertEq(hot, 6 ether);
        assertEq(chips.balanceOf(address(this)), balBefore + 4 ether);
    }

    function test_withdrawHot_notOperator() public {
        bytes32 tableId = _tableWithHot(MULT, 1 ether, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.withdrawHot(tableId, 1 ether);
    }

    function test_withdrawHot_insufficientHot() public {
        bytes32 tableId = _tableWithHot(MULT, 1 ether, 1 ether);
        vm.expectRevert(BankrollLib.InsufficientHot.selector);
        tables.withdrawHot(tableId, 2 ether);
    }

    function test_withdrawCold_happy() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 10 ether);
        tables.fundCold(tableId, 10 ether);
        uint256 balBefore = chips.balanceOf(address(this));

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.ColdWithdrawn(tableId, 4 ether);
        tables.withdrawCold(tableId, 4 ether);

        (, , uint256 cold, , , , , ,) = tables.tables(tableId);
        assertEq(cold, 6 ether);
        assertEq(chips.balanceOf(address(this)), balBefore + 4 ether);
    }

    function test_withdrawCold_notOperator() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 10 ether);
        tables.fundCold(tableId, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.withdrawCold(tableId, 1 ether);
    }

    function test_withdrawCold_insufficientCold() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 1 ether);
        tables.fundCold(tableId, 1 ether);
        vm.expectRevert(BankrollLib.InsufficientCold.selector);
        tables.withdrawCold(tableId, 2 ether);
    }

    // ── promote / demote ────────────────────────────────────────────────────

    function test_promote_happy() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 10 ether);
        tables.fundCold(tableId, 10 ether);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.Promoted(tableId, 4 ether);
        tables.promote(tableId, 4 ether);

        (, uint256 hot, uint256 cold, , , , , ,) = tables.tables(tableId);
        assertEq(hot, 4 ether);
        assertEq(cold, 6 ether);
    }

    function test_promote_notOperator() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 10 ether);
        tables.fundCold(tableId, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.promote(tableId, 1 ether);
    }

    function test_promote_insufficientCold() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 1 ether);
        tables.fundCold(tableId, 1 ether);
        vm.expectRevert(BankrollLib.InsufficientCold.selector);
        tables.promote(tableId, 2 ether);
    }

    function test_demote_happy() public {
        bytes32 tableId = _tableWithHot(MULT, 1 ether, 10 ether);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.Demoted(tableId, 4 ether);
        tables.demote(tableId, 4 ether);

        (, uint256 hot, uint256 cold, , , , , ,) = tables.tables(tableId);
        assertEq(hot, 6 ether);
        assertEq(cold, 4 ether);
    }

    function test_demote_notOperator() public {
        bytes32 tableId = _tableWithHot(MULT, 1 ether, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.demote(tableId, 1 ether);
    }

    function test_demote_insufficientHot() public {
        bytes32 tableId = _tableWithHot(MULT, 1 ether, 1 ether);
        vm.expectRevert(BankrollLib.InsufficientHot.selector);
        tables.demote(tableId, 2 ether);
    }

    // ── refillHot ───────────────────────────────────────────────────────────

    function test_refillHot_cappedAtNeed() public {
        // hotTarget=100, hot=50 (need=50), cold=200 -> need < cold, move = need = 50.
        bytes32 tableId = tables.createTable(MULT, 1 ether, 100 ether);
        chips.mint(address(this), 250 ether);
        tables.fundHot(tableId, 50 ether);
        tables.fundCold(tableId, 200 ether);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.Refilled(tableId, 50 ether);
        tables.refillHot(tableId);

        (, uint256 hot, uint256 cold, , , , , ,) = tables.tables(tableId);
        assertEq(hot, 100 ether, "hot tops up exactly to target");
        assertEq(cold, 150 ether, "cold debited only the need");
    }

    function test_refillHot_cappedAtCold() public {
        // hotTarget=1000, hot=0 (need=1000), cold=100 -> cold < need, move = cold = 100.
        bytes32 tableId = tables.createTable(MULT, 1 ether, 1000 ether);
        chips.mint(address(this), 100 ether);
        tables.fundCold(tableId, 100 ether);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.Refilled(tableId, 100 ether);
        tables.refillHot(tableId);

        (, uint256 hot, uint256 cold, , , , , ,) = tables.tables(tableId);
        assertEq(hot, 100 ether, "hot receives everything cold has");
        assertEq(cold, 0, "cold drained");
    }

    function test_refillHot_nothingToRefill_hotAtTarget() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 50 ether);
        chips.mint(address(this), 50 ether);
        tables.fundHot(tableId, 50 ether); // hot == hotTarget already
        vm.expectRevert(BankrollLib.NothingToRefill.selector);
        tables.refillHot(tableId);
    }

    function test_refillHot_nothingToRefill_moveZero() public {
        // hotTarget=100, hot=0, cold=0 -> need=100, move=min(need,cold)=0.
        bytes32 tableId = tables.createTable(MULT, 1 ether, 100 ether);
        vm.expectRevert(BankrollLib.NothingToRefill.selector);
        tables.refillHot(tableId);
    }

    function test_refillHot_noTable() public {
        vm.expectRevert(BankrollLib.NoTable.selector);
        tables.refillHot(bytes32(uint256(0xDEAD)));
    }

    function test_refillHot_strangerCanCall() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 100 ether);
        chips.mint(address(this), 100 ether);
        tables.fundCold(tableId, 100 ether);

        vm.prank(stranger); // permissionless — moves no tokens, only internal accounting
        tables.refillHot(tableId);

        (, uint256 hot, uint256 cold, , , , , ,) = tables.tables(tableId);
        assertEq(hot, 100 ether);
        assertEq(cold, 0);
    }

    // ── stakeForRank / unstake ──────────────────────────────────────────────

    function test_stakeForRank_happy() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 10 ether);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.Staked(tableId, 10 ether);
        tables.stakeForRank(tableId, 10 ether);

        (, , , , uint256 stake, , , ,) = tables.tables(tableId);
        assertEq(stake, 10 ether);
    }

    function test_stakeForRank_notOperator() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(stranger, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.stakeForRank(tableId, 10 ether);
    }

    function test_unstake_happy() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 10 ether);
        tables.stakeForRank(tableId, 10 ether);
        uint256 balBefore = chips.balanceOf(address(this));

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.Unstaked(tableId, 4 ether);
        tables.unstake(tableId, 4 ether);

        (, , , , uint256 stake, , , ,) = tables.tables(tableId);
        assertEq(stake, 6 ether);
        assertEq(chips.balanceOf(address(this)), balBefore + 4 ether);
    }

    function test_unstake_notOperator() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 10 ether);
        tables.stakeForRank(tableId, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.unstake(tableId, 1 ether);
    }

    function test_unstake_insufficientStake() public {
        bytes32 tableId = tables.createTable(MULT, 1 ether, 0);
        chips.mint(address(this), 1 ether);
        tables.stakeForRank(tableId, 1 ether);
        vm.expectRevert(BankrollLib.InsufficientStake.selector);
        tables.unstake(tableId, 2 ether);
    }

    // ── open ────────────────────────────────────────────────────────────────

    function test_open_happy() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        uint256 stake = 10 ether;

        // mint the player's stake up front so we can observe the FULL round trip (mint -> pull)
        // against a stable baseline, rather than a baseline captured before the mint even happens.
        chips.mint(player, stake);
        uint256 playerBalBeforePull = chips.balanceOf(player);
        uint256 contractBalBefore = chips.balanceOf(address(tables));

        vm.prank(player);
        bytes32 roundId = tables.open(tableId, 0, stake, subset, locs);

        assertTrue(_roundKey(roundId) != bytes32(0), "heat key recorded");
        _assertRoundFields(roundId, tableId, 0, stake);
        _assertOpenAccounting(tableId, roundId, 100 ether, stake, playerBalBeforePull, contractBalBefore);
    }

    function _assertRoundFields(bytes32 roundId, bytes32 tableId, uint8 side, uint256 stake) internal {
        (bytes32 rTableId, address rPlayer, uint8 rSide, uint256 rStake, , , uint256 rBlock, CoinFlipTables.Status rStatus)
            = tables.rounds(roundId);
        assertEq(rTableId, tableId);
        assertEq(rPlayer, player);
        assertEq(rSide, side);
        assertEq(rStake, stake);
        assertEq(rBlock, block.number);
        assertTrue(rStatus == CoinFlipTables.Status.Pending);
    }

    function _assertOpenAccounting(
        bytes32 tableId,
        bytes32 roundId,
        uint256 hotBeforeOpen,
        uint256 stake,
        uint256 playerBalBeforePull,
        uint256 contractBalBefore
    ) internal {
        uint256 payout = _roundPayout(roundId);
        uint256 exposure = payout - stake;
        assertEq(_hot(tableId), hotBeforeOpen - exposure, "hot debited by exposure only");
        assertEq(_escrowed(tableId), payout, "full payout escrowed");
        assertEq(chips.balanceOf(player), playerBalBeforePull - stake, "stake pulled from player");
        assertEq(chips.balanceOf(address(tables)), contractBalBefore + stake, "contract holds player's stake");
    }

    function test_open_noTable() public {
        vm.prank(player);
        vm.expectRevert(BankrollLib.NoTable.selector);
        tables.open(bytes32(uint256(0xDEAD)), 0, 1 ether, subset, locs);
    }

    function test_open_tableClosed() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        tables.setOpen(tableId, false);
        vm.prank(player);
        vm.expectRevert(CoinFlipTables.TableClosed.selector);
        tables.open(tableId, 0, 1 ether, subset, locs);
    }

    function test_open_wrongSide() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        vm.prank(player);
        vm.expectRevert(CoinFlipTables.WrongSide.selector);
        tables.open(tableId, 2, 1 ether, subset, locs);
    }

    function test_open_zeroStake() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        vm.prank(player);
        vm.expectRevert(CoinFlipTables.ZeroStake.selector);
        tables.open(tableId, 0, 0, subset, locs);
    }

    function test_open_stakeTooHigh() public {
        bytes32 tableId = _tableWithHot(MULT, 5 ether, 100 ether);
        vm.prank(player);
        vm.expectRevert(CoinFlipTables.StakeTooHigh.selector);
        tables.open(tableId, 0, 6 ether, subset, locs);
    }

    function test_open_insufficientBankroll() public {
        // hot=0, so ANY positive stake's exposure exceeds the bankroll.
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 0);
        vm.prank(player);
        vm.expectRevert(CoinFlipTables.InsufficientBankroll.selector);
        tables.open(tableId, 0, 1 ether, subset, locs);
    }

    function test_open_badSubset_singleElement() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        address[] memory tinySubset = new address[](1);
        tinySubset[0] = subset[0];
        PreimageLocation.Info[] memory tinyLocs = new PreimageLocation.Info[](1);
        tinyLocs[0] = locs[0];

        vm.prank(player);
        vm.expectRevert(GameBase.BadSubset.selector);
        tables.open(tableId, 0, 1 ether, tinySubset, tinyLocs);
    }

    function test_open_badSubset_duplicated() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        address[] memory dupSubset = new address[](3);
        dupSubset[0] = subset[0];
        dupSubset[1] = subset[0]; // duplicate
        dupSubset[2] = subset[1];

        vm.prank(player);
        vm.expectRevert(GameBase.BadSubset.selector);
        tables.open(tableId, 0, 1 ether, dupSubset, locs);
    }

    // ── _settle (via onCast push) ───────────────────────────────────────────

    function test_settle_winPushesPayoutToPlayer() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        uint256 stake = 10 ether;
        uint8 side = 0;

        (bytes32 roundId, bytes32 key) = _open(tableId, side, stake);
        uint256 payout = _roundPayout(roundId);
        uint256 hotAfterOpen = _hot(tableId);
        uint256 playerBalBefore = chips.balanceOf(player);

        vm.expectEmit(true, true, true, true, address(tables));
        emit CoinFlipTables.RoundSettled(roundId, tableId, player, true, payout, _winSeed(side), block.number);
        rnd.pushCast(address(tables), key, _winSeed(side));

        _assertWinOutcome(roundId, tableId, payout, playerBalBefore, hotAfterOpen);
    }

    function _assertWinOutcome(
        bytes32 roundId,
        bytes32 tableId,
        uint256 payout,
        uint256 playerBalBefore,
        uint256 hotAfterOpen
    ) internal {
        assertEq(chips.balanceOf(player), playerBalBefore + payout, "player paid full payout");
        assertEq(_hot(tableId), hotAfterOpen, "hot unchanged on win - exposure already left at open");
        assertEq(_escrowed(tableId), 0, "escrow released");
        _assertStatus(roundId, CoinFlipTables.Status.Settled);
    }

    function test_settle_lossReturnsPayoutToHot() public {
        uint256 hotBeforeOpen = 100 ether;
        bytes32 tableId = _tableWithHot(MULT, 50 ether, hotBeforeOpen);
        uint256 stake = 10 ether;
        uint8 side = 0;

        (bytes32 roundId, bytes32 key) = _open(tableId, side, stake);
        uint256 payout = _roundPayout(roundId);
        uint256 playerBalBefore = chips.balanceOf(player);

        vm.expectEmit(true, true, true, true, address(tables));
        emit CoinFlipTables.RoundSettled(roundId, tableId, player, false, payout, _loseSeed(side), block.number);
        rnd.pushCast(address(tables), key, _loseSeed(side));

        _assertLossOutcome(roundId, tableId, playerBalBefore, hotBeforeOpen, stake);
    }

    function _assertLossOutcome(
        bytes32 roundId,
        bytes32 tableId,
        uint256 playerBalBefore,
        uint256 hotBeforeOpen,
        uint256 stake
    ) internal {
        assertEq(chips.balanceOf(player), playerBalBefore, "player receives nothing on a loss");
        assertEq(_hot(tableId), hotBeforeOpen + stake, "whole reservation (exposure+stake) returns to hot");
        assertEq(_escrowed(tableId), 0, "escrow released");
        _assertStatus(roundId, CoinFlipTables.Status.Settled);
    }

    /// @notice _settle's internal AlreadyResolved guard (CoinFlipTables.sol ~line 295) fires even
    /// when reached via the SAME push path twice — instanceByKey[key] is never cleared, so a second
    /// onCast for a key whose round already settled must revert. MockRandom.pushCast calls
    /// ConsumerReceiver(game).onCast(...) directly with no try/catch, so the revert is NOT swallowed
    /// and propagates straight out of the second pushCast call — proving the guard is reachable and
    /// live, not dead code behind an already-caught outer path.
    function test_settle_doubleCastRevertsAlreadyResolved() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        (, bytes32 key) = _open(tableId, 0, 10 ether);

        rnd.pushCast(address(tables), key, _winSeed(0)); // first delivery settles fine

        vm.expectRevert(CoinFlipTables.AlreadyResolved.selector);
        rnd.pushCast(address(tables), key, _loseSeed(0)); // second delivery for the same key
    }

    // ── claim (pull fallback) ───────────────────────────────────────────────

    function test_claim_win() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        uint256 stake = 10 ether;
        uint8 side = 1;

        (bytes32 roundId, bytes32 key) = _open(tableId, side, stake);
        uint256 payout = _roundPayout(roundId);
        uint256 playerBalBefore = chips.balanceOf(player);

        rnd.setSeed(key, _winSeed(side)); // finalize WITHOUT delivering the push
        tables.claim(roundId);

        assertEq(chips.balanceOf(player), playerBalBefore + payout, "claim pays out on a win");
        _assertStatus(roundId, CoinFlipTables.Status.Settled);
    }

    function test_claim_loss() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        uint256 stake = 10 ether;
        uint8 side = 1;

        (bytes32 roundId, bytes32 key) = _open(tableId, side, stake);
        uint256 playerBalBefore = chips.balanceOf(player);
        uint256 hotAfterOpen = _hot(tableId);

        rnd.setSeed(key, _loseSeed(side));
        tables.claim(roundId);

        assertEq(chips.balanceOf(player), playerBalBefore, "no payout on a loss");
        assertEq(_hot(tableId), hotAfterOpen + stake * MULT / 100, "payout returns to hot");
        _assertStatus(roundId, CoinFlipTables.Status.Settled);
    }

    function test_claim_tooEarly() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        (bytes32 roundId, ) = _open(tableId, 0, 10 ether);

        vm.expectRevert(CoinFlipTables.TooEarly.selector);
        tables.claim(roundId);
    }

    function test_claim_alreadyResolved() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        (bytes32 roundId, bytes32 key) = _open(tableId, 0, 10 ether);
        rnd.pushCast(address(tables), key, _winSeed(0));

        vm.expectRevert(CoinFlipTables.AlreadyResolved.selector);
        tables.claim(roundId);
    }

    // ── refundStale ─────────────────────────────────────────────────────────

    function test_refundStale_timeout() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        uint256 stake = 10 ether;
        (bytes32 roundId, ) = _open(tableId, 0, stake);
        uint256 hotAfterOpen = _hot(tableId);
        uint256 playerBalBefore = chips.balanceOf(player);

        vm.roll(block.number + tables.STALE_BLOCKS() + 1);

        uint256 payout = _roundPayout(roundId);
        vm.expectEmit(true, true, true, true, address(tables));
        emit CoinFlipTables.Refunded(roundId, tableId, player, stake, payout, block.number);
        tables.refundStale(roundId);

        _assertRefundOutcome(roundId, tableId, stake, payout, hotAfterOpen, playerBalBefore);
    }

    function _assertRefundOutcome(
        bytes32 roundId,
        bytes32 tableId,
        uint256 stake,
        uint256 payout,
        uint256 hotAfterOpen,
        uint256 playerBalBefore
    ) internal {
        uint256 exposure = payout - stake;
        assertEq(chips.balanceOf(player), playerBalBefore + stake, "player reclaims own stake");
        assertEq(_hot(tableId), hotAfterOpen + exposure, "exposure returns to hot");
        assertEq(_escrowed(tableId), 0, "escrow released");
        _assertStatus(roundId, CoinFlipTables.Status.Refunded);
    }

    function test_refundStale_chopped() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        uint256 stake = 10 ether;
        (bytes32 roundId, bytes32 key) = _open(tableId, 0, stake);

        rnd.pushChop(address(tables), key); // marks choppedInstance[roundId] = true

        // BEFORE the 200-block stale window — only reachable via the chopped branch.
        tables.refundStale(roundId);

        _assertStatus(roundId, CoinFlipTables.Status.Refunded);
    }

    function test_refundStale_tooEarly_immediate() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        (bytes32 roundId, ) = _open(tableId, 0, 10 ether);

        // no chop, not stale, seed missing -> falls through to the second TooEarly guard.
        vm.expectRevert(CoinFlipTables.TooEarly.selector);
        tables.refundStale(roundId);
    }

    function test_refundStale_tooEarly_seedPresent() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        (bytes32 roundId, bytes32 key) = _open(tableId, 0, 10 ether);

        // seed finalized but not yet delivered/claimed — value-decided, refundStale must refuse
        // even though it's otherwise identical to the immediate case (first TooEarly guard).
        rnd.setSeed(key, _winSeed(0));
        vm.expectRevert(CoinFlipTables.TooEarly.selector);
        tables.refundStale(roundId);
    }

    function test_refundStale_alreadyResolvedAfterSettle() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        (bytes32 roundId, bytes32 key) = _open(tableId, 0, 10 ether);
        rnd.pushCast(address(tables), key, _winSeed(0));

        vm.expectRevert(CoinFlipTables.AlreadyResolved.selector);
        tables.refundStale(roundId);
    }

    function test_refundStale_doubleRefundAlreadyResolved() public {
        bytes32 tableId = _tableWithHot(MULT, 50 ether, 100 ether);
        (bytes32 roundId, ) = _open(tableId, 0, 10 ether);
        vm.roll(block.number + tables.STALE_BLOCKS() + 1);
        tables.refundStale(roundId);

        vm.expectRevert(CoinFlipTables.AlreadyResolved.selector);
        tables.refundStale(roundId);
    }

    // ── params bind only new rounds ─────────────────────────────────────────

    function test_paramsChangeDoesNotAffectOpenRoundsPayout() public {
        bytes32 tableId = _tableWithHot(200, 50 ether, 100 ether);
        uint256 stake = 10 ether;
        uint256 payoutAt200 = stake * 200 / 100; // snapshot at open time

        (bytes32 roundId, bytes32 key) = _open(tableId, 0, stake);

        // operator lowers the table's multiplier AFTER the round is already open
        tables.setParams(tableId, 150, 50 ether, 100 ether);

        uint256 playerBalBefore = chips.balanceOf(player);
        rnd.pushCast(address(tables), key, _winSeed(0));

        assertEq(chips.balanceOf(player), playerBalBefore + payoutAt200, "settle pays the ORIGINAL 2x snapshot, not the lowered 1.5x");
        _assertStatus(roundId, CoinFlipTables.Status.Settled);
    }
}

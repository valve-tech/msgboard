// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoinFlipTables} from "../../contracts/games/CoinFlipTables.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

/// @notice Fuzz the load-bearing accounting guarantee of CoinFlipTables: settlement (win or loss)
/// conserves every chip the contract holds across the table's four pools, and NEVER touches `cold`.
/// cold is the operator's reserve — only fund/withdraw/promote/demote/refill may move it, never the
/// open/settle round path. The seed is driven by MockRandom so both parity branches are exercised.
contract CoinFlipTablesFuzzTest is Test {
    CoinFlipTables internal tables;
    MockRandom internal rnd;
    Chips internal chips;
    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    address internal player = address(0x9E7);
    uint16 internal constant MULT = 196; // 1.96x
    uint256 internal constant MAX_STAKE = 100 ether;

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
        // this contract is the table operator/funder; approve once for all fund* pulls
        chips.approve(address(tables), type(uint256).max);
        // the player pre-approves so open() can pull the stake
        vm.prank(player);
        chips.approve(address(tables), type(uint256).max);
    }

    /// After a fuzzed fund + open + push-settle sequence, both hold for ANY seed parity:
    ///   (1) hot + cold + escrowed + stake == chips.balanceOf(address(tables))  (nothing leaks)
    ///   (2) cold == coldBefore                                                 (settle never touches cold)
    function testFuzz_ColdOnlyMovesViaExplicitOps(uint96 hotAmt, uint96 coldAmt, uint96 stakeRaw) public {
        uint256 stake = bound(uint256(stakeRaw), 1, MAX_STAKE);
        uint256 payout = stake * MULT / 100;
        uint256 exposure = payout - stake;
        // hot must at least cover the operator's exposure or open() reverts (InsufficientBankroll)
        uint256 hot = bound(uint256(hotAmt), exposure, exposure + 1_000 ether);
        uint256 cold = bound(uint256(coldAmt), 0, 1_000 ether);

        bytes32 tableId = tables.createTable(MULT, MAX_STAKE, hot + cold);
        chips.mint(address(this), hot + cold);
        tables.fundHot(tableId, hot);
        tables.fundCold(tableId, cold);

        // snapshot cold AFTER funding — the invariant under test is that settle leaves it exactly here
        (,, uint256 coldBefore,,,,,,) = tables.tables(tableId);
        assertEq(coldBefore, cold, "cold funded as expected");

        // player opens a HEADS round; capture the heat key from the stored Round (tuple index 5)
        chips.mint(player, stake);
        vm.prank(player);
        bytes32 roundId = tables.open(tableId, 0, stake, subset, locs);
        (,,,,, bytes32 key,,) = tables.rounds(roundId);

        // drive a finalized seed + push the onCast settle. Vary parity across the fuzz corpus so both
        // the win (pay player) and loss (return payout to hot) branches are covered.
        uint256 seedWord = uint256(keccak256(abi.encode(hotAmt, coldAmt, stakeRaw)));
        rnd.pushCast(address(tables), key, bytes32(seedWord));

        (, uint256 hotA, uint256 coldA, uint256 escA, uint256 stakeA,,,,) = tables.tables(tableId);
        assertEq(hotA + coldA + escA + stakeA, chips.balanceOf(address(tables)), "pools conserve the contract's chips");
        assertEq(coldA, coldBefore, "settlement never touched cold");
        assertEq(escA, 0, "escrow released on settle");
    }
}

/// @notice Unit coverage for setName's operator gate and length cap. The existing TS suite covers
/// the happy path and a single unrelated caller reverting; this fills the gap it misses — an
/// operator who legitimately owns a DIFFERENT table must still be rejected on someone else's table.
contract CoinFlipTablesSetNameTest is Test {
    CoinFlipTables internal tables;
    MockRandom internal rnd;
    Chips internal chips;

    address internal operatorA = address(this);
    address internal operatorB = address(0xB0B);
    address internal stranger = address(0xBEEF);

    function setUp() public {
        rnd = new MockRandom();
        chips = new Chips();
        tables = new CoinFlipTables(address(rnd), address(chips));
    }

    function test_setName_nonOperatorReverts() public {
        bytes32 tableIdA = tables.createTable(150, 1 ether, 0);

        // a completely unrelated wallet cannot name A's table
        vm.prank(stranger);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.setName(tableIdA, "stranger's table");

        // operator B creates their OWN table, then tries to name A's table — must also revert,
        // even though B is a legitimate operator (just not of THIS table)
        vm.prank(operatorB);
        tables.createTable(150, 1 ether, 0);

        vm.prank(operatorB);
        vm.expectRevert(CoinFlipTables.NotOperator.selector);
        tables.setName(tableIdA, "B trying to rename A's table");

        // operator A can name their own table
        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.TableNamed(tableIdA, "Mike's table");
        tables.setName(tableIdA, "Mike's table");
    }

    function test_setName_boundaryLength() public {
        bytes32 tableId = tables.createTable(150, 1 ether, 0);

        bytes memory name64Bytes = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            name64Bytes[i] = "a";
        }
        string memory name64 = string(name64Bytes);

        vm.expectEmit(true, false, false, true, address(tables));
        emit CoinFlipTables.TableNamed(tableId, name64);
        tables.setName(tableId, name64);

        bytes memory name65Bytes = new bytes(65);
        for (uint256 i = 0; i < 65; i++) {
            name65Bytes[i] = "a";
        }
        string memory name65 = string(name65Bytes);

        vm.expectRevert(CoinFlipTables.NameTooLong.selector);
        tables.setName(tableId, name65);
    }
}

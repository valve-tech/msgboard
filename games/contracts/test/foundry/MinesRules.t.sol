// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MinesRules} from "../../contracts/games/MinesRules.sol";

/// Thin external wrapper so vm.expectRevert can catch reverts of the (internal, inlined) library at a
/// lower call depth. Mirrors how a HouseChannel-style settle entrypoint would consult MinesRules.
contract MinesRulesHarness {
    function settle(
        MinesRules.MinesClaim calldata claim,
        uint16[] calldata mineTiles,
        bytes32 salt,
        uint256 escrowPlayer,
        uint256 escrowHouse
    ) external pure returns (uint256, uint256) {
        return MinesRules.settle(claim, mineTiles, salt, escrowPlayer, escrowHouse);
    }
}

/// Parity + rejection suite for the MINES dispute-replay mirror (gameId 5). All numeric vectors are
/// produced by examples/games/msgboard-settle/scripts/gen-recompute-vectors.ts from the REAL
/// gibs/msgboard-games TS (never hand-derived) — same vector-provenance pattern as GamePayouts.t.sol.
///
/// Board: 25 tiles, 3 mines at {5,12,20}, salt = 0x22..22.
///   mines-win : reveals [0,1,2,3,4], cash out  -> multX100 198, payout 396
///   mines-bust: reveals [0,1,12] (12 is a mine) -> multX100   0, payout   0
/// Escrow ceiling = clearing all 22 safe tiles -> multX100 227700; escrowHouse sized to it (455200) so
/// stake(200) + escrowHouse == 455400 == the pot, and every honest cash-out fits under it.
contract MinesRulesTest is Test {
    MinesRulesHarness internal h;
    function setUp() public { h = new MinesRulesHarness(); }

    uint256 internal constant STAKE = 200;          // escrowPlayer
    uint256 internal constant ESCROW_HOUSE = 455200; // stake*(ceiling-100)/100, ceiling = 227700
    bytes32 internal constant SALT = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
    bytes32 internal constant COMMIT = 0x1365a47735e9e864602b454bcc43a563c87d5e99e34dcc3fca31f8428b9c61e3;
    uint16 internal constant TILES = 25;
    uint16 internal constant MINES = 3;

    uint256 internal constant MULT_WIN = 198;
    uint256 internal constant PAYOUT_WIN = 396;

    function _mineTiles() internal pure returns (uint16[] memory a) {
        a = new uint16[](3);
        a[0] = 5;
        a[1] = 12;
        a[2] = 20;
    }

    function _reveals(uint16[] memory a) internal pure returns (uint16[] memory) {
        return a;
    }

    function _arr5(uint16 a, uint16 b, uint16 c, uint16 d, uint16 e) internal pure returns (uint16[] memory r) {
        r = new uint16[](5);
        r[0] = a; r[1] = b; r[2] = c; r[3] = d; r[4] = e;
    }

    function _arr3(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[] memory r) {
        r = new uint16[](3);
        r[0] = a; r[1] = b; r[2] = c;
    }

    function _claim(uint16[] memory reveals, bool cashedOut, uint256 claimedMultX100)
        internal
        pure
        returns (MinesRules.MinesClaim memory c)
    {
        c.tiles = TILES;
        c.mines = MINES;
        c.commit = COMMIT;
        c.reveals = reveals;
        c.cashedOut = cashedOut;
        c.claimedMultiplierX100 = claimedMultX100;
    }

    // ---- commitment parity: the ported preimage reproduces the TS hashBoard exactly ----
    function test_commit_matchesTs() public pure {
        assertEq(MinesRules.hashBoard(TILES, MINES, _mineTiles(), SALT), COMMIT);
    }

    // ---- multiplier parity: edged multiplier after 5 safe reveals == the TS vector ----
    function test_multiplier_matchesTs() public pure {
        assertEq(MinesRules.multiplierX100At(TILES, MINES, 5), MULT_WIN);   // 198
        assertEq(MinesRules.multiplierX100At(TILES, MINES, 22), 227700);    // ceiling (all safe cleared)
    }

    // ---- a legit WIN: cash out after 5 safe reveals ----
    function test_win_matchesTs() public view {
        (uint256 bP, uint256 bH) =
            h.settle(_claim(_arr5(0, 1, 2, 3, 4), true, MULT_WIN), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
        assertEq(bP, PAYOUT_WIN);
        assertEq(bP + bH, STAKE + ESCROW_HOUSE); // conservation
    }

    // ---- a legit LOSS: revealing tile 12 (a mine) busts ----
    function test_bust_matchesTs() public view {
        (uint256 bP, uint256 bH) =
            h.settle(_claim(_arr3(0, 1, 12), false, 0), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
        assertEq(bP, 0);
        assertEq(bH, STAKE + ESCROW_HOUSE); // house keeps the whole pot
    }

    // ---- REJECT: a swapped board (different mine layout) no longer hashes to the commitment ----
    function test_reject_forgedBoard() public {
        uint16[] memory bad = new uint16[](3);
        bad[0] = 6; bad[1] = 12; bad[2] = 20; // moved a mine 5 -> 6
        vm.expectRevert(MinesRules.CommitMismatch.selector);
        h.settle(_claim(_arr5(0, 1, 2, 3, 4), true, MULT_WIN), bad, SALT, STAKE, ESCROW_HOUSE);
    }

    // ---- REJECT: an inflated payout — claiming a higher multiplier than the honest replay ----
    function test_reject_inflatedMultiplier() public {
        vm.expectRevert(MinesRules.MultiplierMismatch.selector);
        h.settle(_claim(_arr5(0, 1, 2, 3, 4), true, MULT_WIN + 100), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    // ---- REJECT: an illegal claim — claiming a cash-out over a sequence that hit a mine ----
    function test_reject_cashOutOverMine() public {
        // reveals [0,1,12] busts on 12; claiming cashedOut=true contradicts the replay.
        vm.expectRevert(MinesRules.IllegalMove.selector);
        h.settle(_claim(_arr3(0, 1, 12), true, 0), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    // ---- REJECT: a duplicate reveal is an illegal move ----
    function test_reject_duplicateReveal() public {
        vm.expectRevert(MinesRules.IllegalMove.selector);
        h.settle(_claim(_arr3(0, 0, 1), true, MinesRules.multiplierX100At(TILES, MINES, 1)), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }

    // ---- REJECT: claiming a bust when no revealed tile was a mine ----
    function test_reject_bustWithoutMine() public {
        vm.expectRevert(MinesRules.IllegalMove.selector);
        h.settle(_claim(_arr3(0, 1, 2), false, 0), _mineTiles(), SALT, STAKE, ESCROW_HOUSE);
    }
}

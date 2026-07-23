// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LadderRules} from "../../contracts/games/LadderRules.sol";

/// Thin external wrapper so vm.expectRevert can catch reverts of the (internal, inlined) library at a
/// lower call depth. Mirrors how a HouseChannel-style settle entrypoint would consult LadderRules.
contract LadderRulesHarness {
    function settle(LadderRules.LadderClaim calldata claim, uint256 escrowPlayer, uint256 escrowHouse)
        external
        pure
        returns (uint256, uint256)
    {
        return LadderRules.settle(claim, escrowPlayer, escrowHouse);
    }
}

/// Parity + rejection suite for the LADDER dispute-replay mirror (towers 14, chicken 15, greed-dice 19).
/// All vectors are produced by examples/games/msgboard-settle/scripts/gen-recompute-vectors.ts from the
/// REAL gibs/msgboard-games TS (never hand-derived) — same provenance pattern as GamePayouts.t.sol.
contract LadderRulesTest is Test {
    LadderRulesHarness internal h;
    function setUp() public { h = new LadderRulesHarness(); }

    uint256 internal constant STAKE = 200; // escrowPlayer

    function _u16(uint16 a) internal pure returns (uint16[] memory r) { r = new uint16[](1); r[0] = a; }
    function _u16x3(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[] memory r) {
        r = new uint16[](3); r[0] = a; r[1] = b; r[2] = c;
    }
    function _u16x4(uint16 a, uint16 b, uint16 c, uint16 d) internal pure returns (uint16[] memory r) {
        r = new uint16[](4); r[0] = a; r[1] = b; r[2] = c; r[3] = d;
    }
    function _u16x6(uint16 a, uint16 b, uint16 c, uint16 d, uint16 e, uint16 f) internal pure returns (uint16[] memory r) {
        r = new uint16[](6); r[0] = a; r[1] = b; r[2] = c; r[3] = d; r[4] = e; r[5] = f;
    }

    function _claim(
        uint8 gameId,
        bytes memory config,
        bytes32 commit,
        uint256 seed,
        uint32 maxSteps,
        uint16[] memory choices,
        bool cashedOut,
        uint256 multX100
    ) internal pure returns (LadderRules.LadderClaim memory c) {
        c.gameId = gameId;
        c.config = config;
        c.commit = commit;
        c.seed = seed;
        c.maxSteps = maxSteps;
        c.choices = choices;
        c.cashedOut = cashedOut;
        c.claimedMultiplierX100 = multX100;
    }

    // ============================== TOWERS (gameId 14) ==============================
    // floors=6, tilesPerFloor=3, safePerFloor=2, seed=29527.
    //   towers-win : choices [0,1,1,0]      cash out -> multX100 500,  payout 1000
    //   towers-top : choices [0,1,1,0,1,0]  (climb all 6, forced win) -> multX100 1127, payout 2254
    //   towers-bust: choices [0,1,0]        (unsafe at floor 2) -> multX100 0, payout 0
    // Escrow ceiling 1127 -> escrowHouse 2054, pot 2254.
    bytes32 internal constant TOWERS_COMMIT = 0x29b69a7a4ae9e1e70de229599e7d026143990a5f06ad277f426aa6c8c5840b10;
    uint256 internal constant TOWERS_SEED = 29527;
    uint256 internal constant TOWERS_ESCROW_HOUSE = 2054;

    function _towersConfig() internal pure returns (bytes memory) {
        return abi.encode(uint256(6), uint256(3), uint256(2)); // floors, tilesPerFloor, safePerFloor
    }

    function test_towers_commit_matchesTs() public pure {
        assertEq(LadderRules.commitLayout(TOWERS_SEED), TOWERS_COMMIT);
    }

    function test_towers_win_matchesTs() public pure {
        (uint256 bP, uint256 bH) = LadderRules.settle(
            _claim(14, _towersConfig(), TOWERS_COMMIT, TOWERS_SEED, 6, _u16x4(0, 1, 1, 0), true, 500),
            STAKE, TOWERS_ESCROW_HOUSE
        );
        assertEq(bP, 1000);
        assertEq(bP + bH, STAKE + TOWERS_ESCROW_HOUSE);
    }

    function test_towers_top_forcedWin_matchesTs() public pure {
        (uint256 bP, uint256 bH) = LadderRules.settle(
            _claim(14, _towersConfig(), TOWERS_COMMIT, TOWERS_SEED, 6, _u16x6(0, 1, 1, 0, 1, 0), true, 1127),
            STAKE, TOWERS_ESCROW_HOUSE
        );
        assertEq(bP, 2254);              // full pot: ceiling reached
        assertEq(bH, 0);
        assertEq(bP + bH, STAKE + TOWERS_ESCROW_HOUSE);
    }

    function test_towers_bust_matchesTs() public pure {
        (uint256 bP, uint256 bH) = LadderRules.settle(
            _claim(14, _towersConfig(), TOWERS_COMMIT, TOWERS_SEED, 6, _u16x3(0, 1, 0), false, 0),
            STAKE, TOWERS_ESCROW_HOUSE
        );
        assertEq(bP, 0);
        assertEq(bH, STAKE + TOWERS_ESCROW_HOUSE);
    }

    // REJECT: wrong seed no longer matches the layout commitment.
    function test_towers_reject_forgedSeed() public {
        vm.expectRevert(LadderRules.CommitMismatch.selector);
        h.settle(
            _claim(14, _towersConfig(), TOWERS_COMMIT, TOWERS_SEED + 1, 6, _u16x4(0, 1, 1, 0), true, 500),
            STAKE, TOWERS_ESCROW_HOUSE
        );
    }

    // REJECT: inflated multiplier over an honest climb.
    function test_towers_reject_inflatedMultiplier() public {
        vm.expectRevert(LadderRules.MultiplierMismatch.selector);
        h.settle(
            _claim(14, _towersConfig(), TOWERS_COMMIT, TOWERS_SEED, 6, _u16x4(0, 1, 1, 0), true, 1127),
            STAKE, TOWERS_ESCROW_HOUSE
        );
    }

    // REJECT: claiming a cash-out over a sequence that actually busted (unsafe pick at floor 2).
    function test_towers_reject_cashOutOverBust() public {
        vm.expectRevert(LadderRules.IllegalMove.selector);
        h.settle(
            _claim(14, _towersConfig(), TOWERS_COMMIT, TOWERS_SEED, 6, _u16x3(0, 1, 0), true, 500),
            STAKE, TOWERS_ESCROW_HOUSE
        );
    }

    // ============================== CHICKEN (gameId 15) ==============================
    // difficulty=medium (crash 3 of 25), lanes=12. Single forced path (choice 0).
    //   chicken-win : seed=3,  choices [0,0,0,0] cash out -> multX100 164, payout 328
    //   chicken-bust: seed=13, choices [0,0,0]   (crash at lane 2) -> multX100 0, payout 0
    // Escrow ceiling 458 -> escrowHouse 716, pot 916.
    bytes32 internal constant CHICKEN_WIN_COMMIT = 0xc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b;
    bytes32 internal constant CHICKEN_BUST_COMMIT = 0xd7b6990105719101dabeb77144f2a3385c8033acd3af97e9423a695e81ad1eb5;
    uint256 internal constant CHICKEN_ESCROW_HOUSE = 716;

    function _chickenConfig() internal pure returns (bytes memory) {
        return abi.encode(uint256(12), uint256(3)); // lanes, crashCount
    }

    function test_chicken_win_matchesTs() public pure {
        (uint256 bP, uint256 bH) = LadderRules.settle(
            _claim(15, _chickenConfig(), CHICKEN_WIN_COMMIT, 3, 12, _u16x4(0, 0, 0, 0), true, 164),
            STAKE, CHICKEN_ESCROW_HOUSE
        );
        assertEq(bP, 328);
        assertEq(bP + bH, STAKE + CHICKEN_ESCROW_HOUSE);
    }

    function test_chicken_bust_matchesTs() public pure {
        (uint256 bP, uint256 bH) = LadderRules.settle(
            _claim(15, _chickenConfig(), CHICKEN_BUST_COMMIT, 13, 12, _u16x3(0, 0, 0), false, 0),
            STAKE, CHICKEN_ESCROW_HOUSE
        );
        assertEq(bP, 0);
        assertEq(bH, STAKE + CHICKEN_ESCROW_HOUSE);
    }

    // REJECT: replaying a crash sequence but claiming a cash-out.
    function test_chicken_reject_cashOutOverBust() public {
        vm.expectRevert(LadderRules.IllegalMove.selector);
        h.settle(
            _claim(15, _chickenConfig(), CHICKEN_BUST_COMMIT, 13, 12, _u16x3(0, 0, 0), true, 164),
            STAKE, CHICKEN_ESCROW_HOUSE
        );
    }

    // ============================== GREED DICE (gameId 19) ==============================
    // bustFaces=2 (of 6), rolls=10.
    //   greeddice-win : seed=1, choices [0,0,0] cash out -> multX100 333, payout 666
    //   greeddice-bust: seed=6, choices [0,0,0] (bust on roll 2) -> multX100 0, payout 0
    // Escrow ceiling 5708 -> escrowHouse 11216, pot 11416.
    bytes32 internal constant GREED_WIN_COMMIT = 0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6;
    bytes32 internal constant GREED_BUST_COMMIT = 0xf652222313e28459528d920b65115c16c04f3efc82aaedc97be59f3f377c0d3f;
    uint256 internal constant GREED_ESCROW_HOUSE = 11216;

    function _greedConfig() internal pure returns (bytes memory) {
        return abi.encode(uint256(10), uint256(2)); // rolls, bustFaces
    }

    function test_greeddice_win_matchesTs() public pure {
        (uint256 bP, uint256 bH) = LadderRules.settle(
            _claim(19, _greedConfig(), GREED_WIN_COMMIT, 1, 10, _u16x3(0, 0, 0), true, 333),
            STAKE, GREED_ESCROW_HOUSE
        );
        assertEq(bP, 666);
        assertEq(bP + bH, STAKE + GREED_ESCROW_HOUSE);
    }

    function test_greeddice_bust_matchesTs() public pure {
        (uint256 bP, uint256 bH) = LadderRules.settle(
            _claim(19, _greedConfig(), GREED_BUST_COMMIT, 6, 10, _u16x3(0, 0, 0), false, 0),
            STAKE, GREED_ESCROW_HOUSE
        );
        assertEq(bP, 0);
        assertEq(bH, STAKE + GREED_ESCROW_HOUSE);
    }

    // REJECT: inflated multiplier on the greed-dice win.
    function test_greeddice_reject_inflatedMultiplier() public {
        vm.expectRevert(LadderRules.MultiplierMismatch.selector);
        h.settle(
            _claim(19, _greedConfig(), GREED_WIN_COMMIT, 1, 10, _u16x3(0, 0, 0), true, 500),
            STAKE, GREED_ESCROW_HOUSE
        );
    }

    // REJECT: an unknown gameId is not mirrored.
    function test_reject_unknownGame() public {
        vm.expectRevert(LadderRules.UnknownGame.selector);
        h.settle(
            _claim(99, _greedConfig(), GREED_WIN_COMMIT, 1, 10, _u16x3(0, 0, 0), true, 333),
            STAKE, GREED_ESCROW_HOUSE
        );
    }
}

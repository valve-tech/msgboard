// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LadderRules} from "../../contracts/games/LadderRules.sol";
import {LadderRulesHarness} from "./LadderRules.t.sol";

/// COVERAGE-ONLY companion to LadderRules.t.sol. Closes the two named remaining gaps (BadConfig,
/// PayoutExceedsPot) plus the untested cash-out/bust reconciliation edges (step==0 cash-out, and
/// claimed-bust-but-no-bust). No contract changes; reuses LadderRulesHarness from LadderRules.t.sol
/// so vm.expectRevert catches reverts at the correct call depth (see that file for rationale).
///
/// Every claim here computes its `commit` via LadderRules.commitLayout(seed) directly instead of a
/// hand-copied hash literal, so there is no risk of a transcription error masking the intended
/// revert path with an unrelated CommitMismatch.
contract LadderRulesUnitTest is Test {
    LadderRulesHarness internal h;
    function setUp() public { h = new LadderRulesHarness(); }

    uint256 internal constant STAKE = 200;

    function _u16(uint16 a) internal pure returns (uint16[] memory r) { r = new uint16[](1); r[0] = a; }
    function _u16x4(uint16 a, uint16 b, uint16 c, uint16 d) internal pure returns (uint16[] memory r) {
        r = new uint16[](4); r[0] = a; r[1] = b; r[2] = c; r[3] = d;
    }
    function _empty() internal pure returns (uint16[] memory r) { r = new uint16[](0); }

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

    /// Mirror of the (private) LadderRules._subRandom formula, per the contract's own NatSpec:
    /// "subRandom(raw, index) = uint256(keccak256(abi.encode(uint256 raw, uint64 index)))". Used ONLY
    /// to pick a deterministic seed for the "claimed bust but no bust" test below — never calls into
    /// the library's private surface.
    function _subRandomMirror(uint256 raw, uint64 index) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(raw, index)));
    }

    /// Search for a seed whose greed-dice roll at `rollIndex` is SAFE under `bustFaces` (of 6), i.e.
    /// (subRandom(seed, rollIndex) % 6) >= bustFaces. With bustFaces=1 only 1/6 of seeds bust, so this
    /// resolves almost immediately; the loop bound is generous headroom, not a tuned constant.
    function _findSafeGreedSeed(uint256 bustFaces, uint64 rollIndex) internal pure returns (uint256) {
        for (uint256 s = 1; s < 1000; s++) {
            if ((_subRandomMirror(s, rollIndex) % 6) >= bustFaces) return s;
        }
        revert("no safe seed found");
    }

    // ============================== BadConfig — top-level (maxSteps < 1) ==============================

    function test_reject_badConfig_maxStepsZero() public {
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(14, abi.encode(uint256(6), uint256(3), uint256(2)), bytes32(0), 1, 0, _empty(), false, 0),
            STAKE, 2054
        );
    }

    // ============================== BadConfig — TOWERS (gameId 14) ==============================
    // if (floors != maxSteps || S < 1 || S > T - 1 || T < 2) revert BadConfig();
    // NOTE: the trailing `T < 2` disjunct is provably unreachable as a deciding clause — see the
    // worktree report for why (short-circuit ordering forces either `S > T - 1` to fire first at
    // T==1, or a checked-arithmetic underflow Panic at T==0 before this disjunct is even reached).

    function test_reject_badConfig_towers_floorsMismatch() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(
                14, abi.encode(uint256(6), uint256(3), uint256(2)), LadderRules.commitLayout(seed), seed,
                5, // maxSteps != floors(6)
                _u16(0), false, 0
            ),
            STAKE, 2054
        );
    }

    function test_reject_badConfig_towers_safePerFloorZero() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(
                14, abi.encode(uint256(6), uint256(3), uint256(0)), // safePerFloor = 0
                LadderRules.commitLayout(seed), seed, 6, _u16(0), false, 0
            ),
            STAKE, 2054
        );
    }

    function test_reject_badConfig_towers_safePerFloorAtOrAboveTiles() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(
                14, abi.encode(uint256(6), uint256(3), uint256(3)), // safePerFloor == tilesPerFloor
                LadderRules.commitLayout(seed), seed, 6, _u16(0), false, 0
            ),
            STAKE, 2054
        );
    }

    // ============================== BadConfig — CHICKEN (gameId 15) ==============================
    // if (lanes != maxSteps || crashCount < 1 || crashCount >= CHICKEN_OUTCOMES(25)) revert BadConfig();

    function test_reject_badConfig_chicken_lanesMismatch() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(15, abi.encode(uint256(12), uint256(3)), LadderRules.commitLayout(seed), seed, 5, _u16(0), false, 0),
            STAKE, 716
        );
    }

    function test_reject_badConfig_chicken_crashCountZero() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(15, abi.encode(uint256(12), uint256(0)), LadderRules.commitLayout(seed), seed, 12, _u16(0), false, 0),
            STAKE, 716
        );
    }

    function test_reject_badConfig_chicken_crashCountAtOrAboveOutcomes() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(15, abi.encode(uint256(12), uint256(25)), LadderRules.commitLayout(seed), seed, 12, _u16(0), false, 0),
            STAKE, 716
        );
    }

    // ============================== BadConfig — GREED DICE (gameId 19) ==============================
    // if (rolls != maxSteps || bustFaces < 1 || bustFaces >= GREED_FACES(6)) revert BadConfig();

    function test_reject_badConfig_greed_rollsMismatch() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(19, abi.encode(uint256(10), uint256(2)), LadderRules.commitLayout(seed), seed, 5, _u16(0), false, 0),
            STAKE, 11216
        );
    }

    function test_reject_badConfig_greed_bustFacesZero() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(19, abi.encode(uint256(10), uint256(0)), LadderRules.commitLayout(seed), seed, 10, _u16(0), false, 0),
            STAKE, 11216
        );
    }

    function test_reject_badConfig_greed_bustFacesAtOrAboveFaces() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(19, abi.encode(uint256(10), uint256(6)), LadderRules.commitLayout(seed), seed, 10, _u16(0), false, 0),
            STAKE, 11216
        );
    }

    // ============================== BadConfig — CIPHER (gameId 26) ==============================
    // if (rungs != maxSteps || symbols < 2) revert BadConfig();

    function test_reject_badConfig_cipher_rungsMismatch() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(26, abi.encode(uint256(5), uint256(4)), LadderRules.commitLayout(seed), seed, 4, _u16(0), false, 0),
            STAKE, 202552
        );
    }

    function test_reject_badConfig_cipher_symbolsBelowTwo() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.BadConfig.selector);
        h.settle(
            _claim(26, abi.encode(uint256(5), uint256(1)), LadderRules.commitLayout(seed), seed, 5, _u16(0), false, 0),
            STAKE, 202552
        );
    }

    // ============================== PayoutExceedsPot ==============================

    /// Honest towers win (floors=6,T=3,S=2, seed=29527 -> multX100 500 over STAKE 200 => payout 1000,
    /// same vector as LadderRules.t.sol's test_towers_win_matchesTs) but the house escrow supplied at
    /// settlement time is far below the ceiling: pot (200+0) cannot cover the payout.
    function test_reject_payoutExceedsPot_towersWin() public {
        uint256 seed = 29527;
        vm.expectRevert(LadderRules.PayoutExceedsPot.selector);
        h.settle(
            _claim(
                14, abi.encode(uint256(6), uint256(3), uint256(2)), LadderRules.commitLayout(seed), seed,
                6, _u16x4(0, 1, 1, 0), true, 500
            ),
            STAKE, 0 // escrowHouse starved: pot=200 < payout=1000
        );
    }

    // ============================== cash-out / bust reconciliation edges ==============================

    /// Claimed cash-out with zero steps replayed (empty choices array): "cannot cash out before any
    /// step" — step==0 after the replay loop, cashedOut=true, busted=false.
    function test_reject_cashOutBeforeAnyStep() public {
        uint256 seed = 1;
        vm.expectRevert(LadderRules.IllegalMove.selector);
        h.settle(
            _claim(
                14, abi.encode(uint256(6), uint256(3), uint256(2)), LadderRules.commitLayout(seed), seed,
                6, _empty(), true, 0
            ),
            STAKE, 2054
        );
    }

    /// Claimed bust (cashedOut=false) over a replay that actually succeeded (busted=false): "claimed
    /// bust but no step busted". Uses a 1-roll greed-dice ladder (rolls=1, bustFaces=1) with a seed
    /// searched to be SAFE on that single roll, so the honest replay reaches the top without busting.
    function test_reject_claimedBustButNoBust_greedDice() public {
        uint256 bustFaces = 1;
        uint256 seed = _findSafeGreedSeed(bustFaces, 0);
        vm.expectRevert(LadderRules.IllegalMove.selector);
        h.settle(
            _claim(
                19, abi.encode(uint256(1), bustFaces), LadderRules.commitLayout(seed), seed,
                1, _u16(0), false, 0
            ),
            STAKE, 11216
        );
    }
}

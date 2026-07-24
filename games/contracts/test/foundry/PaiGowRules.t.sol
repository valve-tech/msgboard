// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaiGowRules} from "../../contracts/games/PaiGowRules.sol";

/// Thin external wrapper so vm.expectRevert can catch reverts of the (internal, inlined) library at a
/// lower call depth. Mirrors how a HouseChannel-style settle entrypoint would consult PaiGowRules.
contract PaiGowRulesHarness {
    function settle(PaiGowRules.PaiGowClaim calldata claim, uint256 escrowPlayer, uint256 escrowHouse)
        external
        pure
        returns (uint256, uint256)
    {
        return PaiGowRules.settle(claim, escrowPlayer, escrowHouse);
    }
}

/// Parity + rejection suite for the PAI GOW POKER dispute-replay mirror (gameId 27). All vectors are
/// produced by the REAL msgboard-games TS reference (src/games/paiGow.ts) via a realistic 256-bit round
/// seed (subRandom(i+1, 0)); the player auto-sets by house way (playerHouseWayPositions) except the foul
/// case, which forces a fouling front. STAKE 200; an even-money win returns 2.00x, so escrowHouse == STAKE
/// makes the pot 400 == the win payout (the escrow ceiling exactly met).
contract PaiGowRulesTest is Test {
    PaiGowRulesHarness internal h;
    function setUp() public { h = new PaiGowRulesHarness(); }

    uint256 internal constant STAKE = 200;
    uint256 internal constant ESCROW_HOUSE = 200; // pot 400 == 2.00x win

    // win: player wins both hands. seed/front/commit from the TS reference.
    uint256 internal constant WIN_SEED =
        37470079394597546017821359402343014298469527652371950473243809108734949064165;
    bytes32 internal constant WIN_COMMIT = 0x8c5463c4917005f6f56c5b404257d4579d1c38c101ead4559bdf4510fcfa0ebd;

    // push: each side wins one hand.
    uint256 internal constant PUSH_SEED =
        78541660797044910968829902406342334108369226379826116161446442989268089806461;
    bytes32 internal constant PUSH_COMMIT = 0x3f9553dc324cd1fd24b54243720c42e18e5c20165bc5e523e42b440a8654abd1;

    // lose: dealer wins/ties both hands.
    uint256 internal constant LOSE_SEED =
        7290387335634266486249037663595860854047133815481999773725367799777733655939;
    bytes32 internal constant LOSE_COMMIT = 0x048605503187722f63911ca26b8cca1d0a2afc10509c8be7f963371fec52b188;

    function _claim(bytes32 commit, uint256 seed, uint8 fa, uint8 fb, uint8 result)
        internal
        pure
        returns (PaiGowRules.PaiGowClaim memory c)
    {
        c.commit = commit;
        c.seed = seed;
        c.frontA = fa;
        c.frontB = fb;
        c.claimedResult = result;
    }

    function test_commit_matchesTs() public pure {
        assertEq(PaiGowRules.commitLayout(WIN_SEED), WIN_COMMIT);
        assertEq(PaiGowRules.commitLayout(PUSH_SEED), PUSH_COMMIT);
        assertEq(PaiGowRules.commitLayout(LOSE_SEED), LOSE_COMMIT);
    }

    function test_win_matchesTs() public pure {
        (uint256 bP, uint256 bH) = PaiGowRules.settle(
            _claim(WIN_COMMIT, WIN_SEED, 0, 6, 2), STAKE, ESCROW_HOUSE
        );
        assertEq(bP, 400); // 2.00x
        assertEq(bH, 0);
        assertEq(bP + bH, STAKE + ESCROW_HOUSE);
    }

    function test_push_matchesTs() public pure {
        (uint256 bP, uint256 bH) = PaiGowRules.settle(
            _claim(PUSH_COMMIT, PUSH_SEED, 0, 4, 1), STAKE, ESCROW_HOUSE
        );
        assertEq(bP, 200); // stake back
        assertEq(bH, 200);
        assertEq(bP + bH, STAKE + ESCROW_HOUSE);
    }

    function test_lose_matchesTs() public pure {
        (uint256 bP, uint256 bH) = PaiGowRules.settle(
            _claim(LOSE_COMMIT, LOSE_SEED, 0, 4, 0), STAKE, ESCROW_HOUSE
        );
        assertEq(bP, 0);
        assertEq(bH, STAKE + ESCROW_HOUSE);
    }

    // A fouled player split (front 2 outranks back 5) loses outright. Same deal as the push vector, but
    // the player forces positions 2,5 into the front, which is an illegal arrangement.
    function test_foul_loses_matchesTs() public pure {
        (uint256 bP, uint256 bH) = PaiGowRules.settle(
            _claim(PUSH_COMMIT, PUSH_SEED, 2, 5, 0), STAKE, ESCROW_HOUSE
        );
        assertEq(bP, 0);
        assertEq(bH, STAKE + ESCROW_HOUSE);
    }

    // REJECT: a wrong seed no longer matches the deck commitment.
    function test_reject_forgedSeed() public {
        vm.expectRevert(PaiGowRules.CommitMismatch.selector);
        h.settle(_claim(WIN_COMMIT, WIN_SEED + 1, 0, 6, 2), STAKE, ESCROW_HOUSE);
    }

    // REJECT: claiming a win over a hand that actually pushes.
    function test_reject_wrongResult() public {
        vm.expectRevert(PaiGowRules.ResultMismatch.selector);
        h.settle(_claim(PUSH_COMMIT, PUSH_SEED, 0, 4, 2), STAKE, ESCROW_HOUSE);
    }

    // REJECT: an illegal front (two identical positions).
    function test_reject_badMove() public {
        vm.expectRevert(PaiGowRules.BadMove.selector);
        h.settle(_claim(WIN_COMMIT, WIN_SEED, 3, 3, 2), STAKE, ESCROW_HOUSE);
    }
}

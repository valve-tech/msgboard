// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HiLoWarRules} from "../../contracts/zk/HiLoWarRules.sol";
import {HiLo, HiLoCodec} from "./HiLoWarRules.t.sol";

/// @notice Deterministic gap-fill coverage for HiLoWarRules.sol, complementing the stateful/fuzz
/// suite in HiLoWarRules.t.sol (NOT modified here; this file only imports its HiLo struct /
/// HiLoCodec library to build states/moves).
///
/// Why a separate file: HiLoHandler's `_seat` helper only ever returns SEAT_A/SEAT_B, so no
/// WrongSeat guard is ever exercised by the invariant campaign; and because the handler resets to
/// a fresh deal immediately after a hand reaches FLIP_DONE, the top-of-function FLIP_DONE/SETTLED
/// guard is effectively never hit either. testFuzz_betCommitRoundTrip / testFuzz_showdownCardBounds
/// cover CommitMismatch and BadCard deterministically already, but only via seat A / via fuzzed
/// (not asserted-branch) inputs. This file closes those gaps explicitly: every revert site for
/// all six custom errors, the hi/lo/war showdown outcome branches (A wins / B wins / tie-into-war),
/// the seat-B commit-mismatch and raise arms the existing suite doesn't reach, and every whoseTurn
/// phase-mask branch.
contract HiLoWarRulesUnitTest is Test {
    HiLoWarRules internal rules;

    function setUp() public {
        rules = new HiLoWarRules(address(0xBEEF), address(0xCAFE));
    }

    // ---------------------------------------------------------------------
    // Global top-of-function guard (line: phase == FLIP_DONE || phase == SETTLED)
    // ---------------------------------------------------------------------

    function test_revert_globalGuard_flipDone() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_FLIP_DONE;
        vm.expectRevert(HiLoWarRules.WrongPhase.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.dealDone());
    }

    function test_revert_globalGuard_settled() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SETTLED;
        vm.expectRevert(HiLoWarRules.WrongPhase.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.dealDone());
    }

    // ---------------------------------------------------------------------
    // MOVE_DEAL_DONE
    // ---------------------------------------------------------------------

    function test_revert_dealDone_wrongPhase() public {
        HiLo memory s; // phase defaults to PHASE_SETUP (0) != PHASE_DEAL
        vm.expectRevert(HiLoWarRules.WrongPhase.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.dealDone());
    }

    // ---------------------------------------------------------------------
    // MOVE_BET_COMMIT
    // ---------------------------------------------------------------------

    function test_revert_betCommit_wrongPhase() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_DEAL;
        vm.expectRevert(HiLoWarRules.WrongPhase.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betCommit(HiLoCodec.SEAT_A, keccak256("x")));
    }

    function test_revert_betCommit_wrongSeat_zero() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        vm.expectRevert(HiLoWarRules.WrongSeat.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betCommit(0, keccak256("x")));
    }

    function test_revert_betCommit_wrongSeat_outOfRange() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        vm.expectRevert(HiLoWarRules.WrongSeat.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betCommit(3, keccak256("x")));
    }

    function test_revert_betCommit_alreadyMoved_seatA() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        s.commitA = keccak256("already");
        vm.expectRevert(HiLoWarRules.AlreadyMoved.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betCommit(HiLoCodec.SEAT_A, keccak256("new")));
    }

    function test_revert_betCommit_alreadyMoved_seatB() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        s.commitB = keccak256("already");
        vm.expectRevert(HiLoWarRules.AlreadyMoved.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betCommit(HiLoCodec.SEAT_B, keccak256("new")));
    }

    // ---------------------------------------------------------------------
    // MOVE_BET_OPEN
    // ---------------------------------------------------------------------

    function test_revert_betOpen_wrongPhase() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        vm.expectRevert(HiLoWarRules.WrongPhase.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betOpen(HiLoCodec.SEAT_A, HiLoCodec.BET_HOLD, keccak256("s")));
    }

    function test_revert_betOpen_wrongSeat() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        vm.expectRevert(HiLoWarRules.WrongSeat.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betOpen(0, HiLoCodec.BET_HOLD, keccak256("s")));
    }

    function test_revert_betOpen_illegalBetValue() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        vm.expectRevert(HiLoWarRules.IllegalMove.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betOpen(HiLoCodec.SEAT_A, 3, keccak256("s")));
    }

    /// testFuzz_betCommitRoundTrip in HiLoWarRules.t.sol only exercises the seat-A arm of
    /// `expected = by == SEAT_A ? commitA : commitB`. Cover the seat-B (false) arm here.
    function test_revert_betOpen_commitMismatch_seatB() public {
        bytes32 salt = keccak256("B-salt");
        bytes32 commitment = HiLoCodec.betCommitHash(HiLoCodec.BET_RAISE, salt);
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        s.commitB = commitment;
        bytes32 badSalt = bytes32(uint256(salt) ^ 1);
        vm.expectRevert(HiLoWarRules.CommitMismatch.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betOpen(HiLoCodec.SEAT_B, HiLoCodec.BET_RAISE, badSalt));
    }

    function test_revert_betOpen_alreadyMoved_seatA() public {
        bytes32 salt = keccak256("A-salt");
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        s.commitA = HiLoCodec.betCommitHash(HiLoCodec.BET_HOLD, salt);
        s.betA = HiLoCodec.BET_HOLD; // already opened
        vm.expectRevert(HiLoWarRules.AlreadyMoved.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betOpen(HiLoCodec.SEAT_A, HiLoCodec.BET_HOLD, salt));
    }

    function test_revert_betOpen_alreadyMoved_seatB() public {
        bytes32 salt = keccak256("B-salt2");
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        s.commitB = HiLoCodec.betCommitHash(HiLoCodec.BET_RAISE, salt);
        s.betB = HiLoCodec.BET_RAISE; // already opened
        vm.expectRevert(HiLoWarRules.AlreadyMoved.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.betOpen(HiLoCodec.SEAT_B, HiLoCodec.BET_RAISE, salt));
    }

    /// The raise-pot bookkeeping (`s.pot += s.ante; s.contributedB += s.ante`) and the
    /// `s.betA == BET_RAISE ? SEAT_A : SEAT_B` false arm (raiser = B) are only reachable when B is
    /// the one who raised; HiLoWarRules.t.sol's test_fullHandToFold only drives the A-raises case.
    function test_betOpen_raiseBySeatB_movesAnteIntoPotAndSetsRaiserB() public {
        bytes32 saltA = keccak256("holdA");
        bytes32 saltB = keccak256("raiseB");
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        s.ante = 1 ether;
        s.pot = 2 ether;
        s.contributedA = 1 ether;
        s.contributedB = 1 ether;
        s.commitA = HiLoCodec.betCommitHash(HiLoCodec.BET_HOLD, saltA);
        s.commitB = HiLoCodec.betCommitHash(HiLoCodec.BET_RAISE, saltB);

        bytes memory st = abi.encode(s);
        st = rules.applyMove(st, HiLoCodec.betOpen(HiLoCodec.SEAT_A, HiLoCodec.BET_HOLD, saltA));
        st = rules.applyMove(st, HiLoCodec.betOpen(HiLoCodec.SEAT_B, HiLoCodec.BET_RAISE, saltB));

        HiLo memory r = abi.decode(st, (HiLo));
        assertEq(r.pot, 3 ether, "B's raise ante moved into pot");
        assertEq(r.contributedB, 2 ether, "B's contribution grew by ante");
        assertEq(r.phase, HiLoCodec.PHASE_CALL_OR_FOLD, "mismatched opens -> call/fold");
        assertEq(r.raiser, HiLoCodec.SEAT_B, "B is the raiser");
    }

    // ---------------------------------------------------------------------
    // MOVE_CALL
    // ---------------------------------------------------------------------

    function test_revert_call_wrongPhase() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        vm.expectRevert(HiLoWarRules.WrongPhase.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.callMove(HiLoCodec.SEAT_A));
    }

    function test_revert_call_wrongSeat() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        s.raiser = HiLoCodec.SEAT_A;
        vm.expectRevert(HiLoWarRules.WrongSeat.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.callMove(7));
    }

    function test_revert_call_illegalMove_raiserCallsOwnRaise() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        s.raiser = HiLoCodec.SEAT_A;
        vm.expectRevert(HiLoWarRules.IllegalMove.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.callMove(HiLoCodec.SEAT_A));
    }

    function test_call_nonRaiser_movesToShowdownAndPaysAnte() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        s.ante = 1 ether;
        s.pot = 3 ether;
        s.contributedA = 2 ether;
        s.contributedB = 1 ether;
        s.raiser = HiLoCodec.SEAT_A;
        bytes memory out = rules.applyMove(abi.encode(s), HiLoCodec.callMove(HiLoCodec.SEAT_B));
        HiLo memory r = abi.decode(out, (HiLo));
        assertEq(r.phase, HiLoCodec.PHASE_SHOWDOWN, "call -> showdown");
        assertEq(r.pot, 4 ether, "caller's ante joins the pot");
        assertEq(r.contributedB, 2 ether, "caller's contribution grew by ante");
    }

    // ---------------------------------------------------------------------
    // MOVE_FOLD
    // ---------------------------------------------------------------------

    function test_revert_fold_wrongPhase() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        vm.expectRevert(HiLoWarRules.WrongPhase.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.fold(HiLoCodec.SEAT_A));
    }

    function test_revert_fold_wrongSeat() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        s.raiser = HiLoCodec.SEAT_B;
        vm.expectRevert(HiLoWarRules.WrongSeat.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.fold(9));
    }

    function test_revert_fold_illegalMove_raiserFoldsOwnRaise() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        s.raiser = HiLoCodec.SEAT_B;
        vm.expectRevert(HiLoWarRules.IllegalMove.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.fold(HiLoCodec.SEAT_B));
    }

    // ---------------------------------------------------------------------
    // MOVE_SHOWDOWN: phase guard, all three BadCard sub-conditions, and every
    // hi/lo/war outcome branch (A wins by rank, B wins by rank, tie carries to war).
    // ---------------------------------------------------------------------

    function test_revert_showdown_wrongPhase() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        vm.expectRevert(HiLoWarRules.WrongPhase.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.showdown(10, 20));
    }

    function test_revert_showdown_badCard_cardAOutOfRange() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SHOWDOWN;
        vm.expectRevert(HiLoWarRules.BadCard.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.showdown(52, 0));
    }

    function test_revert_showdown_badCard_cardBOutOfRange() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SHOWDOWN;
        vm.expectRevert(HiLoWarRules.BadCard.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.showdown(0, 52));
    }

    function test_revert_showdown_badCard_equalCards() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SHOWDOWN;
        vm.expectRevert(HiLoWarRules.BadCard.selector);
        rules.applyMove(abi.encode(s), HiLoCodec.showdown(17, 17));
    }

    function test_showdown_seatAWinsByRank() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SHOWDOWN;
        s.pot = 2 ether;
        s.contributedA = 1 ether;
        s.contributedB = 1 ether;
        // rank = card / 4; 40/4=10 > 4/4=1
        bytes memory out = rules.applyMove(abi.encode(s), HiLoCodec.showdown(40, 4));
        HiLo memory r = abi.decode(out, (HiLo));
        assertEq(r.resultWinner, HiLoCodec.SEAT_A, "higher rank A wins");
        assertTrue(r.resultSet, "decisive sets result");
        assertEq(r.resultAmount, 2 ether, "winner takes pot");
        assertEq(r.phase, HiLoCodec.PHASE_FLIP_DONE);
    }

    function test_showdown_seatBWinsByRank() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SHOWDOWN;
        s.pot = 2 ether;
        s.contributedA = 1 ether;
        s.contributedB = 1 ether;
        bytes memory out = rules.applyMove(abi.encode(s), HiLoCodec.showdown(4, 40));
        HiLo memory r = abi.decode(out, (HiLo));
        assertEq(r.resultWinner, HiLoCodec.SEAT_B, "higher rank B wins");
        assertTrue(r.resultSet, "decisive sets result");
        assertEq(r.resultAmount, 2 ether, "winner takes pot");
    }

    function test_showdown_tieCarriesPotIntoExistingWarPot() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SHOWDOWN;
        s.pot = 2 ether;
        s.warPot = 1 ether; // pre-existing war carry from an earlier tie
        s.contributedA = 1.5 ether;
        s.contributedB = 1.5 ether;
        // 0 and 1 are distinct cards, same rank (0/4 == 1/4 == 0)
        bytes memory out = rules.applyMove(abi.encode(s), HiLoCodec.showdown(0, 1));
        HiLo memory r = abi.decode(out, (HiLo));
        assertFalse(r.resultSet, "tie sets no result");
        assertEq(r.resultWinner, 0, "tie has no winner");
        assertEq(r.warPot, 3 ether, "pot folds into the existing warPot");
        assertEq(r.pot, 0, "tie clears pot");
        assertEq(r.phase, HiLoCodec.PHASE_FLIP_DONE);
    }

    // ---------------------------------------------------------------------
    // Unknown move kind -> the catch-all IllegalMove (distinct call site from the bet/call/fold
    // IllegalMove reverts above).
    // ---------------------------------------------------------------------

    function test_revert_unknownMoveKind() public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_DEAL;
        vm.expectRevert(HiLoWarRules.IllegalMove.selector);
        rules.applyMove(abi.encode(s), abi.encode(uint8(99), bytes("")));
    }

    // ---------------------------------------------------------------------
    // whoseTurn: every phase branch. HiLoWarRules.t.sol's testFuzz_whoseTurnMaskBounds only fuzzes
    // arbitrary bytes (almost always failing to decode), so none of these branches are pinned there.
    // ---------------------------------------------------------------------

    function test_whoseTurn_settled() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SETTLED;
        assertEq(rules.whoseTurn(abi.encode(s)), 0);
    }

    function test_whoseTurn_betCommit_bothOwe() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        assertEq(rules.whoseTurn(abi.encode(s)), 3);
    }

    function test_whoseTurn_betCommit_onlyAOwes() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        s.commitB = keccak256("b");
        assertEq(rules.whoseTurn(abi.encode(s)), 1);
    }

    function test_whoseTurn_betCommit_onlyBOwes() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        s.commitA = keccak256("a");
        assertEq(rules.whoseTurn(abi.encode(s)), 2);
    }

    function test_whoseTurn_betCommit_neitherOwes() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_COMMIT;
        s.commitA = keccak256("a");
        s.commitB = keccak256("b");
        assertEq(rules.whoseTurn(abi.encode(s)), 0);
    }

    function test_whoseTurn_betOpen_bothOwe() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        assertEq(rules.whoseTurn(abi.encode(s)), 3);
    }

    function test_whoseTurn_betOpen_onlyAOwes() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        s.betB = HiLoCodec.BET_HOLD;
        assertEq(rules.whoseTurn(abi.encode(s)), 1);
    }

    function test_whoseTurn_betOpen_onlyBOwes() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        s.betA = HiLoCodec.BET_HOLD;
        assertEq(rules.whoseTurn(abi.encode(s)), 2);
    }

    function test_whoseTurn_betOpen_neitherOwes() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        s.betA = HiLoCodec.BET_HOLD;
        s.betB = HiLoCodec.BET_RAISE;
        assertEq(rules.whoseTurn(abi.encode(s)), 0);
    }

    function test_whoseTurn_callOrFold_raiserA() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        s.raiser = HiLoCodec.SEAT_A;
        assertEq(rules.whoseTurn(abi.encode(s)), 2, "non-raiser B owes");
    }

    function test_whoseTurn_callOrFold_raiserB() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        s.raiser = HiLoCodec.SEAT_B;
        assertEq(rules.whoseTurn(abi.encode(s)), 1, "non-raiser A owes");
    }

    function test_whoseTurn_defaultPhases_bothOwe() public view {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_DEAL;
        assertEq(rules.whoseTurn(abi.encode(s)), 3);

        s.phase = HiLoCodec.PHASE_SETUP;
        assertEq(rules.whoseTurn(abi.encode(s)), 3);

        s.phase = HiLoCodec.PHASE_SHOWDOWN;
        assertEq(rules.whoseTurn(abi.encode(s)), 3);

        s.phase = HiLoCodec.PHASE_FLIP_DONE;
        assertEq(rules.whoseTurn(abi.encode(s)), 3);
    }

    // ---------------------------------------------------------------------
    // Trivial pure/view accessors — included for completeness.
    // ---------------------------------------------------------------------

    function test_isFinal() public view {
        assertTrue(rules.isFinal(HiLoCodec.PHASE_SETTLED));
        assertFalse(rules.isFinal(HiLoCodec.PHASE_FLIP_DONE));
    }

    function test_gameIdAndVerifiers() public view {
        assertEq(rules.gameId(), 1);
        assertEq(rules.revealVerifier(), address(0xBEEF));
        assertEq(rules.revealVerifierAddr(), address(0xBEEF));
        assertEq(rules.shuffleVerifierAddr(), address(0xCAFE));
    }

    function test_hashGameState() public view {
        bytes memory blob = "hello";
        assertEq(rules.hashGameState(blob), keccak256(blob));
    }
}

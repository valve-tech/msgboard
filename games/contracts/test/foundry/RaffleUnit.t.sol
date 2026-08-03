// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Raffle} from "../../contracts/Raffle.sol";
import {GameBase} from "../../contracts/GameBase.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

/// @notice Coverage-focused unit suite for Raffle.sol: every external/public function, all 15
/// custom errors, and the full state machine including illegal transitions, the threshold/period/
/// reveal-window boundaries, and both refund paths (per-ticket cancel while Filling, per-ticket
/// refundTicket while Drawing via chop or staleness). Complements Raffle.t.sol's fuzz-oracle tests
/// and RaffleInvariant.t.sol's accounting invariants — this file is deliberately exhaustive rather
/// than randomized, so each branch of each `if` is hit by name.
///
/// Two branches are deliberately NOT exercised here because they are unreachable through the public
/// API (see the bottom of this file for the full explanation):
///   1. `commit`'s round-open condition can be true either because `activeRound[tupleHash] == 0` or
///      because the pointed-to round's status isn't Filling — but the only way out of Filling is
///      `arm`, which always clears the mapping first, so the second disjunct never fires on a live
///      mapping entry. (Coverage-wise this doesn't matter: the two-outcome `if` itself gets both
///      true and false from other tests.)
///   2. `arm`'s `if (activeRound[tupleHash] == roundId)` guard's FALSE arm: the mapping is written
///      exactly once (at round creation, to this round's own id) and never touched again while the
///      round stays Filling, so at arm-time it is always still equal. This one genuinely leaves a
///      single-sided branch (see contract RaffleUnreachableBranchNotes below).
contract RaffleUnitTest is Test {
    Raffle internal raffle;
    MockRandom internal rnd;
    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    uint256 internal constant STAKE = 1 ether;
    uint256 internal constant THRESHOLD = 3;
    uint256 internal constant PERIOD = 5;

    address internal constant P1 = address(0xB1);
    address internal constant P2 = address(0xB2);
    address internal constant P3 = address(0xB3);
    address internal constant P4 = address(0xB4); // never a ticket owner — used for NotTicketOwner

    function setUp() public {
        rnd = new MockRandom();
        raffle = new Raffle(address(rnd)); // this test contract is owner + default feeRecipient
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x3000 + i));
            raffle.addValidator(v);
            subset.push(v);
            locs.push(PreimageLocation.Info({
                provider: v, callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(0), price: 0, offset: 0, index: 0
            }));
        }
        vm.deal(P1, 1000 ether);
        vm.deal(P2, 1000 ether);
        vm.deal(P3, 1000 ether);
        vm.deal(P4, 1000 ether);
    }

    // ---------------------------------------------------------------- view helpers ----

    struct RoundView {
        uint256 stake;
        uint256 threshold;
        uint256 period;
        bytes32 subsetHash;
        uint256 createdAtBlock;
        uint256 commitCount;
        uint256 pot;
        Raffle.Status status;
        bytes32 key;
        uint256 armedAtBlock;
        uint256 draw;
        uint256 claimDeadline;
        uint256 bestTicket;
        uint256 bestDistance;
        uint256 settledPot;
    }

    // Split into two half-width destructures (each discarding the other half via blanks) — a
    // single 15-value tuple assigned straight into a 15-field memory struct hits "stack too deep"
    // under the coverage build's --ir-minimum (no optimizer) pipeline.
    function _round(bytes32 roundId) internal view returns (RoundView memory rv) {
        (rv.stake, rv.threshold, rv.period, rv.subsetHash, rv.createdAtBlock, rv.commitCount, rv.pot, rv.status,,,,,,,) =
            raffle.rounds(roundId);
        (,,,,,,,, rv.key, rv.armedAtBlock, rv.draw, rv.claimDeadline, rv.bestTicket, rv.bestDistance, rv.settledPot) =
            raffle.rounds(roundId);
    }

    struct TicketView {
        bytes32 roundId;
        address player;
        bytes32 commitment;
        uint256 committedAtBlock;
        bool active;
        bool revealed;
    }

    function _ticket(uint256 ticketId) internal view returns (TicketView memory tv) {
        (tv.roundId, tv.player, tv.commitment, tv.committedAtBlock, tv.active, tv.revealed) =
            raffle.tickets(ticketId);
    }

    function _commitment(uint256 guess, bytes32 salt, address player) internal pure returns (bytes32) {
        return keccak256(abi.encode(guess, salt, player));
    }

    function _tuple(uint256 threshold) internal view returns (bytes32) {
        return keccak256(abi.encode(STAKE, threshold, PERIOD, keccak256(abi.encode(subset))));
    }

    /// @dev Commits `who` into the round for `threshold` at STAKE/PERIOD, returning the ticket and
    /// the (possibly freshly-opened) round id.
    function _commitAs(address who, uint256 threshold, uint256 guess, bytes32 salt)
        internal
        returns (uint256 ticketId, bytes32 roundId)
    {
        vm.prank(who);
        ticketId = raffle.commit{value: STAKE}(
            STAKE, threshold, PERIOD, subset, _commitment(guess, salt, who)
        );
        roundId = raffle.activeRound(_tuple(threshold));
    }

    /// @dev Rolls to the exact period boundary (if not already past it) and arms.
    function _armAtBoundary(bytes32 roundId) internal {
        RoundView memory rv = _round(roundId);
        if (block.number < rv.createdAtBlock + rv.period) {
            vm.roll(rv.createdAtBlock + rv.period);
        }
        raffle.arm(roundId, locs);
    }

    /// @dev Drives a finalized seed such that round.draw == drawValue exactly (drawValue in [1,256]).
    function _drawAt(bytes32 roundId, uint256 drawValue) internal {
        bytes32 key = _round(roundId).key;
        rnd.pushCast(address(raffle), key, bytes32(drawValue - 1));
    }

    function _armAndDraw(bytes32 roundId, uint256 drawValue) internal {
        _armAtBoundary(roundId);
        _drawAt(roundId, drawValue);
    }

    // =========================================================================================
    // constructor
    // =========================================================================================

    function test_constructor_setsOwnerAndFeeRecipientToDeployer() public view {
        assertEq(raffle.owner(), address(this), "owner is deployer");
        assertEq(raffle.feeRecipient(), address(this), "feeRecipient defaults to deployer");
        assertEq(raffle.feeBips(), 0, "feeBips defaults to zero");
    }

    // =========================================================================================
    // setFee
    // =========================================================================================

    function test_setFee_success() public {
        raffle.setFee(500, address(0xFEE1));
        assertEq(raffle.feeBips(), 500);
        assertEq(raffle.feeRecipient(), address(0xFEE1));
    }

    function test_setFee_allowsExactlyBips() public {
        raffle.setFee(10_000, address(0xFEE2)); // boundary: == BIPS is allowed
        assertEq(raffle.feeBips(), 10_000);
    }

    function test_setFee_revertsBadFee_whenExceedsBips() public {
        vm.expectRevert(Raffle.BadFee.selector);
        raffle.setFee(10_001, address(this)); // boundary: BIPS + 1 reverts
    }

    function test_setFee_revertsOnlyOwner_whenNotOwner() public {
        vm.prank(P1);
        vm.expectRevert(GameBase.OnlyOwner.selector);
        raffle.setFee(100, P1);
    }

    // =========================================================================================
    // commit
    // =========================================================================================

    function test_commit_revertsBadParams_zeroStake() public {
        vm.expectRevert(Raffle.BadParams.selector);
        raffle.commit{value: 0}(0, THRESHOLD, PERIOD, subset, bytes32(0));
    }

    function test_commit_revertsBadParams_zeroThreshold() public {
        vm.expectRevert(Raffle.BadParams.selector);
        raffle.commit{value: 0}(STAKE, 0, PERIOD, subset, bytes32(0));
    }

    function test_commit_revertsBadParams_zeroPeriod() public {
        vm.expectRevert(Raffle.BadParams.selector);
        raffle.commit{value: 0}(STAKE, THRESHOLD, 0, subset, bytes32(0));
    }

    function test_commit_revertsStakeMismatch_whenValueWrong() public {
        vm.expectRevert(GameBase.StakeMismatch.selector);
        raffle.commit{value: STAKE - 1}(STAKE, THRESHOLD, PERIOD, subset, bytes32(0));
    }

    function test_commit_revertsBadSubset_tooFewValidators() public {
        address[] memory tooFew = new address[](2);
        tooFew[0] = subset[0];
        tooFew[1] = subset[1];
        vm.expectRevert(GameBase.BadSubset.selector);
        raffle.commit{value: STAKE}(STAKE, THRESHOLD, PERIOD, tooFew, bytes32(0));
    }

    function test_commit_revertsBadSubset_duplicateValidator() public {
        address[] memory dup = new address[](3);
        dup[0] = subset[0];
        dup[1] = subset[1];
        dup[2] = subset[0];
        vm.expectRevert(GameBase.BadSubset.selector);
        raffle.commit{value: STAKE}(STAKE, THRESHOLD, PERIOD, dup, bytes32(0));
    }

    function test_commit_revertsNotAllowlisted() public {
        address[] memory notAllowed = new address[](3);
        notAllowed[0] = subset[0];
        notAllowed[1] = subset[1];
        notAllowed[2] = address(0x9999);
        vm.expectRevert(GameBase.NotAllowlisted.selector);
        raffle.commit{value: STAKE}(STAKE, THRESHOLD, PERIOD, notAllowed, bytes32(0));
    }

    function test_commit_opensNewRound_whenNoneActive() public {
        (uint256 ticketId, bytes32 roundId) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1)));
        assertTrue(roundId != bytes32(0), "round opened");
        assertEq(ticketId, 1);
        RoundView memory rv = _round(roundId);
        assertEq(uint8(rv.status), uint8(Raffle.Status.Filling));
        assertEq(rv.commitCount, 1);
        assertEq(rv.pot, STAKE);
    }

    function test_commit_joinsExistingFillingRound() public {
        (uint256 t1, bytes32 r1) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1)));
        (uint256 t2, bytes32 r2) = _commitAs(P2, THRESHOLD, 20, bytes32(uint256(2)));
        assertEq(r1, r2, "second commit joins the same round");
        assertEq(t2, t1 + 1);
        RoundView memory rv = _round(r1);
        assertEq(rv.commitCount, 2);
        assertEq(rv.pot, 2 * STAKE);
    }

    function test_commit_opensFreshRound_afterPreviousArmed() public {
        (, bytes32 roundA) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundA); // clears activeRound[tuple(1)]

        (uint256 t2, bytes32 roundB) = _commitAs(P1, 1, 20, bytes32(uint256(2)));
        assertTrue(roundB != roundA, "fresh round id after prior round armed");
        assertEq(t2, 2);
        assertEq(uint8(_round(roundB).status), uint8(Raffle.Status.Filling));
    }

    // =========================================================================================
    // cancel
    // =========================================================================================

    function test_cancel_revertsNotTicketOwner() public {
        (uint256 t1,) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1)));
        vm.prank(P4);
        vm.expectRevert(Raffle.NotTicketOwner.selector);
        raffle.cancel(t1);
    }

    function test_cancel_revertsTicketInactive_whenAlreadyCancelled() public {
        (uint256 t1,) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1)));
        vm.prank(P1);
        raffle.cancel(t1);
        vm.prank(P1);
        vm.expectRevert(Raffle.TicketInactive.selector);
        raffle.cancel(t1);
    }

    function test_cancel_revertsWrongRoundState_whenArmed() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        vm.prank(P1);
        vm.expectRevert(Raffle.WrongRoundState.selector);
        raffle.cancel(t1);
    }

    function test_cancel_success_refundsAndUpdatesRound() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1)));
        uint256 balBefore = P1.balance;
        vm.prank(P1);
        raffle.cancel(t1);
        assertEq(P1.balance, balBefore + STAKE, "stake refunded");
        RoundView memory rv = _round(roundId);
        assertEq(rv.commitCount, 0);
        assertEq(rv.pot, 0);
        assertFalse(_ticket(t1).active);
    }

    // =========================================================================================
    // roundSubset
    // =========================================================================================

    function test_roundSubset_returnsDeclaredSubset() public {
        (, bytes32 roundId) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1)));
        address[] memory got = raffle.roundSubset(roundId);
        assertEq(got.length, subset.length);
        for (uint256 i = 0; i < subset.length; i++) {
            assertEq(got[i], subset[i]);
        }
    }

    // =========================================================================================
    // arm
    // =========================================================================================

    function test_arm_revertsNotFilling_whenNoRoundExists() public {
        vm.expectRevert(Raffle.NotFilling.selector);
        raffle.arm(bytes32(uint256(0xDEAD)), locs);
    }

    function test_arm_revertsNotFilling_whenAlreadyArmed() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        vm.expectRevert(Raffle.NotFilling.selector);
        raffle.arm(roundId, locs);
    }

    function test_arm_periodBoundary_revertsThenSucceeds() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        RoundView memory rv = _round(roundId);

        // one block short of the boundary: still reverts
        vm.roll(rv.createdAtBlock + rv.period - 1);
        vm.expectRevert(Raffle.PeriodNotElapsed.selector);
        raffle.arm(roundId, locs);

        // exactly at the boundary: succeeds
        vm.roll(rv.createdAtBlock + rv.period);
        raffle.arm(roundId, locs);
        assertEq(uint8(_round(roundId).status), uint8(Raffle.Status.Drawing));
    }

    function test_arm_thresholdBoundary_revertsThenSucceeds() public {
        (, bytes32 roundId) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1)));
        _commitAs(P2, THRESHOLD, 20, bytes32(uint256(2))); // commitCount == 2 < THRESHOLD(3)
        vm.roll(_round(roundId).createdAtBlock + PERIOD);

        vm.expectRevert(Raffle.ThresholdNotMet.selector);
        raffle.arm(roundId, locs);

        _commitAs(P3, THRESHOLD, 30, bytes32(uint256(3))); // commitCount == 3 == THRESHOLD
        raffle.arm(roundId, locs); // period already elapsed, threshold now met
        assertEq(uint8(_round(roundId).status), uint8(Raffle.Status.Drawing));
    }

    function test_arm_success_setsStateAndClearsActiveRound() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        uint256 potBefore = _round(roundId).pot;
        _armAtBoundary(roundId);

        RoundView memory rv = _round(roundId);
        assertEq(uint8(rv.status), uint8(Raffle.Status.Drawing));
        assertEq(rv.armedAtBlock, block.number);
        assertEq(rv.settledPot, potBefore);
        assertTrue(rv.key != bytes32(0));
        assertEq(raffle.instanceByKey(rv.key), roundId);
        assertEq(raffle.activeRound(_tuple(1)), bytes32(0), "mapping cleared on arm");
    }

    // =========================================================================================
    // recordDraw / _settle
    // =========================================================================================

    function test_recordDraw_revertsWrongRoundState_whenFilling() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        vm.expectRevert(Raffle.WrongRoundState.selector);
        raffle.recordDraw(roundId);
    }

    function test_recordDraw_revertsTooEarly_whenSeedMissing() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        vm.expectRevert(Raffle.TooEarly.selector);
        raffle.recordDraw(roundId);
    }

    function test_recordDraw_success_pullPath() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        bytes32 key = _round(roundId).key;
        rnd.setSeed(key, bytes32(uint256(127))); // seed present, but push not delivered
        raffle.recordDraw(roundId);

        RoundView memory rv = _round(roundId);
        assertEq(uint8(rv.status), uint8(Raffle.Status.Claiming));
        assertEq(rv.draw, 128);
        assertEq(rv.claimDeadline, block.number + raffle.CLAIM_BLOCKS());
    }

    function test_onCast_pushPath_success() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        RoundView memory rv = _round(roundId);
        assertEq(uint8(rv.status), uint8(Raffle.Status.Claiming));
        assertEq(rv.draw, 128);
    }

    function test_settle_revertsWrongRoundState_onDoublePush() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAndDraw(roundId, 128); // first push succeeds, status -> Claiming
        bytes32 key = _round(roundId).key;
        vm.expectRevert(Raffle.WrongRoundState.selector);
        rnd.pushCast(address(raffle), key, bytes32(uint256(200))); // second push hits _settle's own guard
    }

    // =========================================================================================
    // reveal
    // =========================================================================================

    function test_reveal_revertsWrongRoundState_whenNotClaiming() public {
        (uint256 t1,) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        vm.expectRevert(Raffle.WrongRoundState.selector);
        raffle.reveal(t1, 10, bytes32(uint256(1)));
    }

    function test_reveal_windowBoundary_succeedsThenReverts() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 2, 10, bytes32(uint256(1)));
        (uint256 t2,) = _commitAs(P2, 2, 20, bytes32(uint256(2)));
        _armAndDraw(roundId, 128);
        uint256 deadline = _round(roundId).claimDeadline;

        vm.roll(deadline); // exactly at the boundary: `>` means this is still open
        vm.prank(P1);
        raffle.reveal(t1, 10, bytes32(uint256(1)));
        assertTrue(_ticket(t1).revealed);

        vm.roll(deadline + 1); // one block past: closed
        vm.prank(P2);
        vm.expectRevert(Raffle.WindowClosed.selector);
        raffle.reveal(t2, 20, bytes32(uint256(2)));
    }

    function test_reveal_revertsTicketInactive_afterStaleRefundThenLateDraw() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 100, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        vm.roll(_round(roundId).armedAtBlock + raffle.STALE_BLOCKS());
        vm.prank(P1);
        raffle.refundTicket(t1); // stale refund while still Drawing
        assertFalse(_ticket(t1).active);

        _drawAt(roundId, 128); // the seed still finalizes late, moving the round to Claiming
        assertEq(uint8(_round(roundId).status), uint8(Raffle.Status.Claiming));

        vm.prank(P1);
        vm.expectRevert(Raffle.TicketInactive.selector);
        raffle.reveal(t1, 100, bytes32(uint256(1)));
    }

    function test_reveal_revertsAlreadyRevealed() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        raffle.reveal(t1, 10, bytes32(uint256(1)));
        vm.prank(P1);
        vm.expectRevert(Raffle.AlreadyRevealed.selector);
        raffle.reveal(t1, 10, bytes32(uint256(1)));
    }

    function test_reveal_revertsGuessOutOfRange_zero() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 50, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        vm.expectRevert(Raffle.GuessOutOfRange.selector);
        raffle.reveal(t1, 0, bytes32(uint256(1)));
    }

    function test_reveal_revertsGuessOutOfRange_tooHigh() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 50, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        vm.expectRevert(Raffle.GuessOutOfRange.selector);
        raffle.reveal(t1, 257, bytes32(uint256(1)));
    }

    function test_reveal_acceptsGuessAtLowerBound() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 1, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        raffle.reveal(t1, 1, bytes32(uint256(1)));
        assertTrue(_ticket(t1).revealed);
        assertEq(_round(roundId).bestTicket, t1);
    }

    function test_reveal_acceptsGuessAtUpperBound() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 256, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        raffle.reveal(t1, 256, bytes32(uint256(1)));
        assertTrue(_ticket(t1).revealed);
        assertEq(_round(roundId).bestTicket, t1);
    }

    function test_reveal_revertsBadReveal_wrongGuess() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 50, bytes32(uint256(9)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        vm.expectRevert(Raffle.BadReveal.selector);
        raffle.reveal(t1, 51, bytes32(uint256(9)));
    }

    function test_reveal_revertsBadReveal_wrongSalt() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 50, bytes32(uint256(9)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        vm.expectRevert(Raffle.BadReveal.selector);
        raffle.reveal(t1, 50, bytes32(uint256(999)));
    }

    function test_reveal_revertsBadReveal_wrongSender() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 50, bytes32(uint256(9)));
        _armAndDraw(roundId, 128);
        vm.prank(P2); // the commitment is bound to P1's address, not P2's
        vm.expectRevert(Raffle.BadReveal.selector);
        raffle.reveal(t1, 50, bytes32(uint256(9)));
    }

    /// distance(50)=78 revealed first (bestTicket==0 -> leading), then distance(110)=18 overwrites
    /// it because it is strictly closer.
    function test_reveal_leading_closerGuessBecomesBest() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, THRESHOLD, 50, bytes32(uint256(1)));
        (uint256 t2,) = _commitAs(P2, THRESHOLD, 110, bytes32(uint256(2)));
        _commitAs(P3, THRESHOLD, 200, bytes32(uint256(3))); // only to satisfy threshold
        _armAndDraw(roundId, 128);

        vm.prank(P1);
        raffle.reveal(t1, 50, bytes32(uint256(1)));
        assertEq(_round(roundId).bestTicket, t1);

        vm.prank(P2);
        raffle.reveal(t2, 110, bytes32(uint256(2)));
        RoundView memory rv = _round(roundId);
        assertEq(rv.bestTicket, t2, "strictly closer guess overwrites");
        assertEq(rv.bestDistance, 18);
    }

    /// Two tickets tie in distance (118 and 138, both distance 10 from draw 128) but committed in
    /// different blocks; the earlier-committed ticket wins the tie regardless of reveal order. A
    /// third, much-farther guess revealed last must NOT overwrite the tied winner.
    function test_reveal_leading_tieEarlierCommitBlockWinsThenFartherGuessLoses() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, THRESHOLD, 118, bytes32(uint256(1)));
        vm.roll(block.number + 2);
        (uint256 t2,) = _commitAs(P2, THRESHOLD, 138, bytes32(uint256(2)));
        (uint256 t3,) = _commitAs(P3, THRESHOLD, 1, bytes32(uint256(3)));
        _armAndDraw(roundId, 128);

        vm.prank(P2);
        raffle.reveal(t2, 138, bytes32(uint256(2))); // first reveal -> leading trivially
        assertEq(_round(roundId).bestTicket, t2);

        vm.prank(P1);
        raffle.reveal(t1, 118, bytes32(uint256(1))); // tie distance, earlier commit block -> wins
        assertEq(_round(roundId).bestTicket, t1);

        vm.prank(P3);
        raffle.reveal(t3, 1, bytes32(uint256(3))); // distance 127 > 10 -> must not overwrite
        RoundView memory rv = _round(roundId);
        assertEq(rv.bestTicket, t1);
        assertEq(rv.bestDistance, 10);
    }

    /// Two tickets committed in the SAME block tie in distance; the lower ticket id wins the tie
    /// even when revealed after the higher id.
    function test_reveal_leading_tieSameBlockLowerTicketWins() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, THRESHOLD, 118, bytes32(uint256(1)));
        (uint256 t2,) = _commitAs(P2, THRESHOLD, 138, bytes32(uint256(2))); // same block as t1
        _commitAs(P3, THRESHOLD, 1, bytes32(uint256(3)));
        _armAndDraw(roundId, 128);

        vm.prank(P2);
        raffle.reveal(t2, 138, bytes32(uint256(2)));
        assertEq(_round(roundId).bestTicket, t2);

        vm.prank(P1);
        raffle.reveal(t1, 118, bytes32(uint256(1))); // same block, lower id -> wins the tie
        assertEq(_round(roundId).bestTicket, t1);
    }

    /// Same setup, opposite reveal order: the higher ticket id must NOT win a same-block tie.
    function test_reveal_notLeading_tieSameBlockHigherTicketLoses() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, THRESHOLD, 118, bytes32(uint256(1)));
        (uint256 t2,) = _commitAs(P2, THRESHOLD, 138, bytes32(uint256(2))); // same block as t1
        _commitAs(P3, THRESHOLD, 1, bytes32(uint256(3)));
        _armAndDraw(roundId, 128);

        vm.prank(P1);
        raffle.reveal(t1, 118, bytes32(uint256(1)));
        assertEq(_round(roundId).bestTicket, t1);

        vm.prank(P2);
        raffle.reveal(t2, 138, bytes32(uint256(2))); // same block, higher id -> must not overwrite
        assertEq(_round(roundId).bestTicket, t1, "higher ticket id does not win a same-block tie");
    }

    // =========================================================================================
    // finalise
    // =========================================================================================

    function test_finalise_revertsWrongRoundState_whenDrawing() public {
        (, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        vm.expectRevert(Raffle.WrongRoundState.selector);
        raffle.finalise(roundId);
    }

    function test_finalise_windowBoundary_revertsThenSucceeds() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        raffle.reveal(t1, 10, bytes32(uint256(1)));
        uint256 deadline = _round(roundId).claimDeadline;

        vm.roll(deadline); // `<=` means exactly-at-deadline is still open
        vm.expectRevert(Raffle.WindowOpen.selector);
        raffle.finalise(roundId);

        vm.roll(deadline + 1);
        raffle.finalise(roundId); // succeeds one block later
        assertEq(uint8(_round(roundId).status), uint8(Raffle.Status.Paid));
    }

    function test_finalise_noContest_evenSplit() public {
        (, bytes32 roundId) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1)));
        _commitAs(P2, THRESHOLD, 20, bytes32(uint256(2)));
        _commitAs(P3, THRESHOLD, 30, bytes32(uint256(3)));
        _armAndDraw(roundId, 128);
        // nobody reveals
        vm.roll(_round(roundId).claimDeadline + 1);

        uint256[] memory before = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) before[i] = subset[i].balance;

        raffle.finalise(roundId);

        uint256 pot = 3 * STAKE;
        uint256 share = pot / 3; // divides evenly: 1 ether each
        for (uint256 i = 0; i < 3; i++) {
            assertEq(subset[i].balance, before[i] + share);
        }
        assertEq(uint8(_round(roundId).status), uint8(Raffle.Status.Paid));
    }

    function test_finalise_noContest_unevenSplitRemainderToLast() public {
        // threshold=2 with 3 validators in the subset: pot = 2 ether does not divide evenly by 3.
        (, bytes32 roundId) = _commitAs(P1, 2, 10, bytes32(uint256(1)));
        _commitAs(P2, 2, 20, bytes32(uint256(2)));
        _armAndDraw(roundId, 128);
        vm.roll(_round(roundId).claimDeadline + 1);

        uint256[] memory before = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) before[i] = subset[i].balance;

        raffle.finalise(roundId);

        uint256 pot = 2 * STAKE;
        uint256 share = pot / 3;
        assertEq(subset[0].balance, before[0] + share);
        assertEq(subset[1].balance, before[1] + share);
        assertEq(subset[2].balance, before[2] + (pot - share * 2), "last validator absorbs remainder");
    }

    function test_finalise_normalPayout_feeZero() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        raffle.reveal(t1, 10, bytes32(uint256(1)));
        vm.roll(_round(roundId).claimDeadline + 1);

        uint256 balBefore = P1.balance;
        uint256 feeRecipientBefore = raffle.feeRecipient().balance;
        raffle.finalise(roundId);

        assertEq(P1.balance, balBefore + STAKE, "winner gets the full pot when fee is zero");
        assertEq(raffle.feeRecipient().balance, feeRecipientBefore, "no fee paid out");
    }

    function test_finalise_normalPayout_feeNonZero() public {
        raffle.setFee(1000, address(0xFEE3)); // 10%
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        raffle.reveal(t1, 10, bytes32(uint256(1)));
        vm.roll(_round(roundId).claimDeadline + 1);

        uint256 balBefore = P1.balance;
        uint256 feeBefore = address(0xFEE3).balance;
        raffle.finalise(roundId);

        uint256 fee = STAKE * 1000 / 10_000;
        assertEq(P1.balance, balBefore + (STAKE - fee), "winner gets pot minus fee");
        assertEq(address(0xFEE3).balance, feeBefore + fee, "fee recipient gets the fee");
    }

    // =========================================================================================
    // refundTicket
    // =========================================================================================

    function test_refundTicket_revertsNotTicketOwner() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        vm.prank(P4);
        vm.expectRevert(Raffle.NotTicketOwner.selector);
        raffle.refundTicket(t1);
    }

    function test_refundTicket_revertsTicketInactive() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        vm.roll(_round(roundId).armedAtBlock + raffle.STALE_BLOCKS());
        vm.prank(P1);
        raffle.refundTicket(t1);
        vm.prank(P1);
        vm.expectRevert(Raffle.TicketInactive.selector);
        raffle.refundTicket(t1);
    }

    function test_refundTicket_revertsWrongRoundState_whenFilling() public {
        (uint256 t1,) = _commitAs(P1, THRESHOLD, 10, bytes32(uint256(1))); // threshold not met, still Filling
        vm.prank(P1);
        vm.expectRevert(Raffle.WrongRoundState.selector);
        raffle.refundTicket(t1);
    }

    function test_refundTicket_revertsWrongRoundState_whenClaiming() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAndDraw(roundId, 128);
        vm.prank(P1);
        vm.expectRevert(Raffle.WrongRoundState.selector);
        raffle.refundTicket(t1);
    }

    function test_refundTicket_revertsTooEarly_whenSeedAlreadySet() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        bytes32 key = _round(roundId).key;
        rnd.setSeed(key, bytes32(uint256(5))); // seed present but round not yet advanced
        vm.prank(P1);
        vm.expectRevert(Raffle.TooEarly.selector);
        raffle.refundTicket(t1);
    }

    function test_refundTicket_revertsTooEarly_whenNeitherChoppedNorStale() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        vm.prank(P1);
        vm.expectRevert(Raffle.TooEarly.selector);
        raffle.refundTicket(t1);
    }

    function test_refundTicket_success_choppedPath() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        bytes32 key = _round(roundId).key;
        rnd.pushChop(address(raffle), key); // liveness failure, well before the stale window
        assertTrue(raffle.choppedInstance(roundId));

        uint256 balBefore = P1.balance;
        vm.prank(P1);
        raffle.refundTicket(t1);
        assertEq(P1.balance, balBefore + STAKE);
        assertFalse(_ticket(t1).active);
    }

    function test_refundTicket_staleBoundary_revertsThenSucceeds() public {
        (uint256 t1, bytes32 roundId) = _commitAs(P1, 1, 10, bytes32(uint256(1)));
        _armAtBoundary(roundId);
        uint256 armedAt = _round(roundId).armedAtBlock;

        vm.roll(armedAt + raffle.STALE_BLOCKS() - 1); // one block short: not yet stale
        vm.prank(P1);
        vm.expectRevert(Raffle.TooEarly.selector);
        raffle.refundTicket(t1);

        vm.roll(armedAt + raffle.STALE_BLOCKS()); // exactly at the boundary: stale
        uint256 balBefore = P1.balance;
        vm.prank(P1);
        raffle.refundTicket(t1);
        assertEq(P1.balance, balBefore + STAKE);
    }
}

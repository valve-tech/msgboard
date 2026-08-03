// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {HoldemRules} from "../../contracts/zk/HoldemRules.sol";

/// @notice COVERAGE-ONLY unit suite for the HoldemRules betting engine (applyMove + its
/// internal transition helpers). Unlike HoldemTableN*.t.sol (which drive HoldemRules only
/// through the happy-path SHOWDOWN bridge) this suite calls `applyMove` directly with
/// hand-built `Holdem` structs to exercise the full negative error matrix (all 12 custom
/// errors), every phase transition (SETUP/DEAL_*/BET_*), fold/check/call/bet/raise legality,
/// the min-raise reopen guard, and the side-pot layering/dead-money/merge logic in
/// `_recomputePots`. Showdown hand-evaluation itself is out of scope (already covered by
/// HandEvalParity.test.ts + HoldemTableNShowdownTest); only the WrongPhase gate around
/// MOVE_SHOWDOWN is touched here as part of the state-machine surface.
///
/// `applyMove` is a pure mirror with no persistent storage, so every test constructs its own
/// self-contained `Holdem` struct - including ones that would never arise from a real co-signed
/// game (e.g. mismatched committed/totalContributed) - purely to reach specific internal
/// branches. That is intentional and documented per-test; HoldemRules trusts structural
/// validity of its input per its own header comment, so this is fair game for a rules-unit test.
contract HoldemRulesUnitTest is Test {
    HoldemRules internal rules;

    // ── mirrors of HoldemRules' internal constants (not accessible from outside) ──
    uint8 internal constant SETUP = 0;
    uint8 internal constant SHUFFLE = 1;
    uint8 internal constant DEAL_HOLE = 2;
    uint8 internal constant BET_PREFLOP = 3;
    uint8 internal constant DEAL_FLOP = 4;
    uint8 internal constant BET_FLOP = 5;
    uint8 internal constant DEAL_TURN = 6;
    uint8 internal constant BET_TURN = 7;
    uint8 internal constant DEAL_RIVER = 8;
    uint8 internal constant BET_RIVER = 9;
    uint8 internal constant SHOWDOWN = 10;
    uint8 internal constant SETTLED = 11;

    uint8 internal constant NONE = 0xff;

    uint8 internal constant MOVE_POST_BLIND = 0;
    uint8 internal constant MOVE_CHECK = 1;
    uint8 internal constant MOVE_CALL = 2;
    uint8 internal constant MOVE_FOLD = 3;
    uint8 internal constant MOVE_BET = 4;
    uint8 internal constant MOVE_RAISE = 5;
    uint8 internal constant MOVE_DEAL_DONE = 6;
    uint8 internal constant MOVE_SHOWDOWN = 7;

    function setUp() public {
        rules = new HoldemRules();
    }

    // ── move encoders (mirror encoding.ts) ──────────────────────────────────────

    function _mSeat(uint8 kind, uint8 seat) internal pure returns (bytes memory) {
        return abi.encode(kind, abi.encode(seat));
    }

    function _mAmt(uint8 kind, uint8 seat, uint256 amt) internal pure returns (bytes memory) {
        return abi.encode(kind, abi.encode(seat, amt));
    }

    function _mNone(uint8 kind) internal pure returns (bytes memory) {
        return abi.encode(kind, bytes(""));
    }

    // ── state builder + apply helper ────────────────────────────────────────────

    /// A fresh n-seat state: deep stacks, everything zeroed, sb=1/bb=2, toAct=NONE (caller sets).
    function _base(uint8 n) internal pure returns (HoldemRules.Holdem memory s) {
        s.nSeats = n;
        s.button = 0;
        s.toAct = NONE;
        s.stacks = new uint256[](n);
        s.committed = new uint256[](n);
        s.totalContributed = new uint256[](n);
        s.folded = new bool[](n);
        s.allIn = new bool[](n);
        s.actedSinceAggression = new bool[](n);
        s.currentBet = 0;
        s.minRaise = 0;
        s.lastAggressor = NONE;
        s.pot = 0;
        s.sidePots = new HoldemRules.SidePot[](0);
        s.smallBlind = 1;
        s.bigBlind = 2;
        s.rakeBps = 0;
        s.rakeCap = 0;
        s.stubWinner = NONE;
        s.rakeAccrued = 0;
        for (uint256 i = 0; i < n; i++) s.stacks[i] = 1_000 ether;
    }

    function _apply(HoldemRules.Holdem memory s, bytes memory move) internal view returns (HoldemRules.Holdem memory out) {
        bytes memory raw = rules.applyMove(abi.encode(s), move);
        out = abi.decode(raw, (HoldemRules.Holdem));
    }

    /// Same as `_apply` but returns the raw bytes without decoding into a `Holdem` struct.
    /// Under this repo's pinned forge nightly (1.6.0-nightly), `vm.expectRevert` fails to
    /// intercept a revert that occurs inside a helper whose return type is the decoded
    /// `Holdem` struct (a call-frame/ABI-decode interaction specific to that build) even
    /// though the identical call reverts correctly when made directly or through a
    /// bytes-returning/void wrapper. Every revert-expecting test below uses this helper
    /// instead of `_apply` to sidestep that toolchain quirk.
    function _applyRaw(HoldemRules.Holdem memory s, bytes memory move) internal view returns (bytes memory raw) {
        raw = rules.applyMove(abi.encode(s), move);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // trivial getters
    // ════════════════════════════════════════════════════════════════════════════

    function test_gameId() public view {
        assertEq(rules.gameId(), 2);
    }

    function test_hashGameState() public view {
        bytes memory gs = "hello";
        assertEq(rules.hashGameState(gs), keccak256(gs));
    }

    function test_isFinal_settledTrue_otherFalse() public view {
        assertTrue(rules.isFinal(SETTLED));
        assertFalse(rules.isFinal(SHOWDOWN));
        assertFalse(rules.isFinal(BET_RIVER));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // whoseTurn
    // ════════════════════════════════════════════════════════════════════════════

    function test_whoseTurn_betPhase_singleBit() public view {
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 1;
        uint256 mask = rules.whoseTurn(abi.encode(s));
        assertEq(mask, uint256(1) << 1);
    }

    function test_whoseTurn_betPhase_noneToAct_zeroMask() public view {
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_TURN;
        s.toAct = NONE;
        assertEq(rules.whoseTurn(abi.encode(s)), 0);
    }

    function test_whoseTurn_dealPhase_allLiveSeatsExceptFolded() public view {
        HoldemRules.Holdem memory s = _base(3);
        s.phase = DEAL_FLOP;
        s.folded[1] = true;
        uint256 mask = rules.whoseTurn(abi.encode(s));
        assertEq(mask, (uint256(1) | (uint256(1) << 2)));
    }

    function test_whoseTurn_showdownAndSettled_zero() public view {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = SHOWDOWN;
        assertEq(rules.whoseTurn(abi.encode(s)), 0);
        s.phase = SETTLED;
        assertEq(rules.whoseTurn(abi.encode(s)), 0);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // WrongPhase (error 1/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_wrongPhase_bettingMoveOutsideBetPhase() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = DEAL_FLOP; // not a BET_* phase
        s.toAct = 0;
        vm.expectRevert(HoldemRules.WrongPhase.selector);
        _applyRaw(s, _mSeat(MOVE_CHECK, 0));
    }

    function test_revert_wrongPhase_showdownMoveNotAtShowdown() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_RIVER;
        // payload is never decoded - the phase gate reverts first.
        vm.expectRevert(HoldemRules.WrongPhase.selector);
        _applyRaw(s, _mNone(MOVE_SHOWDOWN));
    }

    function test_revert_wrongPhase_dealDoneOutsideDealPhase() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_PREFLOP; // not a DEAL_* phase
        vm.expectRevert(HoldemRules.WrongPhase.selector);
        _applyRaw(s, _mNone(MOVE_DEAL_DONE));
    }

    function test_revert_wrongPhase_postBlindNotPreflop() public {
        // Passes the outer BET_* gate (BET_FLOP is a betting phase) but _postBlind's own
        // internal `phase != BET_PREFLOP` check then reverts - a distinct branch from the
        // outer gate.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        vm.expectRevert(HoldemRules.WrongPhase.selector);
        _applyRaw(s, _mAmt(MOVE_POST_BLIND, 0, 1));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // BadSeat (error 2/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_badSeat_outOfRange() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        vm.expectRevert(HoldemRules.BadSeat.selector);
        _applyRaw(s, _mSeat(MOVE_CHECK, 2)); // nSeats == 2, valid seats are 0,1
    }

    // ════════════════════════════════════════════════════════════════════════════
    // NotYourTurn (error 3/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_notYourTurn_bettingMove() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        vm.expectRevert(HoldemRules.NotYourTurn.selector);
        _applyRaw(s, _mSeat(MOVE_CHECK, 1));
    }

    function test_revert_notYourTurn_postBlind() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_PREFLOP;
        s.toAct = 0;
        vm.expectRevert(HoldemRules.NotYourTurn.selector);
        _applyRaw(s, _mAmt(MOVE_POST_BLIND, 1, 1));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // FoldedSeat / AllInSeat (errors 4/12, 5/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_foldedSeat() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.folded[0] = true;
        vm.expectRevert(HoldemRules.FoldedSeat.selector);
        _applyRaw(s, _mSeat(MOVE_CHECK, 0));
    }

    function test_revert_allInSeat() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.allIn[0] = true;
        vm.expectRevert(HoldemRules.AllInSeat.selector);
        _applyRaw(s, _mSeat(MOVE_CHECK, 0));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // BadBlind (error 6/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_badBlind_blindsNotPostedYet() public {
        // preflop, currentBet < bigBlind: any real betting action (not POST_BLIND) is rejected
        // before even reaching the toAct check.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_PREFLOP;
        s.currentBet = 0; // < bigBlind (2)
        s.toAct = 1; // deliberately NOT seat 0, to prove BadBlind fires before NotYourTurn
        vm.expectRevert(HoldemRules.BadBlind.selector);
        _applyRaw(s, _mSeat(MOVE_CHECK, 0));
    }

    function test_revert_badBlind_postBlind_wrongAmount_smallBlind() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_PREFLOP;
        s.toAct = 0;
        // committed all-zero => small blind is expected; smallBlind=1, stack deep so expected=1.
        vm.expectRevert(HoldemRules.BadBlind.selector);
        _applyRaw(s, _mAmt(MOVE_POST_BLIND, 0, 2));
    }

    function test_revert_badBlind_postBlind_wrongAmount_bigBlind() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_PREFLOP;
        s.toAct = 0;
        s.committed[0] = 1; // SB already posted => expectSb=false => bigBlind(2) expected
        s.totalContributed[0] = 1;
        vm.expectRevert(HoldemRules.BadBlind.selector);
        _applyRaw(s, _mAmt(MOVE_POST_BLIND, 0, 1));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // CannotCheck / NothingToCall (errors 7/12, 8/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_cannotCheck_facingABet() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 10;
        vm.expectRevert(HoldemRules.CannotCheck.selector);
        _applyRaw(s, _mSeat(MOVE_CHECK, 0));
    }

    function test_revert_nothingToCall() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 0; // toCall == 0
        vm.expectRevert(HoldemRules.NothingToCall.selector);
        _applyRaw(s, _mSeat(MOVE_CALL, 0));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // BelowMinRaise (error 9/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_belowMinRaise() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 10;
        s.minRaise = 10;
        // raise to 15 => increment 5 < minRaise(10), and NOT all-in (deep stack).
        vm.expectRevert(HoldemRules.BelowMinRaise.selector);
        _applyRaw(s, _mAmt(MOVE_RAISE, 0, 15));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // MustExceedBet (error 10/12) - all three internal sub-branches
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_mustExceedBet_toNotAboveCurrentBet() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 10;
        vm.expectRevert(HoldemRules.MustExceedBet.selector);
        _applyRaw(s, _mAmt(MOVE_BET, 0, 10)); // to == currentBet, not >
    }

    /// `_betRaise`'s `if (need == 0) revert MustExceedBet();` (need = to - already) is DEAD CODE
    /// reachable only via a structurally-invalid state, and even then it's masked by an earlier,
    /// unconditional panic: `applyMove` always computes `toCall = s.currentBet - s.committed[seat]`
    /// BEFORE dispatching to any move kind (including BET/RAISE), so any state with
    /// `committed[seat] > currentBet` reverts with an arithmetic-underflow panic first. That
    /// same computation not reverting proves `committed[seat] <= currentBet` by the time
    /// `_betRaise` runs; combined with the preceding `to > currentBet` check, `need = to -
    /// already` is therefore always strictly positive. This test documents that guard by
    /// showing the underflow panic fires (not MustExceedBet) for the only state that would
    /// otherwise reach `need == 0`.
    function test_revert_mustExceedBet_needZero_isDeadCode_maskedByEarlierUnderflowPanic() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 10;
        s.committed[0] = 15; // only way to reach need==0 downstream: to==already==15>currentBet
        vm.expectRevert(stdError.arithmeticError);
        _applyRaw(s, _mAmt(MOVE_BET, 0, 15));
    }

    function test_revert_mustExceedBet_shortAllInCallForLess() public {
        // A short-stacked seat sends BET/RAISE (not CALL) with an aspirational `to` far above
        // the current bet; once capped by its tiny stack, the resulting target doesn't even
        // reach the current bet - rejected as "should've been a call/fold", not a raise.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 100;
        s.committed[0] = 0;
        s.stacks[0] = 30;
        vm.expectRevert(HoldemRules.MustExceedBet.selector);
        _applyRaw(s, _mAmt(MOVE_RAISE, 0, 150));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // CannotReopen (error 11/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_cannotReopen() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 20;
        s.committed[0] = 10; // hasn't matched currentBet
        s.actedSinceAggression[0] = true; // but already acted this round
        vm.expectRevert(HoldemRules.CannotReopen.selector);
        _applyRaw(s, _mAmt(MOVE_RAISE, 0, 40));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // IllegalMove (error 12/12)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_illegalMove_unknownKind() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        vm.expectRevert(HoldemRules.IllegalMove.selector);
        _applyRaw(s, _mSeat(99, 0));
    }

    // ════════════════════════════════════════════════════════════════════════════
    // _postBlind happy paths (small blind / big blind, full + short all-in)
    // ════════════════════════════════════════════════════════════════════════════

    function test_postBlind_smallBlind_advancesToActWithoutSettingCurrentBet() public {
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_PREFLOP;
        s.toAct = 0;
        HoldemRules.Holdem memory out = _apply(s, _mAmt(MOVE_POST_BLIND, 0, 1));
        assertEq(out.committed[0], 1, "sb committed");
        assertEq(out.stacks[0], 1_000 ether - 1, "sb deducted from stack");
        assertEq(out.currentBet, 0, "SB does not set currentBet");
        assertEq(out.toAct, 1, "advances to next seat");
    }

    function test_postBlind_bigBlind_setsCurrentBetAndMinRaise() public {
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_PREFLOP;
        s.toAct = 1;
        s.committed[0] = 1; // SB already posted
        s.totalContributed[0] = 1;
        s.stacks[0] = 1_000 ether - 1;
        HoldemRules.Holdem memory out = _apply(s, _mAmt(MOVE_POST_BLIND, 1, 2));
        assertEq(out.committed[1], 2, "bb committed");
        assertEq(out.currentBet, 2, "BB sets currentBet");
        assertEq(out.minRaise, 2, "BB sets minRaise");
        assertEq(out.toAct, 2, "advances to next seat (UTG)");
    }

    function test_postBlind_shortAllInSmallBlind() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_PREFLOP;
        s.toAct = 0;
        s.stacks[0] = 0; // can't even cover the SB
        HoldemRules.Holdem memory out = _apply(s, _mAmt(MOVE_POST_BLIND, 0, 0));
        assertEq(out.committed[0], 0);
        assertTrue(out.allIn[0], "posts whole (empty) stack, marked all-in");
    }

    function test_postBlind_shortAllInBigBlind_currentBetStillFullBB() public {
        // Mirrors rules.ts: even when the BB is short (all-in for less), the action level is
        // still the FULL big blind - later callers owe the full amount.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_PREFLOP;
        s.toAct = 1;
        s.committed[0] = 1;
        s.totalContributed[0] = 1;
        s.stacks[0] = 1_000 ether - 1;
        s.stacks[1] = 1; // BB short: can only cover 1 of the 2-wei big blind
        HoldemRules.Holdem memory out = _apply(s, _mAmt(MOVE_POST_BLIND, 1, 1));
        assertEq(out.committed[1], 1, "posted its whole short stack");
        assertTrue(out.allIn[1], "BB marked all-in");
        assertEq(out.currentBet, 2, "action level is still the FULL big blind");
        assertEq(out.minRaise, 2);
    }

    function test_postBlind_bothBlindsShortAllIn_nextToActIsNone() public {
        // Heads-up, both seats jam their entire (tiny) stack just posting blinds: after the BB
        // posts, `_nextToAct` must skip seat0 (all-in) AND seat1 itself (also just went all-in
        // posting its own blind), landing on NONE -- the one path where `_nextToAct` returning
        // NONE is reachable (unlike its call from `_advance`, where `_roundClosed`==false
        // already guarantees an actable seat exists).
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_PREFLOP;
        s.toAct = 0;
        s.stacks[0] = 1; // can only cover the 1-wei small blind
        s.stacks[1] = 1; // can only cover 1 of the 2-wei big blind
        HoldemRules.Holdem memory afterSb = _apply(s, _mAmt(MOVE_POST_BLIND, 0, 1));
        assertTrue(afterSb.allIn[0]);
        assertEq(afterSb.toAct, 1);

        HoldemRules.Holdem memory out = _apply(afterSb, _mAmt(MOVE_POST_BLIND, 1, 1));
        assertTrue(out.allIn[1], "BB also all-in posting its short blind");
        assertEq(out.toAct, NONE, "no actable seat left to post/act -- _nextToAct exhausts to NONE");
    }

    // ════════════════════════════════════════════════════════════════════════════
    // fold / check / call happy paths + round-closing
    // ════════════════════════════════════════════════════════════════════════════

    function test_fold_headsUp_unconestedSweepsPotToLoneWinner_stubWinnerSet() public {
        // A prior (already-closed) street left 5 each in the middle (totalContributed, buy-in
        // consistent: stacks = 1000e18 - 5 each). This street seat0 bets 10 more and seat1
        // folds: exercises liveCount<=1 -> finishHand -> stubWinner, _returnUncalled refunding
        // seat0's unmatched raise, and the merge-on-fold-recompute, ending with a genuine
        // nonzero sweep (the earlier 5+5=10 main pot) to the lone live seat.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.totalContributed[0] = 5;
        s.totalContributed[1] = 5;
        s.stacks[0] = 1_000 ether - 5;
        s.stacks[1] = 1_000 ether - 5;

        HoldemRules.Holdem memory afterBet = _apply(s, _mAmt(MOVE_BET, 0, 10));
        assertEq(afterBet.toAct, 1, "action moves to seat1");

        HoldemRules.Holdem memory out = _apply(afterBet, _mSeat(MOVE_FOLD, 1));
        assertEq(out.phase, SHOWDOWN, "uncontested hand resolves immediately");
        assertEq(out.stubWinner, 0, "lone live seat swept the pot");
        assertEq(out.toAct, NONE);
        assertEq(out.stacks[0], 1_000 ether + 5, "seat0: uncalled 10 refunded, then wins the 10 main pot");
        assertEq(out.stacks[1], 1_000 ether - 5, "seat1 forfeits its earlier 5 by folding");
        assertEq(out.pot, 0);
        assertEq(out.sidePots.length, 0);
    }

    function test_checkCheck_closesStreet_advancesPhase_resetsCommitted() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 0;
        HoldemRules.Holdem memory afterCheck0 = _apply(s, _mSeat(MOVE_CHECK, 0));
        assertEq(afterCheck0.toAct, 1, "action passes to seat1");
        assertEq(afterCheck0.phase, BET_FLOP, "street not yet closed");

        HoldemRules.Holdem memory out = _apply(afterCheck0, _mSeat(MOVE_CHECK, 1));
        assertEq(out.phase, DEAL_TURN, "check-check closes BET_FLOP -> DEAL_TURN");
        assertEq(out.currentBet, 0);
        assertEq(out.minRaise, out.bigBlind, "minRaise reset to bigBlind for next street");
        assertEq(out.lastAggressor, NONE);
        assertFalse(out.actedSinceAggression[0], "acted flags reset for the new street");
        assertFalse(out.actedSinceAggression[1]);
    }

    function test_fullPreflopRound_blindsThenCallsThenCheck_closesToDealFlop() public {
        // 3 seats: seat0=SB, seat1=BB, seat2=UTG. UTG calls, SB calls, BB checks (option) closes.
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_PREFLOP;
        s.toAct = 0;
        HoldemRules.Holdem memory st = _apply(s, _mAmt(MOVE_POST_BLIND, 0, 1));
        assertEq(st.toAct, 1);
        st = _apply(st, _mAmt(MOVE_POST_BLIND, 1, 2));
        assertEq(st.currentBet, 2);
        assertEq(st.toAct, 2, "UTG to act");

        st = _apply(st, _mSeat(MOVE_CALL, 2)); // UTG calls 2
        assertEq(st.committed[2], 2);
        assertEq(st.toAct, 0, "back to SB");

        st = _apply(st, _mSeat(MOVE_CALL, 0)); // SB calls up to 2 (adds 1 more)
        assertEq(st.committed[0], 2);
        assertEq(st.toAct, 1, "BB gets the option");

        st = _apply(st, _mSeat(MOVE_CHECK, 1)); // BB checks its option (toCall == 0)
        assertEq(st.phase, DEAL_FLOP, "preflop round closes to DEAL_FLOP");
        assertEq(st.currentBet, 0);
        for (uint256 i = 0; i < 3; i++) assertEq(st.committed[i], 0, "committed reset for flop");
        assertEq(st.pot, 6, "sb+bb+utg all matched at 2 => pot 6");
    }

    function test_allInCallForLess_triggersReturnUncalled_excessRefunded() public {
        // seat0 bets 100 (postflop), seat1 (short stack 30) calls for less => all-in.
        // roundClosed fires because the ONLY remaining actable seat (seat0) already
        // matched+acted; the street closes and seat0's uncalled 70 is refunded.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.stacks[1] = 30;
        HoldemRules.Holdem memory afterBet = _apply(s, _mAmt(MOVE_BET, 0, 100));
        assertEq(afterBet.toAct, 1);

        HoldemRules.Holdem memory out = _apply(afterBet, _mSeat(MOVE_CALL, 1));
        assertTrue(out.allIn[1], "seat1 is all-in for less");
        assertEq(out.phase, DEAL_TURN, "street closed (seat0 already matched+acted)");
        assertEq(out.committed[0], 0, "reset for next street");
        assertEq(out.committed[1], 0);
        assertEq(out.stacks[0], 1_000 ether - 30, "70 uncalled excess refunded to seat0");
        assertEq(out.pot, 60, "main pot = 30(seat0) + 30(seat1)");
    }

    function test_returnUncalled_noExcess_whenBetsAreTied() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = BET_FLOP;
        s.toAct = 0;
        HoldemRules.Holdem memory afterBet = _apply(s, _mAmt(MOVE_BET, 0, 50));
        HoldemRules.Holdem memory out = _apply(afterBet, _mSeat(MOVE_CALL, 1)); // exact call
        assertEq(out.stacks[0], 1_000 ether - 50, "no refund - bets were tied");
        assertEq(out.stacks[1], 1_000 ether - 50);
        assertEq(out.pot, 100);
    }

    function test_allInCall_actableCountZero_closesRoundEvenWithMismatchedCommitted() public {
        // Two seats already all-in with DIFFERENT committed amounts (50, 30); the third seat's
        // short all-in call brings actableCount to 0, which must close the round via the
        // `_actableCount(s) == 0` short-circuit in `_roundClosed` - distinct from (and reached
        // before) the "everyone matched" per-seat loop, which these committed values would fail.
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 2;
        s.currentBet = 50;
        s.minRaise = 20;
        s.committed[0] = 50; s.totalContributed[0] = 50; s.allIn[0] = true; s.stacks[0] = 0;
        s.committed[1] = 30; s.totalContributed[1] = 30; s.allIn[1] = true; s.stacks[1] = 0;
        s.actedSinceAggression[0] = true;
        s.actedSinceAggression[1] = true;
        s.stacks[2] = 20; // short: call for less than currentBet

        HoldemRules.Holdem memory out = _apply(s, _mSeat(MOVE_CALL, 2));
        assertTrue(out.allIn[2]);
        assertEq(out.phase, DEAL_TURN, "round closed via actableCount==0, not the matched loop");
        assertEq(out.toAct, NONE, "no live actable seats left => firstLiveLeftOfButton is NONE");
        assertEq(out.stacks[0], 20, "seat0's 20 uncalled excess (50 - second-highest 30) refunded");
    }

    // ════════════════════════════════════════════════════════════════════════════
    // bet / raise: min-raise reopen logic (full raise vs short all-in raise)
    // ════════════════════════════════════════════════════════════════════════════

    function test_fullRaise_resetsActedSinceAggressionForOthers_andRaisesMinRaise() public {
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.minRaise = 10; // == bigBlind

        HoldemRules.Holdem memory st = _apply(s, _mAmt(MOVE_BET, 0, 20)); // bet 20 (full open)
        assertEq(st.currentBet, 20);
        assertEq(st.minRaise, 20, "minRaise becomes the bet size");
        assertEq(st.lastAggressor, 0);
        assertTrue(st.actedSinceAggression[0]);
        assertFalse(st.actedSinceAggression[1]);

        st = _apply(st, _mAmt(MOVE_RAISE, 1, 50)); // raise to 50: increment 30 >= minRaise(20)
        assertEq(st.currentBet, 50);
        assertEq(st.minRaise, 30, "minRaise becomes the raise increment");
        assertEq(st.lastAggressor, 1);
        assertFalse(st.actedSinceAggression[0], "full raise re-opens action for everyone else");
        assertTrue(st.actedSinceAggression[1]);

        // seat2 attempts to raise by only 10 (< minRaise 30) - rejected.
        vm.expectRevert(HoldemRules.BelowMinRaise.selector);
        _applyRaw(st, _mAmt(MOVE_RAISE, 2, 60));

        // a raise that meets the reopened minRaise succeeds.
        HoldemRules.Holdem memory st2 = _apply(st, _mAmt(MOVE_RAISE, 2, 90)); // increment 40 >= 30
        assertEq(st2.currentBet, 90);
        assertEq(st2.minRaise, 40);
        assertEq(st2.lastAggressor, 2);
        assertFalse(st2.actedSinceAggression[0]);
        assertFalse(st2.actedSinceAggression[1], "reset again by seat2's full raise");
    }

    function test_shortAllInRaise_belowMinRaise_doesNotReopenAction() public {
        // A short all-in for less than a full raise is accepted (isAllIn bypasses the
        // BelowMinRaise gate) but is NOT a full raise: minRaise/lastAggressor stay put and
        // other seats' actedSinceAggression is NOT reset.
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 20;
        s.minRaise = 20;
        s.actedSinceAggression[1] = true; // seat1 already acted this round
        s.actedSinceAggression[2] = true;
        s.stacks[0] = 25; // can only make it to 25 total (< 20+20 minRaise reopen of 40)

        HoldemRules.Holdem memory out = _apply(s, _mAmt(MOVE_RAISE, 0, 1_000 ether));
        assertTrue(out.allIn[0]);
        assertEq(out.committed[0], 25);
        assertEq(out.currentBet, 25, "actualTarget becomes the new (short) currentBet");
        assertEq(out.minRaise, 20, "short all-in raise does not update minRaise");
        assertEq(out.lastAggressor, NONE, "short all-in raise is not a full raise/aggression");
        assertTrue(out.actedSinceAggression[1], "NOT reset - short raise does not reopen action");
        assertTrue(out.actedSinceAggression[2]);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // MOVE_DEAL_DONE: phase transitions + the run-out (auto-close) mechanic
    // ════════════════════════════════════════════════════════════════════════════

    function test_dealDone_holeToPreflop() public {
        HoldemRules.Holdem memory s = _base(2);
        s.phase = DEAL_HOLE;
        HoldemRules.Holdem memory out = _apply(s, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, BET_PREFLOP);
        assertEq(out.toAct, 1, "first live seat left of button (button=0, n=2) => seat1");
    }

    function test_dealDone_flopTurnRiver_transitions_whenMultipleActable() public {
        // 3 live actable seats: dealDone just moves the phase, no auto-close.
        HoldemRules.Holdem memory s = _base(3);
        s.phase = DEAL_FLOP;
        HoldemRules.Holdem memory out = _apply(s, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, BET_FLOP);

        out.phase = DEAL_TURN;
        out = _apply(out, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, BET_TURN);

        out.phase = DEAL_RIVER;
        out = _apply(out, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, BET_RIVER);
    }

    function test_dealDone_singleActable_notMatched_doesNotAutoClose() public {
        // actableCount <= 1 is TRUE (only seat1 is actable) but allMatchedOrAllIn is FALSE
        // (seat1 hasn't matched currentBet) - the run-out condition's AND must short-circuit
        // to false, so no auto-close happens here.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = DEAL_HOLE;
        s.folded[0] = true; // only seat1 is actable
        s.currentBet = 5;
        s.committed[1] = 0; // not matched
        HoldemRules.Holdem memory out = _apply(s, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, BET_PREFLOP, "transitions but does NOT run out");
        assertEq(out.toAct, 1);
    }

    function test_dealDone_runOut_singleActable_allMatched_autoCloses() public {
        // Only seat1 is actable (seat0 all-in) and everyone actable is matched at currentBet 0
        // (fresh street) => auto-closes straight through to the next deal phase.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = DEAL_FLOP;
        s.allIn[0] = true;
        s.totalContributed[0] = 40;
        s.totalContributed[1] = 40;
        HoldemRules.Holdem memory out = _apply(s, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, DEAL_TURN, "auto-closed BET_FLOP -> DEAL_TURN in one call");
    }

    function test_dealDone_runOut_chainsAllTheWayToShowdown_bothAllInPreflop() public {
        // Classic heads-up all-in-preflop run-out: the dealer submits DEAL_DONE once per
        // street; each call auto-closes the (unplayable) betting round for that street.
        HoldemRules.Holdem memory s = _base(2);
        s.phase = DEAL_FLOP;
        s.allIn[0] = true;
        s.allIn[1] = true;
        s.totalContributed[0] = 100;
        s.totalContributed[1] = 100;

        HoldemRules.Holdem memory out = _apply(s, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, DEAL_TURN, "flop run-out");

        out = _apply(out, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, DEAL_RIVER, "turn run-out");

        out = _apply(out, _mNone(MOVE_DEAL_DONE));
        assertEq(out.phase, SHOWDOWN, "river run-out finishes the hand");
        assertEq(out.toAct, NONE);
        assertEq(out.stubWinner, NONE, "both seats live => multiway showdown, no stub sweep");
        assertEq(out.pot, 200, "no folds/excess: full pot carried to showdown");
    }

    // ════════════════════════════════════════════════════════════════════════════
    // _recomputePots: layered side pots, dead-money carry, adjacent-mask merge
    // ════════════════════════════════════════════════════════════════════════════

    function test_recomputePots_layeredSidePots_viaStaggeredAllIns() public {
        // A(20) shoves, B(50) shoves, C(200) calls B's 50 => classic 2-layer side pot:
        // main pot (all 3 eligible, level 20) + a contested side pot (B,C eligible, level 30).
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.stacks[0] = 20;
        s.stacks[1] = 50;
        s.stacks[2] = 200;

        HoldemRules.Holdem memory st = _apply(s, _mAmt(MOVE_BET, 0, 20));
        assertTrue(st.allIn[0]);
        assertEq(st.toAct, 1);

        st = _apply(st, _mAmt(MOVE_RAISE, 1, 50));
        assertTrue(st.allIn[1]);
        assertEq(st.toAct, 2);

        HoldemRules.Holdem memory out = _apply(st, _mSeat(MOVE_CALL, 2));
        // level 20: width 20 * 3 contributors (all reached >=20), all 3 eligible => 60.
        assertEq(out.pot, 60, "main pot: level20 width(20) * 3 contributors, all eligible");
        assertEq(out.sidePots.length, 1);
        // level 50: width 30 (50-20) * 2 contributors (seat1,seat2 reached >=50) => 60.
        assertEq(out.sidePots[0].amount, 60, "side pot: level50 width(30) * 2 contributors");
        assertEq(out.sidePots[0].eligibleMask, uint256(0x6), "eligible: seat1 + seat2 (bits 1,2)");
    }

    function test_recomputePots_deadMoneyCarry_whenTopContributorFolded() public {
        // Direct-state trigger: totalContributed carries the whole-hand history; a fresh street
        // (committed all zero) lets us feed an arbitrary totalContributed/folded combination and
        // observe `_recomputePots` (invoked unconditionally at the top of `_advance`) via a
        // trivial legal MOVE_CHECK. Seat2 is the SOLE contributor at the top level (60) and is
        // folded => that whole top layer has zero eligible seats and must carry as dead money
        // into the pot below (elig == 0 branch), rather than becoming an unreachable side pot.
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 0; // check is legal
        s.totalContributed[0] = 30;
        s.totalContributed[1] = 20;
        s.totalContributed[2] = 60;
        s.folded[2] = true;

        HoldemRules.Holdem memory out = _apply(s, _mSeat(MOVE_CHECK, 0));
        // level20: width20 * 3 contributors (seat0,1,2 all reached >=20) = 60 (main pot; seat2's
        // contribution still fills width/contributors even though it's folded and ineligible).
        assertEq(out.pot, 60, "main pot: level20 width(20) * 3 contributors");
        assertEq(out.sidePots.length, 1, "level30 layer survives as a side pot (seat0 only eligible)");
        // level30 layer: width10 * 2 contributors (seat0 AND seat2 both reached >=30) = 20; 1
        // eligible seat (seat0; seat2 folded) so it stays its own side pot rather than merging
        // into the main pot below. The level60 layer (width30 * 1 contributor = 30) has ZERO
        // eligible seats (its sole contributor, seat2, is folded) so it carries as dead money
        // into THIS side pot (the last pot created so far), not into the main pot: 20 + 30 = 50.
        assertEq(out.sidePots[0].amount, 50, "level30(20) + dead-carried level60(30)");
        assertEq(out.sidePots[0].eligibleMask, uint256(0x1), "only seat0 reached level 30 and is live");
    }

    function test_recomputePots_mergesAdjacentLayersWithIdenticalEligibleMask() public {
        // seat0 folded after contributing 15 (between B/C's 20). Because folded seats never
        // affect the *eligible* mask (only the contributor count), the level-15 and level-20
        // layers end up with the SAME eligible mask (seat1,seat2) and must merge into one pot
        // rather than two adjacent side pots.
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 1;
        s.currentBet = 0;
        s.totalContributed[0] = 15;
        s.totalContributed[1] = 20;
        s.totalContributed[2] = 20;
        s.folded[0] = true;

        HoldemRules.Holdem memory out = _apply(s, _mSeat(MOVE_CHECK, 1));
        assertEq(out.pot, 55, "15*3 + 5*2 merged into a single pot (no side pot layer)");
        assertEq(out.sidePots.length, 0, "adjacent equal-mask layers merged, not split");
    }

    function test_recomputePots_allContributorsFolded_deadCarryWithNoPotYetCreated() public {
        // seat0 is the sole live/acting seat and has contributed NOTHING yet (checks legally);
        // every seat that HAS contributed (seat1, seat2) is folded, so every level in the
        // recompute loop has elig==0 and `pc` never advances past 0 -- hitting
        // `_recomputePots`'s tail else-branch (`if (pc > 0) ... else { potAmt[0] = deadCarry;
        // potMask[0] = 0; pc = 1; }`), which only fires when NO pot was created at all before
        // the trailing dead money. Since seat0 is also the only live seat, this same CHECK
        // closes the street straight through to `_finishHand`'s uncontested sweep (recomputing
        // pots again with the same inputs each time), so the dead 80 ends up swept to seat0.
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.currentBet = 0;
        s.totalContributed[1] = 30;
        s.totalContributed[2] = 50;
        s.folded[1] = true;
        s.folded[2] = true;

        HoldemRules.Holdem memory out = _apply(s, _mSeat(MOVE_CHECK, 0));
        assertEq(out.phase, SHOWDOWN, "seat0 is the lone live seat: hand resolves immediately");
        assertEq(out.stubWinner, 0);
        // level30 (width30*2 contributors=60, elig 0) + level50 (width20*1=20, elig 0) => 80 of
        // dead money, entirely uneligible (seat0 itself never contributed), swept to seat0 as
        // the lone survivor by `_finishHand` regardless.
        assertEq(out.stacks[0], 1_000 ether + 80, "dead 80 swept to the lone live seat");
        assertEq(out.pot, 0);
        assertEq(out.sidePots.length, 0);
    }
}

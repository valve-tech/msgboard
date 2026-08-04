// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemRules} from "../../contracts/zk/HoldemRules.sol";

/// @notice COVERAGE-ONLY follow-up to HoldemRulesUnit.t.sol, targeting the SHOWDOWN settlement
/// path (`_showdown`, Task 7) which that suite's own docstring explicitly scopes OUT ("Showdown
/// hand-evaluation itself is out of scope ... only the WrongPhase gate around MOVE_SHOWDOWN is
/// touched here"). Measured coverage confirms the gap: the uncontested-rake branch, the
/// multiway side-pot eligibility/masking loop, and the rake-exhausts-a-pot / dead-side-pot
/// `continue`s in `_showdown` were all unexercised by the existing HoldemRulesUnit + Holdem-
/// TableNShowdown suites (the latter only ever builds a single main pot, so its side-pot
/// masking/`continue` arms and the STUB-winner rake-cap clamp at line 408 went untouched — note
/// HoldemTableNShowdown DOES cover the distinct multiway rake-cap clamp). Every test here drives `applyMove` directly (the only externally-reachable
/// entrypoint), mirroring HoldemRulesUnit.t.sol's own documented convention of constructing
/// self-contained `Holdem` structs — including ones a real co-signed game would never produce —
/// to reach specific internal branches ("that is intentional and documented per-test; HoldemRules
/// trusts structural validity of its input per its own header comment, so this is fair game").
contract HoldemRulesCovTest is Test {
    HoldemRules internal rules;

    uint8 internal constant BET_FLOP = 5;
    uint8 internal constant DEAL_TURN = 6;
    uint8 internal constant SHOWDOWN = 10;
    uint8 internal constant SETTLED = 11;
    uint8 internal constant NONE = 0xff;

    uint8 internal constant MOVE_CALL = 2;
    uint8 internal constant MOVE_BET = 4;
    uint8 internal constant MOVE_RAISE = 5;
    uint8 internal constant MOVE_DEAL_DONE = 6;
    uint8 internal constant MOVE_SHOWDOWN = 7;

    function setUp() public {
        rules = new HoldemRules();
    }

    // ── shared helpers (mirror HoldemRulesUnit.t.sol / HoldemTableNShowdown.t.sol) ──────────

    function _card(uint8 rank, uint8 suit) internal pure returns (uint8) { return (rank - 2) * 4 + suit; }

    function _mAmt(uint8 kind, uint8 seat, uint256 amt) internal pure returns (bytes memory) {
        return abi.encode(kind, abi.encode(seat, amt));
    }

    function _mSeat(uint8 kind, uint8 seat) internal pure returns (bytes memory) {
        return abi.encode(kind, abi.encode(seat));
    }

    function _mNone(uint8 kind) internal pure returns (bytes memory) {
        return abi.encode(kind, bytes(""));
    }

    function _mShowdown(uint8[2][] memory holes, uint8[5] memory board) internal pure returns (bytes memory) {
        return abi.encode(MOVE_SHOWDOWN, abi.encode(holes, board));
    }

    /// A fresh n-seat betting state (mirrors HoldemRulesUnit.t.sol's `_base`): deep stacks,
    /// everything zeroed, sb=1/bb=2, toAct=NONE (caller sets).
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

    /// A ready-to-settle SHOWDOWN state: zeroed pot/sidePots/folded, stubWinner=NONE, so each
    /// test only has to set the handful of fields it cares about.
    function _showdownBase(uint8 n) internal pure returns (HoldemRules.Holdem memory s) {
        s = _base(n);
        s.phase = SHOWDOWN;
        s.toAct = NONE;
    }

    function _apply(HoldemRules.Holdem memory s, bytes memory move) internal view returns (HoldemRules.Holdem memory out) {
        bytes memory raw = rules.applyMove(abi.encode(s), move);
        out = abi.decode(raw, (HoldemRules.Holdem));
    }

    /// See HoldemRulesUnit.t.sol's `_applyRaw` doc: under this repo's pinned forge nightly,
    /// `vm.expectRevert` does not reliably intercept a revert raised inside a helper whose
    /// return type is the decoded `Holdem` struct, so revert-expecting tests call this
    /// bytes-returning wrapper directly instead of `_apply`.
    function _applyRaw(HoldemRules.Holdem memory s, bytes memory move) internal view returns (bytes memory raw) {
        raw = rules.applyMove(abi.encode(s), move);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // _showdown: uncontested (stubWinner != NONE) rake application
    // ════════════════════════════════════════════════════════════════════════════

    function test_showdown_uncontested_appliesRakeToStubWinner() public {
        // A hand that already resolved via the fold-sweep STUB (see HoldemRulesUnit.t.sol's
        // test_fold_headsUp_...) leaves stubWinner set; a later MOVE_SHOWDOWN call must still
        // run rake on the swept pot before reaching SETTLED. Never exercised by the existing
        // suites: HoldemRulesUnit only checks the *sweep* (never calls applyMove again to
        // settle), and HoldemTableNShowdown always builds stubWinner==NONE multiway states.
        HoldemRules.Holdem memory s = _showdownBase(2);
        s.stubWinner = 0;
        s.totalContributed[0] = 300;
        s.totalContributed[1] = 700; // potBase = 1000
        s.rakeBps = 250; // 2.5%
        s.rakeCap = 1_000; // loose, does not bind
        s.stacks[0] = 100_000; // already includes the swept pot, per _finishHand's STUB sweep
        s.stacks[1] = 500; // distinct sentinel: the loser's stack must be left untouched

        uint8[2][] memory holes = new uint8[2][](2); // unread on the stubWinner path
        uint8[5] memory board;
        HoldemRules.Holdem memory out = _apply(s, _mShowdown(holes, board));

        assertEq(out.phase, SETTLED);
        assertEq(out.toAct, NONE);
        assertEq(out.rakeAccrued, 25, "1000 * 2.5%");
        assertEq(out.stacks[0], 100_000 - 25, "rake deducted from the winner's swept stack");
        assertEq(out.stacks[1], 500, "loser's stack untouched by showdown settlement");
    }

    function test_showdown_uncontested_rakeClampedToRakeCap() public {
        // Same STUB path, but the nominal rake (100% of a 1000-unit pot) blows past a tiny
        // rakeCap: `rakeU = s.rakeCap` (the clamp assignment) must fire.
        HoldemRules.Holdem memory s = _showdownBase(2);
        s.stubWinner = 1;
        s.totalContributed[0] = 300;
        s.totalContributed[1] = 700; // potBase = 1000
        s.rakeBps = 10_000; // 100% nominal
        s.rakeCap = 7; // binds hard
        s.stacks[1] = 100_000;

        uint8[2][] memory holes = new uint8[2][](2);
        uint8[5] memory board;
        HoldemRules.Holdem memory out = _apply(s, _mShowdown(holes, board));

        assertEq(out.rakeAccrued, 7, "clamped to rakeCap, not the nominal 1000");
        assertEq(out.stacks[1], 100_000 - 7);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // _showdown: genuine multiway settlement with a real (gameplay-derived) side pot
    // ════════════════════════════════════════════════════════════════════════════

    function test_showdown_multiway_mainAndSidePot_differentWinners() public {
        // Drives a real staggered-all-in hand (seat0 all-in 20, seat1 all-in 50, seat2 calls
        // 50 with a deep stack) all the way from BET_FLOP through the run-out to a genuine
        // multiway SHOWDOWN with ONE main pot (all 3 eligible) and ONE side pot (seat1+seat2
        // only) -- the exact side-pot shape HoldemRulesUnit.t.sol's
        // test_recomputePots_layeredSidePots_viaStaggeredAllIns builds but never carries to
        // MOVE_SHOWDOWN, and HoldemTableNShowdown.t.sol never builds at all (its `_showdownState`
        // always has empty sidePots). Board/holes mirror HoldemTableNShowdown.t.sol's proven
        // scoring (trip aces > trip kings > trip sevens), but seat0's stack is capped at 20 so
        // it is ONLY eligible for the main pot -- giving the main pot and side pot DIFFERENT
        // winners and forcing `_showdown` to (a) build the side pot's eligible mask from
        // `s.sidePots[k].eligibleMask` (the `mm |= ...` loop) and (b) `continue` past seat0 when
        // scoring the side pot (seat0's mask bit is unset).
        HoldemRules.Holdem memory s = _base(3);
        s.phase = BET_FLOP;
        s.toAct = 0;
        s.stacks[0] = 20;
        s.stacks[1] = 50;
        s.stacks[2] = 200;

        HoldemRules.Holdem memory st = _apply(s, _mAmt(MOVE_BET, 0, 20));
        assertTrue(st.allIn[0]);
        st = _apply(st, _mAmt(MOVE_RAISE, 1, 50));
        assertTrue(st.allIn[1]);
        st = _apply(st, _mSeat(MOVE_CALL, 2));
        assertEq(st.phase, DEAL_TURN, "flop round closes (only seat2 actable, matched+acted)");
        assertEq(st.pot, 60, "main pot: level20 * 3 contributors");
        assertEq(st.sidePots.length, 1);
        assertEq(st.sidePots[0].amount, 60, "side pot: level30(50-20) * 2 contributors");
        assertEq(st.sidePots[0].eligibleMask, uint256(0x6), "seat1 + seat2 only");

        // Run out the rest of the board (only seat2 is actable and already matched -> each
        // MOVE_DEAL_DONE auto-closes straight through to the next deal phase / showdown).
        st = _apply(st, _mNone(MOVE_DEAL_DONE));
        st = _apply(st, _mNone(MOVE_DEAL_DONE));
        assertEq(st.phase, SHOWDOWN);
        assertEq(st.stubWinner, NONE, "all 3 seats live -> genuine multiway showdown");

        // Board: A♠ K♠ 7♥ 2♦ 3♣ (suits S=0 H=1 D=2 C=3).
        uint8[5] memory board = [_card(14, 0), _card(13, 0), _card(7, 1), _card(2, 2), _card(3, 3)];
        uint8[2][] memory holes = new uint8[2][](3);
        holes[0] = [_card(14, 1), _card(14, 2)]; // A♥A♦ -> trip aces: best overall, wins main
        holes[1] = [_card(13, 1), _card(13, 2)]; // K♥K♦ -> trip kings: best of {1,2}, wins side
        holes[2] = [_card(7, 0), _card(7, 3)]; // 7♠7♣ -> trip sevens: worst

        HoldemRules.Holdem memory out = _apply(st, _mShowdown(holes, board));

        assertEq(out.phase, SETTLED);
        assertEq(out.rakeAccrued, 0);
        assertEq(out.stacks[0], 60, "seat0 (all-in, main-pot-only eligible) wins the 60 main pot");
        assertEq(out.stacks[1], 60, "seat1 wins the 60 side pot (beats seat2, seat0 ineligible)");
        assertEq(out.stacks[2], 150, "seat2 (deep stack, 200-50 call) wins nothing at showdown");
        assertEq(out.pot, 0);
        assertEq(out.sidePots.length, 0);
        // Sigma conservation: original 20+50+200 buy-ins == final stacks (no rake taken).
        assertEq(out.stacks[0] + out.stacks[1] + out.stacks[2], 270);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // _showdown: defensive `continue`s (dead/zeroed pots) — direct-state, see class docstring
    // ════════════════════════════════════════════════════════════════════════════

    function test_showdown_multiway_sidePotWithNoLiveEligibleSeat_isSkippedNotStuck() public {
        // Directly constructs a SHOWDOWN state whose side pot's `eligibleMask` names ONLY a
        // seat that is *currently* folded. Per HoldemRules' own header comment, `applyMove`
        // "trusts structural validity" of whatever gameState the caller (HoldemTableN) hands
        // it; this exact combination cannot arise by walking applyMove from a fresh table
        // (`_recomputePots`'s merge-adjacent-identical-eligible-mask rule means a side pot
        // survives to `_finishHand`'s stub sweep only when >=2 distinct live-eligible masks
        // exist, and a side pot's own eligibleMask is always recomputed fresh from the CURRENT
        // fold state at every _putIn/_advance) -- but `_showdown` is a `pure` function taking
        // arbitrary calldata, so this is exactly the caller-supplied-inconsistency case its own
        // `elig == 0` guard defends against. This test locks in that defensive behavior: the
        // dead pot is skipped (not distributed to anyone, not underflowed, not double-counted)
        // rather than crashing or being silently awarded to the wrong seat.
        HoldemRules.Holdem memory s = _showdownBase(3);
        s.folded[2] = true; // seat2 folded
        s.pot = 60; // main pot: seat0/seat1 eligible (seat2 excluded by _showdown's own fold-filter)
        s.sidePots = new HoldemRules.SidePot[](1);
        s.sidePots[0] = HoldemRules.SidePot({amount: 40, eligibleMask: uint256(1) << 2}); // seat2 ONLY
        s.stacks[0] = 100;
        s.stacks[1] = 100;
        s.stacks[2] = 100;

        uint8[5] memory board = [_card(14, 0), _card(13, 0), _card(7, 1), _card(2, 2), _card(3, 3)];
        uint8[2][] memory holes = new uint8[2][](3);
        holes[0] = [_card(14, 1), _card(14, 2)]; // A♥A♦ -> trip aces: wins the main pot
        holes[1] = [_card(13, 1), _card(13, 2)]; // K♥K♦
        holes[2] = [uint8(0), uint8(1)]; // never scored: the side pot has zero live eligibles

        HoldemRules.Holdem memory out = _apply(s, _mShowdown(holes, board));

        assertEq(out.phase, SETTLED);
        assertEq(out.stacks[0], 160, "seat0 wins the 60 main pot");
        assertEq(out.stacks[1], 100, "seat1 unchanged");
        assertEq(out.stacks[2], 100, "seat2 (folded, sole 'eligible' for the dead side pot) gets nothing");
        assertEq(out.rakeAccrued, 0);
        assertEq(out.pot, 0);
        assertEq(out.sidePots.length, 0);
        // The dead side pot's 40 units are not distributed to any seat's stack (they are
        // dropped when `sidePots` is zeroed below) -- document the actual conservation instead
        // of assuming it: only the contested 60 main pot is ever paid out.
        assertEq(out.stacks[0] + out.stacks[1] + out.stacks[2], 300 + 60, "only the main pot was distributed");
    }

    function test_showdown_multiway_rakeConsumesEntirePot_skipsDistributionForThatPot() public {
        // 100% nominal rake (rakeBps=10000) against two contested pots: the main pot's entire
        // 100 is taken as rake first, then the leftover rake budget (10) exactly consumes the
        // 10-unit side pot too -- both pots hit `distributable == 0` and `continue` before ever
        // reaching the hand-scoring loop (no winner is computed for either pot).
        HoldemRules.Holdem memory s = _showdownBase(2);
        s.pot = 100;
        s.sidePots = new HoldemRules.SidePot[](1);
        s.sidePots[0] = HoldemRules.SidePot({amount: 10, eligibleMask: uint256(0x3)}); // seat0+seat1
        s.rakeBps = 10_000; // 100%
        s.rakeCap = 1_000; // loose vs. the true 110 rake base, does not bind
        s.stacks[0] = 5_000;
        s.stacks[1] = 5_000;

        // Cards are never read (both pots are fully raked before scoring), but the payload
        // still has to decode with the right shape.
        uint8[2][] memory holes = new uint8[2][](2);
        holes[0] = [_card(2, 0), _card(3, 0)];
        holes[1] = [_card(4, 0), _card(5, 0)];
        uint8[5] memory board = [_card(6, 0), _card(7, 0), _card(8, 0), _card(9, 0), _card(10, 0)];

        HoldemRules.Holdem memory out = _apply(s, _mShowdown(holes, board));

        assertEq(out.phase, SETTLED);
        assertEq(out.rakeAccrued, 110, "100% of the full 100+10 rake base, uncapped");
        assertEq(out.stacks[0], 5_000, "no winnings paid out -- fully raked");
        assertEq(out.stacks[1], 5_000);
        assertEq(out.pot, 0);
        assertEq(out.sidePots.length, 0);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // _showdown: malformed-payload guard (holes.length must equal nSeats)
    // ════════════════════════════════════════════════════════════════════════════

    function test_revert_showdown_holesLengthMismatch() public {
        // `board` is a fixed-size `uint8[5]` in the abi.decode, so `board.length == 5` can
        // never be false for any successfully-decoded payload (a compile-time tautology --
        // deliberately not tested here). `holes`, however, is a dynamic `uint8[2][]`; nothing
        // in `applyMove`'s decode step enforces its length against `s.nSeats` before this
        // require, so a caller supplying a mismatched array is a genuinely reachable, real
        // guard against a malformed showdown payload.
        HoldemRules.Holdem memory s = _showdownBase(3); // nSeats = 3, stubWinner = NONE

        uint8[2][] memory holes = new uint8[2][](2); // wrong length: 2 != nSeats(3)
        uint8[5] memory board;
        vm.expectRevert(bytes("showdown: holes"));
        _applyRaw(s, _mShowdown(holes, board));
    }
}

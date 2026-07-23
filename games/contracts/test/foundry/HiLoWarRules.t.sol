// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {HiLoWarRules} from "../../contracts/zk/HiLoWarRules.sol";

/// Local mirror of HiLoWarRules.HiLo (encoding.ts GAME_STATE_ABI field-for-field). The contract's
/// copy is internal-only; we decode `applyMove`'s returned bytes against this tuple to inspect
/// accounting. Field order MUST match the production struct exactly or abi.decode silently misreads.
struct HiLo {
    uint8 phase;
    uint32 deckIndex;
    uint256 ante;
    uint256 pot;
    uint256 warPot;
    uint256 contributedA;
    uint256 contributedB;
    bytes32 commitA;
    bytes32 commitB;
    uint8 betA;
    uint8 betB;
    uint8 raiser;
    uint8 resultWinner;
    uint256 resultAmount;
    bool resultSet;
    bool foldedCardHidden;
}

/// Shared phase / move / seat / bet constants and move-encoding helpers, plus the canonical
/// `_betCommitHash` mirror. Used by both the handler and the stateless fuzz contract.
library HiLoCodec {
    uint8 internal constant PHASE_SETUP = 0;
    uint8 internal constant PHASE_DEAL = 1;
    uint8 internal constant PHASE_BET_COMMIT = 2;
    uint8 internal constant PHASE_BET_OPEN = 3;
    uint8 internal constant PHASE_CALL_OR_FOLD = 4;
    uint8 internal constant PHASE_SHOWDOWN = 5;
    uint8 internal constant PHASE_FLIP_DONE = 6;
    uint8 internal constant PHASE_SETTLED = 7;

    uint8 internal constant SEAT_A = 1;
    uint8 internal constant SEAT_B = 2;
    uint8 internal constant BET_RAISE = 1;
    uint8 internal constant BET_HOLD = 2;

    uint8 internal constant MOVE_DEAL_DONE = 0;
    uint8 internal constant MOVE_BET_COMMIT = 1;
    uint8 internal constant MOVE_BET_OPEN = 2;
    uint8 internal constant MOVE_CALL = 3;
    uint8 internal constant MOVE_FOLD = 4;
    uint8 internal constant MOVE_SHOWDOWN = 5;

    /// Mirrors hilo-war hashBetCommit: keccak256(utf8 prefix ++ salt).
    function betCommitHash(uint8 bet, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(
            bet == BET_RAISE ? bytes("hilo-war/bet/RAISE/") : bytes("hilo-war/bet/HOLD/"),
            salt
        ));
    }

    function dealDone() internal pure returns (bytes memory) {
        return abi.encode(MOVE_DEAL_DONE, bytes(""));
    }
    function betCommit(uint8 by, bytes32 commitment) internal pure returns (bytes memory) {
        return abi.encode(MOVE_BET_COMMIT, abi.encode(by, commitment));
    }
    function betOpen(uint8 by, uint8 bet, bytes32 salt) internal pure returns (bytes memory) {
        return abi.encode(MOVE_BET_OPEN, abi.encode(by, bet, salt));
    }
    function callMove(uint8 by) internal pure returns (bytes memory) {
        return abi.encode(MOVE_CALL, abi.encode(by));
    }
    function fold(uint8 by) internal pure returns (bytes memory) {
        return abi.encode(MOVE_FOLD, abi.encode(by));
    }
    function showdown(uint8 cardA, uint8 cardB) internal pure returns (bytes memory) {
        return abi.encode(MOVE_SHOWDOWN, abi.encode(cardA, cardB));
    }

    /// A fresh DEAL-phase state (the engine's starting point before DEAL_DONE seats the antes).
    function freshDeal(uint256 ante) internal pure returns (bytes memory) {
        HiLo memory s;
        s.phase = PHASE_DEAL;
        s.ante = ante;
        return abi.encode(s);
    }
}

/// @notice Drives HiLoWarRules — a PURE rules contract — by holding the current abi-encoded HiLo
/// state and applying fuzzed, well-formed moves that advance a hand exactly as the engine would.
/// Each action binds its selectors, builds a legal move, and on the success path decodes the
/// returned bytes and stores it as the new state (illegal moves revert and leave state untouched,
/// absorbed by fail_on_revert = false). Per-seat bet salts are mirrored so a legal BET_OPEN can
/// present the matching salt for its earlier commit. When a hand reaches FLIP_DONE (or the deal
/// pointer otherwise can't advance) the handler resets to a fresh DEAL state with a new fuzzed ante.
contract HiLoHandler is Test {
    using HiLoCodec for *;

    HiLoWarRules public rules;
    bytes public state;

    // Per-hand bet bookkeeping so BET_OPEN can replay the matching salt for an earlier commit.
    bytes32 internal saltA;
    bytes32 internal saltB;
    uint8 internal betChoiceA; // the bet (RAISE/HOLD) committed by A, 0 if none
    uint8 internal betChoiceB;
    // Per-hand "table bet" both seats lean toward at commit time. Making the two seats *sometimes*
    // commit the SAME bet is what opens the SHOWDOWN branch (matched opens) instead of always
    // landing in CALL_OR_FOLD — without it the random walk almost never reaches SHOWDOWN. The
    // fuzzer still steers RAISE-vs-HOLD via betSel, so both the matched (showdown) and mismatched
    // (call/fold) resolutions stay reachable.
    uint8 internal handBet;

    // Ghost: the ante of the hand currently in `state`, captured at every reset. Used by
    // invariant_anteConstant to prove applyMove never mutates the ante mid-hand.
    uint256 public handAnte;
    uint256 internal saltNonce;

    // Phase-coverage ghosts: how often the stored state has rested in each phase after a successful
    // move (and terminal/reset counters). Lets the campaign prove it reaches deep phases + terminals.
    uint256[8] public phaseHits;
    uint256 public terminalHits; // hands that reached FLIP_DONE
    uint256 public resets;
    uint256 public stuckResets;

    // Liveness guard: if too many consecutive actions make no forward progress (every selector the
    // fuzzer tried reverted out of the current phase), abandon the hand and re-deal. Without this
    // the campaign can wedge in a partially-advanced phase and never reach terminals.
    uint256 internal noProgress;
    uint256 internal constant STUCK_LIMIT = 40;

    constructor(HiLoWarRules _rules) {
        rules = _rules;
        _reset(1);
    }

    function _reset(uint256 anteSeed) internal {
        uint256 ante = bound(anteSeed, 1, 1_000_000 ether);
        handAnte = ante;
        saltA = bytes32(0);
        saltB = bytes32(0);
        betChoiceA = 0;
        betChoiceB = 0;
        handBet = (anteSeed % 2 == 0) ? HiLoCodec.BET_RAISE : HiLoCodec.BET_HOLD;
        state = HiLoCodec.freshDeal(ante);
        resets++;
        phaseHits[HiLoCodec.PHASE_DEAL]++;
    }

    function _cur() internal view returns (HiLo memory) {
        return abi.decode(state, (HiLo));
    }

    /// Store a successful transition's output and record phase coverage. If the hand terminated
    /// (FLIP_DONE), reset to a new hand so the campaign keeps generating fresh deals.
    function _store(bytes memory out, uint256 anteSeed) internal {
        state = out;
        noProgress = 0; // a successful transition is forward progress
        HiLo memory s = abi.decode(out, (HiLo));
        if (s.phase < 8) phaseHits[s.phase]++;
        if (s.phase == HiLoCodec.PHASE_FLIP_DONE) {
            terminalHits++;
            _reset(anteSeed);
        }
    }

    /// Called at the top of every action. If the hand has stalled for STUCK_LIMIT actions without a
    /// successful transition, abandon it and re-deal (the task's "or gets stuck" reset). Returns true
    /// if it re-dealt this tick (the caller then skips its own move — the state just changed).
    function _tick(uint256 anteSeed) internal returns (bool) {
        if (noProgress >= STUCK_LIMIT) {
            stuckResets++;
            _reset(anteSeed);
            return true;
        }
        noProgress++;
        return false;
    }

    function _seat(uint8 sel) internal pure returns (uint8) {
        return (sel % 2 == 0) ? HiLoCodec.SEAT_A : HiLoCodec.SEAT_B;
    }

    function doDealDone(uint256 anteSeed) public {
        if (_tick(anteSeed)) return;
        try rules.applyMove(state, HiLoCodec.dealDone()) returns (bytes memory out) {
            _store(out, anteSeed);
        } catch {}
    }

    /// Commit one seat's bet, recording its salt+choice. Returns true if it advanced the state.
    function _commitSeat(uint8 by, uint8 bet) internal returns (bool) {
        bytes32 salt = keccak256(abi.encode("hilo-salt", saltNonce++, by, bet));
        bytes32 commitment = HiLoCodec.betCommitHash(bet, salt);
        try rules.applyMove(state, HiLoCodec.betCommit(by, commitment)) returns (bytes memory out) {
            if (by == HiLoCodec.SEAT_A) { saltA = salt; betChoiceA = bet; }
            else { saltB = salt; betChoiceB = bet; }
            _store(out, 0);
            return true;
        } catch { return false; }
    }

    /// Open one seat's earlier commit (replaying its stored salt). Returns true if it advanced.
    function _openSeat(uint8 by) internal returns (bool) {
        (uint8 bet, bytes32 salt) = by == HiLoCodec.SEAT_A ? (betChoiceA, saltA) : (betChoiceB, saltB);
        if (bet == 0) return false;
        try rules.applyMove(state, HiLoCodec.betOpen(by, bet, salt)) returns (bytes memory out) {
            _store(out, 0);
            return true;
        } catch { return false; }
    }

    /// Commits the seat the fuzzer points at, then opportunistically commits the other missing seat
    /// so the hand reliably reaches BET_OPEN. The fuzzer's betSel decides whether the two seats match
    /// (=> SHOWDOWN branch on opens) or diverge (=> CALL_OR_FOLD), keeping both resolutions reachable;
    /// the per-seat AlreadyMoved/WrongPhase guards are still exercised by repeated/out-of-phase calls.
    function doBetCommit(uint8 seatSel, uint8 betSel, uint256 anteSeed) public {
        if (_tick(anteSeed)) return;
        HiLo memory cur = _cur();
        // betSel low bit: 0 => both seats follow handBet (matched), 1 => second seat diverges.
        uint8 betFirst = handBet;
        uint8 betOther = (betSel % 2 == 0)
            ? handBet
            : (handBet == HiLoCodec.BET_RAISE ? HiLoCodec.BET_HOLD : HiLoCodec.BET_RAISE);

        uint8 first = _seat(seatSel);
        uint8 other = first == HiLoCodec.SEAT_A ? HiLoCodec.SEAT_B : HiLoCodec.SEAT_A;
        // _commitSeat reverts (caught) on a repeat/out-of-phase call, exercising the AlreadyMoved /
        // WrongPhase guards; its bool return is intentionally ignored here.
        _commitSeat(first, betFirst);

        // opportunistically commit the other seat so the pair completes
        HiLo memory cur2 = _cur();
        if (other == HiLoCodec.SEAT_A && cur2.commitA == bytes32(0)) _commitSeat(HiLoCodec.SEAT_A, betOther);
        else if (other == HiLoCodec.SEAT_B && cur2.commitB == bytes32(0)) _commitSeat(HiLoCodec.SEAT_B, betOther);
    }

    /// Opens the seat the fuzzer points at, then opportunistically opens the other so the betting
    /// resolves (into SHOWDOWN or CALL_OR_FOLD per the committed bets).
    function doBetOpen(uint8 seatSel, uint256 anteSeed) public {
        if (_tick(anteSeed)) return;
        HiLo memory cur = _cur();
        uint8 first = _seat(seatSel);
        uint8 other = first == HiLoCodec.SEAT_A ? HiLoCodec.SEAT_B : HiLoCodec.SEAT_A;
        if (first == HiLoCodec.SEAT_A ? cur.betA == 0 : cur.betB == 0) _openSeat(first);
        else _openSeat(first); // exercises AlreadyMoved/WrongPhase guard
        HiLo memory cur2 = _cur();
        if (other == HiLoCodec.SEAT_A ? cur2.betA == 0 : cur2.betB == 0) {
            // only open the other while still in BET_OPEN (a resolved open changed the phase)
            if (cur2.phase == HiLoCodec.PHASE_BET_OPEN) _openSeat(other);
        }
    }

    /// The non-raiser owes call/fold; targeting them makes the action advance instead of bouncing
    /// off IllegalMove (the raiser can't call/fold their own raise).
    function _nonRaiser(uint8 seatSel) internal view returns (uint8) {
        uint8 r = _cur().raiser;
        if (r == HiLoCodec.SEAT_A) return HiLoCodec.SEAT_B;
        if (r == HiLoCodec.SEAT_B) return HiLoCodec.SEAT_A;
        return _seat(seatSel);
    }

    function doCall(uint8 seatSel, uint256 anteSeed) public {
        if (_tick(anteSeed)) return;
        uint8 by = _nonRaiser(seatSel);
        try rules.applyMove(state, HiLoCodec.callMove(by)) returns (bytes memory out) {
            _store(out, anteSeed);
        } catch {}
    }

    function doFold(uint8 seatSel, uint256 anteSeed) public {
        if (_tick(anteSeed)) return;
        uint8 by = _nonRaiser(seatSel);
        try rules.applyMove(state, HiLoCodec.fold(by)) returns (bytes memory out) {
            _store(out, anteSeed);
        } catch {}
    }

    function doShowdown(uint8 cardA, uint8 cardB, uint256 anteSeed) public {
        if (_tick(anteSeed)) return;
        uint8 a = cardA % 52;
        uint8 b = cardB % 52;
        if (a == b) b = uint8((uint16(b) + 1) % 52); // keep distinct so decisive/tie paths both fire
        try rules.applyMove(state, HiLoCodec.showdown(a, b)) returns (bytes memory out) {
            _store(out, anteSeed);
        } catch {}
    }

    /// Feed a deliberately malformed / out-of-phase move. It MUST revert and leave state untouched.
    function doIllegal(uint8 variant, uint256 anteSeed) public {
        if (_tick(anteSeed)) return;
        bytes memory before = state;
        bytes memory bad;
        uint8 v = variant % 4;
        if (v == 0) {
            bad = abi.encode(uint8(99), bytes("")); // unknown move kind
        } else if (v == 1) {
            bad = HiLoCodec.callMove(uint8(7)); // bad seat code
        } else if (v == 2) {
            bad = HiLoCodec.showdown(uint8(200), uint8(3)); // out-of-range card (BadCard if SHOWDOWN)
        } else {
            // A DEAL_DONE is only legal in PHASE_DEAL; from any other phase it's a WrongPhase.
            bad = HiLoCodec.dealDone();
        }
        try rules.applyMove(state, bad) returns (bytes memory out) {
            // Some "illegal" variants are coincidentally legal in the current phase (e.g. v==3 while
            // we happen to be in DEAL, or v==2 in SHOWDOWN). Those are real transitions — accept and
            // advance rather than asserting a false invariant.
            _store(out, anteSeed);
        } catch {
            assertEq0(state, before, "reverting illegal move must not mutate state");
        }
    }
}

/// Stateful invariant suite: a single handler advances hands through every phase and the invariants
/// assert money-conservation, phase well-formedness, and ante-constancy over the whole campaign.
contract HiLoWarRulesInvariantTest is StdInvariant, Test {
    HiLoWarRules internal rules;
    HiLoHandler internal handler;

    function setUp() public {
        rules = new HiLoWarRules(address(0xBEEF), address(0xCAFE));
        handler = new HiLoHandler(rules);
        targetContract(address(handler));
    }

    /// Core accounting truth: across DEAL / BET / CALL / FOLD / SHOWDOWN / tie-carry, every wei a
    /// seat contributed is either still live in the pot (or carried into warPot on a tie) or has
    /// been booked into a set result. Nothing is conjured or destroyed.
    function invariant_moneyConservation() public view {
        HiLo memory s = abi.decode(handler.state(), (HiLo));
        uint256 owed = s.pot + s.warPot + (s.resultSet ? s.resultAmount : 0);
        assertEq(s.contributedA + s.contributedB, owed, "contributed == live pot/war + settled result");
    }

    /// applyMove never yields SETTLED (=7); that's the channel layer's. All enum-like fields stay in
    /// their declared domains.
    function invariant_phaseWellFormed() public view {
        HiLo memory s = abi.decode(handler.state(), (HiLo));
        assertLe(s.phase, 6, "applyMove output phase <= FLIP_DONE");
        assertLe(s.betA, 2, "betA in {0,1,2}");
        assertLe(s.betB, 2, "betB in {0,1,2}");
        assertLe(s.raiser, 2, "raiser in {0,1,2}");
        assertLe(s.resultWinner, 2, "resultWinner in {0,1,2}");
    }

    /// applyMove never mutates the ante within a hand; the handler captures it at each reset.
    function invariant_anteConstant() public view {
        HiLo memory s = abi.decode(handler.state(), (HiLo));
        assertEq(s.ante, handler.handAnte(), "ante constant within a hand");
    }

    /// Phase-coverage probe. NOT an assertion: forge shrinks a failing invariant to a minimal call
    /// sequence, and any "must reach deep phase" assertion placed here would always shrink-fail on a
    /// 1-call sequence (afterInvariant re-runs during shrinking). So this only *emits* the cumulative
    /// per-phase reach counts — run with `-vv` to confirm the campaign drove hands through BET_OPEN /
    /// CALL_OR_FOLD / SHOWDOWN to FLIP_DONE terminals rather than just churning DEAL. Verified across
    /// fuzz seeds 1/2/3/7/42/100/999/12345/88888/555: every phase reached, >=1 terminal, every run.
    /// Genuine coverage is also pinned by the deterministic test_fullHandToShowdown/ToFold unit tests.
    function afterInvariant() public {
        emit log_named_uint("resets", handler.resets());
        emit log_named_uint("terminalHits", handler.terminalHits());
        emit log_named_uint("hit_BET_COMMIT", handler.phaseHits(HiLoCodec.PHASE_BET_COMMIT));
        emit log_named_uint("hit_BET_OPEN", handler.phaseHits(HiLoCodec.PHASE_BET_OPEN));
        emit log_named_uint("hit_CALL_OR_FOLD", handler.phaseHits(HiLoCodec.PHASE_CALL_OR_FOLD));
        emit log_named_uint("hit_SHOWDOWN", handler.phaseHits(HiLoCodec.PHASE_SHOWDOWN));
        emit log_named_uint("hit_FLIP_DONE", handler.phaseHits(HiLoCodec.PHASE_FLIP_DONE));
    }
}

/// Stateless fuzz: properties of applyMove / whoseTurn over arbitrary and targeted inputs.
contract HiLoWarRulesFuzzTest is Test {
    using HiLoCodec for *;

    HiLoWarRules internal rules;

    function setUp() public {
        rules = new HiLoWarRules(address(0xBEEF), address(0xCAFE));
    }

    function _conserves(HiLo memory s) internal pure returns (bool) {
        uint256 owed = s.pot + s.warPot + (s.resultSet ? s.resultAmount : 0);
        return s.contributedA + s.contributedB == owed;
    }

    /// Sanity: a full hand drives DEAL -> BET_COMMIT -> BET_OPEN -> SHOWDOWN -> FLIP_DONE with both
    /// seats holding (matched opens => SHOWDOWN branch), conserving money at every step. Doubles as
    /// documentation of the exact move-encoding the handler replays.
    function test_fullHandToShowdown() public view {
        bytes32 sA = keccak256("A");
        bytes32 sB = keccak256("B");
        bytes memory st = HiLoCodec.freshDeal(1 ether);

        st = rules.applyMove(st, HiLoCodec.dealDone());
        assertEq(abi.decode(st, (HiLo)).phase, HiLoCodec.PHASE_BET_COMMIT, "deal -> commit");

        st = rules.applyMove(st, HiLoCodec.betCommit(HiLoCodec.SEAT_A, HiLoCodec.betCommitHash(HiLoCodec.BET_HOLD, sA)));
        st = rules.applyMove(st, HiLoCodec.betCommit(HiLoCodec.SEAT_B, HiLoCodec.betCommitHash(HiLoCodec.BET_HOLD, sB)));
        assertEq(abi.decode(st, (HiLo)).phase, HiLoCodec.PHASE_BET_OPEN, "both commit -> open");

        st = rules.applyMove(st, HiLoCodec.betOpen(HiLoCodec.SEAT_A, HiLoCodec.BET_HOLD, sA));
        st = rules.applyMove(st, HiLoCodec.betOpen(HiLoCodec.SEAT_B, HiLoCodec.BET_HOLD, sB));
        assertEq(abi.decode(st, (HiLo)).phase, HiLoCodec.PHASE_SHOWDOWN, "matched holds -> showdown");

        st = rules.applyMove(st, HiLoCodec.showdown(40, 4)); // distinct ranks -> decisive
        HiLo memory fin = abi.decode(st, (HiLo));
        assertEq(fin.phase, HiLoCodec.PHASE_FLIP_DONE, "showdown -> flip done");
        assertTrue(_conserves(fin), "full hand conserves money");
    }

    /// Sanity: a mismatched open (A raises, B holds) routes to CALL_OR_FOLD, and a fold by the
    /// non-raiser drains pot+war into the raiser's result.
    function test_fullHandToFold() public view {
        bytes32 sA = keccak256("A");
        bytes32 sB = keccak256("B");
        bytes memory st = HiLoCodec.freshDeal(1 ether);
        st = rules.applyMove(st, HiLoCodec.dealDone());
        st = rules.applyMove(st, HiLoCodec.betCommit(HiLoCodec.SEAT_A, HiLoCodec.betCommitHash(HiLoCodec.BET_RAISE, sA)));
        st = rules.applyMove(st, HiLoCodec.betCommit(HiLoCodec.SEAT_B, HiLoCodec.betCommitHash(HiLoCodec.BET_HOLD, sB)));
        st = rules.applyMove(st, HiLoCodec.betOpen(HiLoCodec.SEAT_A, HiLoCodec.BET_RAISE, sA));
        st = rules.applyMove(st, HiLoCodec.betOpen(HiLoCodec.SEAT_B, HiLoCodec.BET_HOLD, sB));
        assertEq(abi.decode(st, (HiLo)).phase, HiLoCodec.PHASE_CALL_OR_FOLD, "mismatch -> call/fold");
        st = rules.applyMove(st, HiLoCodec.fold(HiLoCodec.SEAT_B)); // non-raiser folds
        HiLo memory fin = abi.decode(st, (HiLo));
        assertEq(fin.phase, HiLoCodec.PHASE_FLIP_DONE, "fold ends hand");
        assertEq(fin.resultWinner, HiLoCodec.SEAT_A, "raiser wins on fold");
        assertTrue(_conserves(fin), "fold conserves money");
    }

    /// For ANY bytes inputs: if applyMove returns (most random inputs revert — that's fine), the
    /// output decodes cleanly to a 16-field HiLo with phase <= 7 and money-conservation intact.
    /// applyMove never returns a corrupt / inconsistent state.
    function testFuzz_applyMoveNeverCorrupts(bytes calldata gameState, bytes calldata move) public view {
        try rules.applyMove(gameState, move) returns (bytes memory out) {
            HiLo memory s = abi.decode(out, (HiLo));
            assertLe(s.phase, 7, "output phase in range");
            assertTrue(_conserves(s), "output money-conserved");
        } catch {}
    }

    /// A BET_OPEN whose salt matches the committed `_betCommitHash` is accepted; a corrupted salt
    /// is rejected with CommitMismatch.
    function testFuzz_betCommitRoundTrip(uint8 betSel, bytes32 salt) public {
        uint8 bet = (betSel % 2 == 0) ? HiLoCodec.BET_RAISE : HiLoCodec.BET_HOLD;
        bytes32 commitment = HiLoCodec.betCommitHash(bet, salt);

        // BET_OPEN phase with A's commit set to the matching commitment; B already committed+held so
        // resolution doesn't depend on B (B holds; A's open completes the pair only after A opens).
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_BET_OPEN;
        s.ante = 1 ether;
        s.pot = 2 ether;
        s.contributedA = 1 ether;
        s.contributedB = 1 ether;
        s.commitA = commitment;
        bytes memory enc = abi.encode(s);

        // matching salt accepted
        bytes memory out = rules.applyMove(enc, HiLoCodec.betOpen(HiLoCodec.SEAT_A, bet, salt));
        HiLo memory after_ = abi.decode(out, (HiLo));
        assertEq(after_.betA, bet, "A's bet recorded on a matching open");

        // corrupted salt rejected
        bytes32 badSalt = bytes32(uint256(salt) ^ 1);
        vm.expectRevert(HiLoWarRules.CommitMismatch.selector);
        rules.applyMove(enc, HiLoCodec.betOpen(HiLoCodec.SEAT_A, bet, badSalt));
    }

    /// From a SHOWDOWN-phase state: distinct in-range cards resolve (decisive sets resultWinner by
    /// rank, a same-rank tie carries pot into warPot with no result); out-of-range or equal cards
    /// revert BadCard.
    function testFuzz_showdownCardBounds(uint8 cardA, uint8 cardB) public {
        HiLo memory s;
        s.phase = HiLoCodec.PHASE_SHOWDOWN;
        s.ante = 1 ether;
        s.pot = 2 ether;
        s.contributedA = 1 ether;
        s.contributedB = 1 ether;
        bytes memory enc = abi.encode(s);

        if (cardA > 51 || cardB > 51 || cardA == cardB) {
            vm.expectRevert(HiLoWarRules.BadCard.selector);
            rules.applyMove(enc, HiLoCodec.showdown(cardA, cardB));
            return;
        }

        bytes memory out = rules.applyMove(enc, HiLoCodec.showdown(cardA, cardB));
        HiLo memory r = abi.decode(out, (HiLo));
        assertEq(r.phase, HiLoCodec.PHASE_FLIP_DONE, "showdown ends the hand");
        assertTrue(_conserves(r), "showdown conserves money");

        uint8 rankA = cardA / 4;
        uint8 rankB = cardB / 4;
        if (rankA == rankB) {
            assertEq(r.warPot, 2 ether, "tie carries pot into warPot");
            assertEq(r.pot, 0, "tie clears pot");
            assertFalse(r.resultSet, "tie leaves result unset");
            assertEq(r.resultWinner, 0, "tie has no winner");
        } else {
            uint8 want = rankA > rankB ? HiLoCodec.SEAT_A : HiLoCodec.SEAT_B;
            assertEq(r.resultWinner, want, "higher rank wins");
            assertTrue(r.resultSet, "decisive sets result");
            assertEq(r.resultAmount, 2 ether, "winner takes pot+war");
            assertEq(r.pot, 0, "decisive clears pot");
            assertEq(r.warPot, 0, "decisive clears warPot");
        }
    }

    /// whoseTurn returns a 2-bit mask (<= 3) for any input that decodes (non-decoding inputs revert,
    /// absorbed). The protocol never owes more than the two seats.
    function testFuzz_whoseTurnMaskBounds(bytes calldata gameState) public view {
        try rules.whoseTurn(gameState) returns (uint8 mask) {
            assertLe(mask, 3, "whoseTurn mask <= 3");
        } catch {}
    }
}

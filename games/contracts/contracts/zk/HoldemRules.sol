// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IGameRulesN} from "./IGameRulesN.sol";
import {HoldemHandEval} from "./HoldemHandEval.sol";

/// @notice Pure mirror of @gibs/holdem src/rules.ts applyMove (betting half) — consulted only
/// by HoldemTableN's per-seat dispute machine. The TS module is normative; test/HoldemParity
/// .test.ts fuzzes the two against each other over seeded walks. Encodings are the canonical
/// abi tuples shared with examples/games/holdem/src/encoding.ts.
///
/// @dev Trust boundary: the caller (HoldemTableN) only ever passes a gameState/move encoding
/// that hashes to a state every live seat co-signed, so this contract trusts structural
/// validity and enforces only *transition* legality. Showdown winner selection + rake (Task
/// 6/7) are NOT implemented: the only showdown handled here is an uncontested hand (single
/// live seat), which the betting layer resolves by sweeping the pot to that seat (the same
/// STUB as rules.ts `finishHand`). A multiway SHOWDOWN is terminal for this rules contract.
contract HoldemRules is IGameRulesN, HoldemHandEval {
    error WrongPhase();
    error NotYourTurn();
    error FoldedSeat();
    error AllInSeat();
    error BadBlind();
    error CannotCheck();
    error NothingToCall();
    error BelowMinRaise();
    error MustExceedBet();
    error CannotReopen();
    error BadSeat();
    error IllegalMove();

    // Phases (mirror rules.ts Phase enum).
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

    uint8 internal constant NONE = 0xff; // encodes -1 (no seat)

    // Move tags (mirror encoding.ts MOVE_KIND).
    uint8 internal constant MOVE_POST_BLIND = 0;
    uint8 internal constant MOVE_CHECK = 1;
    uint8 internal constant MOVE_CALL = 2;
    uint8 internal constant MOVE_FOLD = 3;
    uint8 internal constant MOVE_BET = 4;
    uint8 internal constant MOVE_RAISE = 5;
    uint8 internal constant MOVE_DEAL_DONE = 6;
    uint8 internal constant MOVE_SHOWDOWN = 7;

    struct SidePot {
        uint256 amount;
        uint256 eligibleMask;
    }

    /// Mirrors encoding.ts GAME_STATE_ABI field-for-field.
    struct Holdem {
        uint8 phase;
        uint8 nSeats;
        uint8 button;
        uint8 toAct;
        uint256[] stacks;
        uint256[] committed;
        uint256[] totalContributed;
        bool[] folded;
        bool[] allIn;
        bool[] actedSinceAggression;
        uint256 currentBet;
        uint256 minRaise;
        uint8 lastAggressor;
        uint256 pot;
        SidePot[] sidePots;
        uint256 smallBlind;
        uint256 bigBlind;
        uint16 rakeBps;
        uint256 rakeCap;
        uint8 stubWinner;
        uint256 rakeAccrued;
    }

    function gameId() external pure returns (uint16) {
        return 2;
    }

    function hashGameState(bytes calldata gameState) external pure returns (bytes32) {
        return keccak256(gameState);
    }

    function isFinal(uint8 phase) external pure returns (bool) {
        return phase == SETTLED;
    }

    /// Bit i set => seat i owes the next protocol action. In a BET_* phase exactly `toAct`;
    /// in SETUP/SHUFFLE/DEAL_* every non-folded seat; SHOWDOWN/SETTLED nobody.
    function whoseTurn(bytes calldata gameState) external pure returns (uint256 mask) {
        Holdem memory s = abi.decode(gameState, (Holdem));
        if (s.phase == BET_PREFLOP || s.phase == BET_FLOP || s.phase == BET_TURN || s.phase == BET_RIVER) {
            return s.toAct == NONE ? 0 : (uint256(1) << s.toAct);
        }
        if (s.phase == SHOWDOWN || s.phase == SETTLED) return 0;
        for (uint256 i = 0; i < s.nSeats; i++) {
            if (!s.folded[i]) mask |= (uint256(1) << i);
        }
    }

    function applyMove(bytes calldata gameState, bytes calldata move) external pure returns (bytes memory) {
        Holdem memory s = abi.decode(gameState, (Holdem));
        (uint8 kind, bytes memory payload) = abi.decode(move, (uint8, bytes));

        if (kind == MOVE_DEAL_DONE) {
            return abi.encode(_dealDone(s));
        }

        if (kind == MOVE_SHOWDOWN) {
            if (s.phase != SHOWDOWN) revert WrongPhase();
            (uint8[2][] memory holes, uint8[5] memory board) = abi.decode(payload, (uint8[2][], uint8[5]));
            return abi.encode(_showdown(s, holes, board));
        }

        if (s.phase != BET_PREFLOP && s.phase != BET_FLOP && s.phase != BET_TURN && s.phase != BET_RIVER) {
            revert WrongPhase();
        }

        uint8 seat = _seatOf(payload);
        if (seat >= s.nSeats) revert BadSeat();

        if (kind == MOVE_POST_BLIND) {
            (, uint256 amount) = abi.decode(payload, (uint8, uint256));
            return abi.encode(_postBlind(s, seat, amount));
        }

        // Real betting action: in turn, seat able to act. PRE-FLOP additionally requires both
        // blinds posted (the big blind opening the action); post-flop streets start at 0/0.
        if (s.phase == BET_PREFLOP && s.currentBet < s.bigBlind) revert BadBlind(); // "blinds not posted"
        if (seat != s.toAct) revert NotYourTurn();
        if (s.folded[seat]) revert FoldedSeat();
        if (s.allIn[seat]) revert AllInSeat();

        uint256 toCall = s.currentBet - s.committed[seat];

        if (kind == MOVE_FOLD) {
            s.folded[seat] = true;
            s.actedSinceAggression[seat] = true;
            return abi.encode(_advance(s, seat));
        }
        if (kind == MOVE_CHECK) {
            if (toCall != 0) revert CannotCheck();
            s.actedSinceAggression[seat] = true;
            return abi.encode(_advance(s, seat));
        }
        if (kind == MOVE_CALL) {
            if (toCall == 0) revert NothingToCall();
            uint256 pay = toCall < s.stacks[seat] ? toCall : s.stacks[seat];
            _putIn(s, seat, pay);
            s.actedSinceAggression[seat] = true;
            return abi.encode(_advance(s, seat));
        }
        if (kind == MOVE_BET || kind == MOVE_RAISE) {
            (, uint256 to) = abi.decode(payload, (uint8, uint256));
            return abi.encode(_betRaise(s, seat, to));
        }
        revert IllegalMove();
    }

    // ----- transitions (mirror rules.ts) -----

    function _dealDone(Holdem memory s) internal pure returns (Holdem memory) {
        if (s.phase != DEAL_HOLE && s.phase != DEAL_FLOP && s.phase != DEAL_TURN && s.phase != DEAL_RIVER) {
            revert WrongPhase();
        }
        if (s.phase == DEAL_HOLE) s.phase = BET_PREFLOP;
        else s.phase = s.phase + 1;
        s.toAct = _firstLiveLeftOfButton(s);
        // Run-out: no betting on a street where <=1 seat can voluntarily act and all are
        // matched — close it through to the next deal phase / showdown.
        if (_actableCount(s) <= 1 && _allMatchedOrAllIn(s)) _closeStreet(s);
        return s;
    }

    function _postBlind(Holdem memory s, uint8 seat, uint256 amount) internal pure returns (Holdem memory) {
        if (s.phase != BET_PREFLOP) revert WrongPhase();
        if (seat != s.toAct) revert NotYourTurn();
        bool expectSb = _allZero(s.committed);
        uint256 requiredBlind = expectSb ? s.smallBlind : s.bigBlind;
        // Short all-in blind (mirror rules.ts): a seat that can't cover its blind posts its
        // whole stack and is all-in. Must post exactly min(stack, requiredBlind).
        uint256 expected = requiredBlind < s.stacks[seat] ? requiredBlind : s.stacks[seat];
        if (amount != expected) revert BadBlind();
        _putIn(s, seat, amount); // marks all-in if it empties the stack
        if (!expectSb) {
            // BB posted: the action level is the FULL big blind even if the BB is short
            // (all-in for less); later seats still owe the full blind to call.
            s.currentBet = s.bigBlind;
            s.minRaise = s.bigBlind;
            s.toAct = _nextToAct(s, seat);
        } else {
            s.toAct = _nextToAct(s, seat);
        }
        return s;
    }

    function _betRaise(Holdem memory s, uint8 seat, uint256 to) internal pure returns (Holdem memory) {
        // incomplete-raise reopen guard
        if (s.actedSinceAggression[seat] && s.currentBet > s.committed[seat]) revert CannotReopen();
        uint256 already = s.committed[seat];
        if (to <= s.currentBet) revert MustExceedBet();
        uint256 need = to - already;
        if (need == 0) revert MustExceedBet();
        uint256 stack = s.stacks[seat];
        bool isAllIn = need >= stack;
        uint256 actualAdd = isAllIn ? stack : need;
        uint256 actualTarget = already + actualAdd;
        // A short all-in whose stack-capped total does not exceed the current bet is an all-in
        // call for less, not a bet/raise — reject (mirror rules.ts). This also guards the
        // `increment` subtraction below from a uint256 underflow.
        if (actualTarget <= s.currentBet) revert MustExceedBet();
        uint256 increment = actualTarget - s.currentBet;
        if (!isAllIn && increment < s.minRaise) revert BelowMinRaise();
        bool isFullRaise = increment >= s.minRaise;
        _putIn(s, seat, actualAdd);
        s.currentBet = actualTarget;
        if (isFullRaise) {
            s.minRaise = increment;
            s.lastAggressor = seat;
            for (uint256 i = 0; i < s.nSeats; i++) s.actedSinceAggression[i] = false;
        }
        s.actedSinceAggression[seat] = true;
        return _advance(s, seat);
    }

    // ----- helpers (mirror rules.ts) -----

    function _seatOf(bytes memory payload) internal pure returns (uint8 seat) {
        // every betting payload starts with a uint8 seat; POST_BLIND/BET/RAISE append a
        // uint256 but the leading 32-byte word still decodes as the seat.
        seat = abi.decode(payload, (uint8));
    }

    function _allZero(uint256[] memory xs) internal pure returns (bool) {
        for (uint256 i = 0; i < xs.length; i++) if (xs[i] != 0) return false;
        return true;
    }

    function _putIn(Holdem memory s, uint8 seat, uint256 amount) internal pure {
        // mirrors rules.ts putIn: move chips stack->committed+totalContributed, mark all-in,
        // then recompute pots from totalContributed+folded.
        require(amount <= s.stacks[seat], "insufficient stack");
        s.stacks[seat] -= amount;
        s.committed[seat] += amount;
        s.totalContributed[seat] += amount;
        if (s.stacks[seat] == 0) s.allIn[seat] = true;
        _recomputePots(s);
    }

    function _liveCount(Holdem memory s) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < s.nSeats; i++) if (!s.folded[i]) n++;
    }

    function _actableCount(Holdem memory s) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < s.nSeats; i++) if (!s.folded[i] && !s.allIn[i]) n++;
    }

    function _allMatchedOrAllIn(Holdem memory s) internal pure returns (bool) {
        for (uint256 i = 0; i < s.nSeats; i++) {
            if (s.folded[i] || s.allIn[i]) continue;
            if (s.committed[i] != s.currentBet) return false;
        }
        return true;
    }

    function _nextToAct(Holdem memory s, uint8 from) internal pure returns (uint8) {
        for (uint256 k = 1; k <= s.nSeats; k++) {
            uint8 seat = uint8((from + k) % s.nSeats);
            if (!s.folded[seat] && !s.allIn[seat]) return seat;
        }
        return NONE;
    }

    function _firstLiveLeftOfButton(Holdem memory s) internal pure returns (uint8) {
        for (uint256 k = 1; k <= s.nSeats; k++) {
            uint8 seat = uint8((s.button + k) % s.nSeats);
            if (!s.folded[seat] && !s.allIn[seat]) return seat;
        }
        return NONE;
    }

    function _roundClosed(Holdem memory s) internal pure returns (bool) {
        if (_liveCount(s) <= 1) return true;
        if (_actableCount(s) == 0) return true;
        for (uint256 i = 0; i < s.nSeats; i++) {
            if (s.folded[i] || s.allIn[i]) continue;
            if (s.committed[i] != s.currentBet) return false;
            if (!s.actedSinceAggression[i]) return false;
        }
        return true;
    }

    function _advance(Holdem memory s, uint8 from) internal pure returns (Holdem memory) {
        _recomputePots(s);
        if (_roundClosed(s)) {
            _closeStreet(s);
            return s;
        }
        uint8 next = _nextToAct(s, from);
        if (next == NONE) {
            _closeStreet(s);
            return s;
        }
        s.toAct = next;
        return s;
    }

    function _closeStreet(Holdem memory s) internal pure {
        _returnUncalled(s);
        _recomputePots(s);
        if (_liveCount(s) <= 1) {
            _finishHand(s);
            return;
        }
        for (uint256 i = 0; i < s.nSeats; i++) s.committed[i] = 0;
        s.currentBet = 0;
        s.minRaise = s.bigBlind;
        s.lastAggressor = NONE;
        for (uint256 i = 0; i < s.nSeats; i++) s.actedSinceAggression[i] = false;

        if (s.phase == BET_RIVER) {
            _finishHand(s);
            return;
        }
        s.phase = s.phase + 1; // BET_PREFLOP->DEAL_FLOP, etc.
        s.toAct = _firstLiveLeftOfButton(s);
    }

    function _returnUncalled(Holdem memory s) internal pure {
        // highest and second-highest committed this street; refund the lone over-bet's excess.
        int256 hi = -1;
        int256 hiSeat = -1;
        uint256 second = 0;
        for (uint256 i = 0; i < s.nSeats; i++) {
            uint256 c = s.committed[i];
            if (int256(c) > hi) {
                second = hi < 0 ? 0 : uint256(hi);
                hi = int256(c);
                hiSeat = int256(i);
            } else if (c > second) {
                second = c;
            }
        }
        if (hiSeat < 0 || hi <= 0) return;
        uint256 hs = uint256(hiSeat);
        uint256 excess = uint256(hi) - second;
        if (excess > 0) {
            s.committed[hs] = second;
            s.stacks[hs] += excess;
            s.totalContributed[hs] -= excess;
        }
    }

    function _finishHand(Holdem memory s) internal pure {
        _returnUncalled(s);
        _recomputePots(s);
        s.phase = SHOWDOWN;
        s.toAct = NONE;
        // count live seats; if exactly one, sweep all pots to it (the STUB uncontested win).
        uint256 live = 0;
        uint8 lone = NONE;
        for (uint256 i = 0; i < s.nSeats; i++) {
            if (!s.folded[i]) {
                live++;
                lone = uint8(i);
            }
        }
        if (live == 1) {
            uint256 total = s.pot;
            for (uint256 i = 0; i < s.sidePots.length; i++) total += s.sidePots[i].amount;
            s.stacks[lone] += total;
            s.pot = 0;
            s.sidePots = new SidePot[](0);
            s.stubWinner = lone;
        }
        // else multiway showdown: winner decided by the Task 6 evaluator; pots stay put.
    }

    // ----- showdown settlement (Task 7, mirrors rules.ts resolveShowdown/showdownPayouts) -----

    /// Resolve a SHOWDOWN move: award each pot to its best eligible hand(s), apply rake, write
    /// final balances into `stacks`, set rakeAccrued, zero the pots, reach SETTLED. For an
    /// already-swept uncontested hand (stubWinner != NONE) the pots are empty; we still apply
    /// rake to the swept winnings so the channel conservation holds with the rake populated.
    function _showdown(Holdem memory s, uint8[2][] memory holes, uint8[5] memory board)
        internal
        pure
        returns (Holdem memory)
    {
        if (s.stubWinner != NONE) {
            // Uncontested: rake on the whole collected pot (== Σ totalContributed; uncalled
            // already returned), deducted from the winner's swept stack.
            uint256 potBase = 0;
            for (uint256 i = 0; i < s.nSeats; i++) potBase += s.totalContributed[i];
            uint256 rakeU = (uint256(s.rakeBps) * potBase) / 10000;
            if (rakeU > s.rakeCap) rakeU = s.rakeCap;
            s.stacks[s.stubWinner] -= rakeU;
            s.rakeAccrued = rakeU;
            s.phase = SETTLED;
            s.toAct = NONE;
            return s;
        }

        require(board.length == 5, "showdown: board");
        require(holes.length == s.nSeats, "showdown: holes");

        uint8 n = s.nSeats;

        // Per-seat 7-card hand + memoized score (only eligible/non-folded seats are scored).
        uint256[] memory scores = new uint256[](n);
        bool[] memory scored = new bool[](n);

        // Ordered pots: main first, then each side pot. Eligibility intersected with non-folded.
        // pots: amounts[], and a per-pot eligible bitmask (live seats only).
        uint256 nPots = 1 + s.sidePots.length;
        uint256[] memory potAmt = new uint256[](nPots);
        uint256[] memory potMask = new uint256[](nPots); // live-eligible mask per pot
        // main pot: every non-folded seat is eligible.
        potAmt[0] = s.pot;
        {
            uint256 mm = 0;
            for (uint256 i = 0; i < n; i++) if (!s.folded[i]) mm |= (uint256(1) << i);
            potMask[0] = mm;
        }
        for (uint256 k = 0; k < s.sidePots.length; k++) {
            potAmt[k + 1] = s.sidePots[k].amount;
            uint256 mm = 0;
            uint256 src = s.sidePots[k].eligibleMask;
            for (uint256 i = 0; i < n; i++) {
                if (((src >> i) & 1) == 1 && !s.folded[i]) mm |= (uint256(1) << i);
            }
            potMask[k + 1] = mm;
        }

        // Rake base = Σ amounts of contested pots (≥2 eligible). Single-eligible = uncalled, no rake.
        uint256 rakeBase = 0;
        for (uint256 p = 0; p < nPots; p++) {
            if (_popcount(potMask[p]) >= 2) rakeBase += potAmt[p];
        }
        uint256 rake = (uint256(s.rakeBps) * rakeBase) / 10000;
        if (rake > s.rakeCap) rake = s.rakeCap;
        uint256 rakeRemaining = rake;

        uint256[] memory winnings = new uint256[](n);

        for (uint256 p = 0; p < nPots; p++) {
            uint256 amount = potAmt[p];
            uint256 mask = potMask[p];
            uint256 elig = _popcount(mask);
            if (amount == 0 || elig == 0) continue;
            uint256 distributable = amount;
            if (elig >= 2 && rakeRemaining > 0) {
                uint256 take = rakeRemaining < distributable ? rakeRemaining : distributable;
                distributable -= take;
                rakeRemaining -= take;
            }
            if (distributable == 0) continue;

            // Find the best eligible score (scoring lazily, memoized).
            uint256 best = 0;
            bool haveBest = false;
            for (uint256 i = 0; i < n; i++) {
                if (((mask >> i) & 1) == 0) continue;
                if (!scored[i]) {
                    scores[i] = _evaluate7([holes[i][0], holes[i][1], board[0], board[1], board[2], board[3], board[4]]);
                    scored[i] = true;
                }
                if (!haveBest || scores[i] > best) {
                    best = scores[i];
                    haveBest = true;
                }
            }
            // Winners = eligible seats whose score == best (ascending seat order).
            uint256 winMask = 0;
            uint256 winCount = 0;
            for (uint256 i = 0; i < n; i++) {
                if (((mask >> i) & 1) == 1 && scores[i] == best) {
                    winMask |= (uint256(1) << i);
                    winCount++;
                }
            }
            _splitInto(winnings, distributable, winMask, winCount, s.button, n);
        }

        for (uint256 i = 0; i < n; i++) s.stacks[i] += winnings[i];
        s.rakeAccrued = rake;
        s.pot = 0;
        s.sidePots = new SidePot[](0);
        s.phase = SETTLED;
        s.toAct = NONE;
        return s;
    }

    /// Split `amount` among the seats in `winMask`, odd chips to the earliest seat clockwise
    /// from button+1 (mirrors sidePots.ts splitPot). Adds shares into `winnings` in place.
    function _splitInto(
        uint256[] memory winnings,
        uint256 amount,
        uint256 winMask,
        uint256 winCount,
        uint8 button,
        uint8 n
    ) internal pure {
        uint256 base = amount / winCount;
        uint256 remainder = amount - base * winCount; // 0..winCount-1
        // Clockwise order from button+1; the first `remainder` winners each get +1.
        uint256 idx = 0;
        for (uint256 k = 1; k <= n; k++) {
            uint8 seat = uint8((button + k) % n);
            if (((winMask >> seat) & 1) == 1) {
                winnings[seat] += base + (idx < remainder ? 1 : 0);
                idx++;
            }
        }
    }

    function _popcount(uint256 mask) internal pure returns (uint256 c) {
        while (mask != 0) {
            c += mask & 1;
            mask >>= 1;
        }
    }

    /// Recompute pot (bottom layer) + sidePots (higher layers) from totalContributed+folded.
    /// Mirrors buildSidePots: distinct positive levels ascending, layer width * contributors,
    /// dead-money carry forward, and MERGE of adjacent layers with identical eligible sets.
    function _recomputePots(Holdem memory s) internal pure {
        uint8 n = s.nSeats;
        // distinct positive levels ascending (simple insertion since n<=9).
        uint256[] memory levels = new uint256[](n);
        uint256 lc = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 v = s.totalContributed[i];
            if (v == 0) continue;
            // insert if new
            bool seen = false;
            for (uint256 j = 0; j < lc; j++) if (levels[j] == v) { seen = true; break; }
            if (!seen) { levels[lc++] = v; }
        }
        // sort levels[0..lc) ascending
        for (uint256 i = 0; i < lc; i++) {
            for (uint256 j = i + 1; j < lc; j++) {
                if (levels[j] < levels[i]) { (levels[i], levels[j]) = (levels[j], levels[i]); }
            }
        }

        // build layered pots
        uint256[] memory potAmt = new uint256[](lc);
        uint256[] memory potMask = new uint256[](lc);
        uint256 pc = 0;
        uint256 prev = 0;
        uint256 deadCarry = 0;
        for (uint256 li = 0; li < lc; li++) {
            uint256 level = levels[li];
            uint256 width = level - prev;
            uint256 contributors = 0;
            uint256 mask = 0;
            uint256 elig = 0;
            for (uint256 i = 0; i < n; i++) {
                if (s.totalContributed[i] >= level) {
                    contributors++;
                    if (!s.folded[i]) { mask |= (uint256(1) << i); elig++; }
                }
            }
            uint256 amount = width * contributors + deadCarry;
            if (elig == 0) {
                deadCarry = amount;
            } else {
                if (pc > 0 && potMask[pc - 1] == mask) {
                    potAmt[pc - 1] += amount;
                } else {
                    potAmt[pc] = amount;
                    potMask[pc] = mask;
                    pc++;
                }
                deadCarry = 0;
            }
            prev = level;
        }
        if (deadCarry > 0) {
            if (pc > 0) potAmt[pc - 1] += deadCarry;
            else { potAmt[0] = deadCarry; potMask[0] = 0; pc = 1; }
        }

        if (pc == 0) {
            s.pot = 0;
            s.sidePots = new SidePot[](0);
        } else {
            s.pot = potAmt[0];
            SidePot[] memory sp = new SidePot[](pc - 1);
            for (uint256 i = 1; i < pc; i++) {
                sp[i - 1] = SidePot({amount: potAmt[i], eligibleMask: potMask[i]});
            }
            s.sidePots = sp;
        }
    }
}

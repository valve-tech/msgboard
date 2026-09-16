// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GamePayouts} from "../../contracts/games/GamePayouts.sol";

/// Coverage-only follow-up to GamePayoutsUnit.t.sol. Targets the specific branches that survive
/// the rest of the suite (GamePayouts.t.sol / GamePayoutsUnit.t.sol / TablePayouts.t.sol /
/// CardCascadePayouts.t.sol) untouched, measured via `FOUNDRY_PROFILE=cov forge coverage
/// --ir-minimum --report lcov` on this file's package:
///
///   1. `_bankerDrawsAfterPlayerThird` (baccarat's fixed third-card rule): only the bankerTotal==4
///      "draws" case and the bankerTotal==7 "stands" default are hit elsewhere
///      (GamePayoutsUnit.t.sol's `test_baccarat_nonNatural_bankerDraws_hitsDrawRuleBranch` finds
///      whichever seed comes first in a small search range, which happens to be bankerTotal==4).
///      bankerTotal <=2, ==3, ==5 and ==6 are never reached. Each is genuinely reachable through
///      the public `settle(11, ...)` entrypoint given the right shuffle seed `r` — no production
///      code changes needed, just a seed search (same technique GamePayoutsUnit.t.sol already
///      uses for its one draw-rule vector, generalized to target a specific banker total).
///   2. `_rouletteBetWins` even-money branches for black/odd/even/high/low (betType 2..6): the rest
///      of the suite only ever exercises red (betType 1), dozen (7) and column (8) WINS, plus
///      reverts. The other five even-money bet types are validated for their REVERT guards
///      (GamePayoutsUnit.t.sol) but never for an actual win, so `_rouletteBetWins`'s `return true`
///      arm for each of them is untested.
///
/// Every assertion below pins the EXACT (balancePlayer, balanceHouse) split, cross-checked by
/// independently replicating the on-chain shuffle/deal (for baccarat) or the trivial `r % 37`
/// pocket math (for roulette) — not just a conservation check.
contract GamePayoutsCovTest is Test {
    uint256 internal constant STAKE = 200;
    uint256 internal constant HOUSE = 1_000_000; // large enough that no win-path here ever hits the pot ceiling

    // ============================================================================================
    // baccarat (gameId 11): _bankerDrawsAfterPlayerThird bankerTotal buckets <=2, ==3, ==5, ==6.
    // ============================================================================================

    /// Exact duplicate of GamePayouts._shuffle — matching the library algorithm bit-for-bit is the
    /// whole point (same technique as GamePayoutsUnit.t.sol's `_searchDeck`).
    function _shuffle(uint256 r) private pure returns (uint8[52] memory deck) {
        for (uint256 k = 0; k < 52; k++) deck[k] = uint8(k);
        uint256 acc = r;
        for (uint256 i = 51; i >= 1; i--) {
            uint256 window = i + 1;
            uint256 j = acc % window;
            acc = acc / window;
            (deck[i], deck[j]) = (deck[j], deck[i]);
        }
    }

    function _bacVal(uint8 card) private pure returns (uint256) {
        uint256 rk = uint256(card) / 4 + 2;
        if (rk == 14) return 1;
        if (rk >= 10) return 0;
        return rk;
    }

    /// Search hash-derived candidates `r = keccak256(abi.encode(tag, attempt))` for one that lands
    /// in the `_baccarat` "not a natural, player drew a third card" branch with the banker's
    /// pre-draw 2-card total (`bankerTotal`) inside [lo, hi] — i.e. one that will call
    /// `_bankerDrawsAfterPlayerThird` with that specific bankerTotal bucket. Hash-derived candidates
    /// (vs. a plain incrementing r) explore the full shuffle space instead of the narrow family of
    /// permutations small sequential r values produce (small r starves the Fisher–Yates division
    /// chain of entropy for the low deck indices that determine the first four cards dealt).
    function _findBaccaratSeed(uint256 lo, uint256 hi, string memory tag, uint256 maxAttempts)
        private
        pure
        returns (uint256 r)
    {
        for (uint256 a = 0; a < maxAttempts; a++) {
            uint256 cand = uint256(keccak256(abi.encode(tag, a)));
            uint8[52] memory deck = _shuffle(cand);
            uint256 pSum = _bacVal(deck[0]) + _bacVal(deck[2]);
            uint256 bSum = _bacVal(deck[1]) + _bacVal(deck[3]);
            uint256 pt = pSum % 10;
            uint256 bt = bSum % 10;
            if (pt >= 8 || bt >= 8) continue; // natural — not the branch we want
            if (pt > 5) continue; // player would NOT draw a third card — never reaches the helper
            if (bt < lo || bt > hi) continue;
            return cand;
        }
        revert("no qualifying seed found in search range");
    }

    // bankerTotal <= 2 always draws regardless of the player's third-card pip (immune-to-pip arm).
    function test_baccarat_bankerDrawsAfterThird_bankerTotalLE2() public pure {
        uint256 r = _findBaccaratSeed(0, 2, "bankerTotalLE2", 200);
        (uint256 bP, uint256 bH) = GamePayouts.settle(11, r, abi.encode(uint256(0)), STAKE, HOUSE);
        assertEq(bP, 400); // player wins this deal (pt 4 > bt 0 after the banker's own draw)
        assertEq(bH, STAKE + HOUSE - 400);
        assertEq(bP + bH, STAKE + HOUSE);
    }

    // bankerTotal == 3 draws unless the player's third-card pip is exactly 8.
    function test_baccarat_bankerDrawsAfterThird_bankerTotalEQ3() public pure {
        uint256 r = _findBaccaratSeed(3, 3, "bankerTotalEQ3", 200);
        (uint256 bP, uint256 bH) = GamePayouts.settle(11, r, abi.encode(uint256(0)), STAKE, HOUSE);
        assertEq(bP, 400); // player wins this deal (pt 9 > bt 0)
        assertEq(bH, STAKE + HOUSE - 400);
        assertEq(bP + bH, STAKE + HOUSE);
    }

    // bankerTotal == 5 draws only when the player's third-card pip is 4..7.
    function test_baccarat_bankerDrawsAfterThird_bankerTotalEQ5() public pure {
        uint256 r = _findBaccaratSeed(5, 5, "bankerTotalEQ5", 200);
        // this deal resolves as a banker win (pt 0, bt 8 after the banker's own draw), so bet the
        // banker (1) to pin a nonzero payout and exercise the win arithmetic too.
        (uint256 bP, uint256 bH) = GamePayouts.settle(11, r, abi.encode(uint256(1)), STAKE, HOUSE);
        assertEq(bP, 390); // banker win pays stake*195/100 = 200*195/100 = 390
        assertEq(bH, STAKE + HOUSE - 390);
        assertEq(bP + bH, STAKE + HOUSE);
    }

    // bankerTotal == 6 draws only when the player's third-card pip is 6..7 (this seed's pip misses,
    // so the banker STANDS — covering the "false" side of the ==6 condition, i.e. no third card).
    function test_baccarat_bankerDrawsAfterThird_bankerTotalEQ6() public pure {
        uint256 r = _findBaccaratSeed(6, 6, "bankerTotalEQ6", 200);
        (uint256 bP, uint256 bH) = GamePayouts.settle(11, r, abi.encode(uint256(1)), STAKE, HOUSE);
        assertEq(bP, 390); // banker wins with its un-drawn 2-card total (pt 0, bt 6)
        assertEq(bH, STAKE + HOUSE - 390);
        assertEq(bP + bH, STAKE + HOUSE);
    }

    // ============================================================================================
    // roulette (gameId 25): _rouletteBetWins even-money WIN arms for black/odd/even/high/low.
    // pocket = r % 37, so r < 37 makes r the pocket directly (same convention GamePayouts.t.sol
    // uses for its straight/multi-bet/dozen-column vectors).
    // ============================================================================================

    function _bet(uint8 t, uint8 sel, uint256 stake) private pure returns (GamePayouts.RouletteBet memory b) {
        b.betType = t;
        b.selection = sel;
        b.stake = stake;
    }

    function _oneBetParams(uint8 betType, uint256 stake) private pure returns (bytes memory) {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(betType, 0, stake);
        return abi.encode(bets);
    }

    // pocket 2 is black (not in ROULETTE_RED_MASK, and nonzero).
    function test_roulette_black_wins() public pure {
        (uint256 bP, uint256 bH) = GamePayouts.settle(25, 2, _oneBetParams(2, 200), 200, 200);
        assertEq(bP, 400); // even-money win: stake*200/100
        assertEq(bH, 0);
        // pocket 1 is red -> the same black bet loses cleanly.
        (uint256 bP2, uint256 bH2) = GamePayouts.settle(25, 1, _oneBetParams(2, 200), 200, 200);
        assertEq(bP2, 0);
        assertEq(bH2, 400);
    }

    // pocket 1 is odd.
    function test_roulette_odd_wins() public pure {
        (uint256 bP, uint256 bH) = GamePayouts.settle(25, 1, _oneBetParams(3, 200), 200, 200);
        assertEq(bP, 400);
        assertEq(bH, 0);
        // pocket 2 is even -> the same odd bet loses cleanly.
        (uint256 bP2, uint256 bH2) = GamePayouts.settle(25, 2, _oneBetParams(3, 200), 200, 200);
        assertEq(bP2, 0);
        assertEq(bH2, 400);
    }

    // pocket 2 is even and nonzero.
    function test_roulette_even_wins() public pure {
        (uint256 bP, uint256 bH) = GamePayouts.settle(25, 2, _oneBetParams(4, 200), 200, 200);
        assertEq(bP, 400);
        assertEq(bH, 0);
        // pocket 1 is odd -> the same even bet loses cleanly.
        (uint256 bP2, uint256 bH2) = GamePayouts.settle(25, 1, _oneBetParams(4, 200), 200, 200);
        assertEq(bP2, 0);
        assertEq(bH2, 400);
    }

    // pocket 20 is in the high range (19..36).
    function test_roulette_high_wins() public pure {
        (uint256 bP, uint256 bH) = GamePayouts.settle(25, 20, _oneBetParams(5, 200), 200, 200);
        assertEq(bP, 400);
        assertEq(bH, 0);
        // pocket 5 is low -> the same high bet loses cleanly.
        (uint256 bP2, uint256 bH2) = GamePayouts.settle(25, 5, _oneBetParams(5, 200), 200, 200);
        assertEq(bP2, 0);
        assertEq(bH2, 400);
    }

    // pocket 5 is in the low range (1..18).
    function test_roulette_low_wins() public pure {
        (uint256 bP, uint256 bH) = GamePayouts.settle(25, 5, _oneBetParams(6, 200), 200, 200);
        assertEq(bP, 400);
        assertEq(bH, 0);
        // pocket 20 is high -> the same low bet loses cleanly.
        (uint256 bP2, uint256 bH2) = GamePayouts.settle(25, 20, _oneBetParams(6, 200), 200, 200);
        assertEq(bP2, 0);
        assertEq(bH2, 400);
    }
}

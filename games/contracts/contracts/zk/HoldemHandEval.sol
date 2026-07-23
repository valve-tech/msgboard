// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Texas Hold'em 5-of-7 hand evaluator — Solidity MIRROR of @gibs/holdem
/// src/handEval.ts. Consulted only by HoldemTableN's disputed-showdown path; the TS module is
/// normative and test/HandEvalParity.test.ts fuzzes the two against each other (score equality
/// AND pairwise-ordering agreement). Any divergence mis-settles a disputed showdown, so the
/// score encoding here MUST stay bit-identical to handEval.ts.
///
/// ## Score encoding (a single comparable uint256; higher = better)
///   score = (category << 20) | (t1 << 16) | (t2 << 12) | (t3 << 8) | (t4 << 4) | t5
/// category ∈ 0..8 (HIGH_CARD..STRAIGHT_FLUSH); t1..t5 are ordered tiebreak ranks (each
/// 2..14, fits a nibble). See handEval.ts for the per-category tiebreak layout.
///
/// Cards are deck indices 0..51 with rank = index/4 + 2 (2..14, ace high) and suit = index%4.
/// Best-5-of-7 is the max score over all C(7,5)=21 5-card subsets.
contract HoldemHandEval {
    error BadCardCount();

    // Categories (mirror handEval.ts Category enum).
    uint256 internal constant HIGH_CARD = 0;
    uint256 internal constant PAIR = 1;
    uint256 internal constant TWO_PAIR = 2;
    uint256 internal constant TRIPS = 3;
    uint256 internal constant STRAIGHT = 4;
    uint256 internal constant FLUSH = 5;
    uint256 internal constant FULL_HOUSE = 6;
    uint256 internal constant QUADS = 7;
    uint256 internal constant STRAIGHT_FLUSH = 8;

    /// @notice Evaluate the best 5-card hand out of 7 distinct deck indices (2 hole + 5 board).
    /// @return score the comparable packed score (== handEval.ts evaluate7).
    function evaluate7(uint8[7] calldata cards) external pure returns (uint256 score) {
        uint8[7] memory mem = cards;
        return _evaluate7(mem);
    }

    /// @dev Memory variant of evaluate7 — same algorithm, callable from an in-memory caller
    /// (the showdown settlement in HoldemRules builds each seat's 7-card hand in memory).
    /// Identical scoring to evaluate7, so parity to handEval.ts holds for both entry points.
    function _evaluate7(uint8[7] memory cards) internal pure returns (uint256 score) {
        // Precompute rank (2..14) and suit (0..3) per card once.
        uint8[7] memory ranks;
        uint8[7] memory suits;
        for (uint256 i = 0; i < 7; i++) {
            ranks[i] = uint8(cards[i] / 4 + 2);
            suits[i] = uint8(cards[i] % 4);
        }
        // Scan all C(7,5)=21 5-subsets; keep the max score.
        for (uint256 a = 0; a < 7; a++) {
            for (uint256 b = a + 1; b < 7; b++) {
                for (uint256 c = b + 1; c < 7; c++) {
                    for (uint256 d = c + 1; d < 7; d++) {
                        for (uint256 e = d + 1; e < 7; e++) {
                            uint256 s = _score5(
                                [ranks[a], ranks[b], ranks[c], ranks[d], ranks[e]],
                                [suits[a], suits[b], suits[c], suits[d], suits[e]]
                            );
                            if (s > score) score = s;
                        }
                    }
                }
            }
        }
    }

    /// @dev Pack a category + up to 5 tiebreak ranks into the comparable score.
    function _pack(uint256 category, uint256 t1, uint256 t2, uint256 t3, uint256 t4, uint256 t5)
        internal
        pure
        returns (uint256)
    {
        return (category << 20) | (t1 << 16) | (t2 << 12) | (t3 << 8) | (t4 << 4) | t5;
    }

    /// @dev Score exactly 5 cards given their ranks (2..14) and suits (0..3). Mirrors
    /// handEval.ts score5: same category precedence and tiebreak ordering.
    function _score5(uint8[5] memory ranks, uint8[5] memory suits) internal pure returns (uint256) {
        // count[r] = occurrences of rank r (r in 2..14).
        uint8[15] memory count;
        for (uint256 i = 0; i < 5; i++) count[ranks[i]]++;

        bool isFlush = (suits[0] == suits[1] && suits[1] == suits[2] && suits[2] == suits[3] && suits[3] == suits[4]);

        uint256 straightHigh = _straightHigh(count);

        // Build the canonical "groups" ordering: ranks sorted by (count desc, rank desc).
        // We materialize up to 5 (rank, cnt) entries. Iterate ranks high→low and, for the
        // present ranks, sort by count desc then rank desc via insertion into arrays.
        uint8[5] memory gRank; // group rank
        uint8[5] memory gCnt; // group count
        uint256 gN; // number of distinct ranks
        // First collect distinct ranks high→low (so equal counts keep rank-desc order).
        for (uint256 r = 14; r >= 2; r--) {
            if (count[r] > 0) {
                gRank[gN] = uint8(r);
                gCnt[gN] = count[r];
                gN++;
            }
            if (r == 2) break; // avoid underflow on uint
        }
        // Stable sort the (gRank,gCnt) entries by count desc (rank-desc already stable).
        for (uint256 i = 1; i < gN; i++) {
            uint8 rk = gRank[i];
            uint8 ct = gCnt[i];
            uint256 j = i;
            while (j > 0 && gCnt[j - 1] < ct) {
                gRank[j] = gRank[j - 1];
                gCnt[j] = gCnt[j - 1];
                j--;
            }
            gRank[j] = rk;
            gCnt[j] = ct;
        }

        if (straightHigh > 0 && isFlush) {
            return _pack(STRAIGHT_FLUSH, straightHigh, 0, 0, 0, 0);
        }
        if (gCnt[0] == 4) {
            return _pack(QUADS, gRank[0], gRank[1], 0, 0, 0);
        }
        if (gCnt[0] == 3 && gN >= 2 && gCnt[1] >= 2) {
            return _pack(FULL_HOUSE, gRank[0], gRank[1], 0, 0, 0);
        }
        if (isFlush) {
            uint8[5] memory desc = _ranksDesc(ranks);
            return _pack(FLUSH, desc[0], desc[1], desc[2], desc[3], desc[4]);
        }
        if (straightHigh > 0) {
            return _pack(STRAIGHT, straightHigh, 0, 0, 0, 0);
        }
        if (gCnt[0] == 3) {
            return _pack(TRIPS, gRank[0], gRank[1], gRank[2], 0, 0);
        }
        if (gCnt[0] == 2 && gN >= 2 && gCnt[1] == 2) {
            uint8 hiPair = gRank[0] > gRank[1] ? gRank[0] : gRank[1];
            uint8 loPair = gRank[0] > gRank[1] ? gRank[1] : gRank[0];
            return _pack(TWO_PAIR, hiPair, loPair, gRank[2], 0, 0);
        }
        if (gCnt[0] == 2) {
            return _pack(PAIR, gRank[0], gRank[1], gRank[2], gRank[3], 0);
        }
        uint8[5] memory d = _ranksDesc(ranks);
        return _pack(HIGH_CARD, d[0], d[1], d[2], d[3], d[4]);
    }

    /// @dev Ranks sorted descending (insertion sort over 5 elements).
    function _ranksDesc(uint8[5] memory ranks) internal pure returns (uint8[5] memory out) {
        out = ranks;
        for (uint256 i = 1; i < 5; i++) {
            uint8 v = out[i];
            uint256 j = i;
            while (j > 0 && out[j - 1] < v) {
                out[j] = out[j - 1];
                j--;
            }
            out[j] = v;
        }
    }

    /// @dev If the 5 ranks form a straight, return its high card (wheel A-2-3-4-5 ⇒ 5); else 0.
    /// Requires 5 distinct consecutive ranks. `count` is the per-rank occurrence table.
    function _straightHigh(uint8[15] memory count) internal pure returns (uint256) {
        // 5 distinct ranks required.
        uint256 distinct;
        for (uint256 r = 2; r <= 14; r++) if (count[r] > 0) distinct++;
        if (distinct != 5) return 0;
        // Find min and max present rank.
        uint256 lo = 0;
        uint256 hi = 0;
        for (uint256 r = 2; r <= 14; r++) {
            if (count[r] > 0) {
                if (lo == 0) lo = r;
                hi = r;
            }
        }
        // Normal consecutive run.
        if (hi - lo == 4) return hi;
        // Wheel: ranks {2,3,4,5,14}.
        if (count[2] == 1 && count[3] == 1 && count[4] == 1 && count[5] == 1 && count[14] == 1) {
            return 5;
        }
        return 0;
    }
}

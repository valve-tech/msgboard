// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemHandEval} from "../../contracts/zk/HoldemHandEval.sol";

/// @notice COVERAGE-ONLY unit suite for contracts/zk/HoldemHandEval.sol (a pure 7-card
/// evaluator). forge's default game suite only exercises this contract indirectly via
/// HoldemTableN showdown fixtures; the exhaustive category/parity vectors live in the Hardhat
/// suite (test/HandEvalParity.test.ts, fuzzed against the msgboard/holdem TS reference). This
/// file ports those same anchor hands into Solidity (so the category+tiebreak table is
/// self-checking without a TS oracle) and adds vectors specifically crafted to force the two
/// internal insertion-sort loops (_score5's count-desc sort, _ranksDesc) down their "swap"
/// path, since the Hardhat anchors happen to list cards in an already-sorted order that never
/// triggers a swap. Expected scores are computed with a local `_pack` mirroring the contract's
/// documented bit layout (score = category<<20 | t1<<16 | t2<<12 | t3<<8 | t4<<4 | t5), so each
/// assertion is a manual poker-rules cross-check, not a tautology against the contract itself.
///
/// Algorithmic notes (documented, not fixed — no .sol changes permitted here): given a standard
/// 52-card deck (max 4 cards per rank) and 5 DISTINCT card indices, whenever a rank-group's
/// count is >=2, at least one other distinct rank-group must exist in the same 5-card hand (a
/// 5-of-one-rank group is impossible with 4 suits). So `gN >= 2` in both the FULL_HOUSE guard
/// (`gCnt[0]==3 && gN>=2 && gCnt[1]>=2`) and the TWO_PAIR guard
/// (`gCnt[0]==2 && gN>=2 && gCnt[1]==2`) can never actually observe `gN < 2` in a real 5-card
/// hand — that sub-term is defensive/dead. Likewise, the two-pair `hiPair/loPair` ternaries
/// (`gRank[0] > gRank[1] ? ... : ...`) can never take the false arm: the count-desc sort is
/// stable on ties, and the two count==2 groups were collected in strict rank-descending order,
/// so gRank[0] (the earlier-collected of the tied pair) is always the higher rank. Neither of
/// these shows up as a forge-coverage gap, though: forge's branch instrumentation tracks one
/// true/false pair per `if`/`while`/`for` condition as a whole (not per `&&` sub-term, and not
/// ternary arms at all), so the containing `if` still reads 100% once both its overall outcomes
/// are hit — which every vector combination below already does.
contract HoldemHandEvalUnitTest is Test {
    HoldemHandEval internal eval;

    // Categories mirror the contract's internal constants (duplicated here only as literals
    // for readability in the expected-score table below).
    uint256 internal constant HIGH_CARD = 0;
    uint256 internal constant PAIR = 1;
    uint256 internal constant TWO_PAIR = 2;
    uint256 internal constant TRIPS = 3;
    uint256 internal constant STRAIGHT = 4;
    uint256 internal constant FLUSH = 5;
    uint256 internal constant FULL_HOUSE = 6;
    uint256 internal constant QUADS = 7;
    uint256 internal constant STRAIGHT_FLUSH = 8;

    function setUp() public {
        eval = new HoldemHandEval();
    }

    // ---- test-local helpers (NOT calls into the contract — independent re-derivation of the
    // documented score encoding, so expected values are computed by poker rules, not copied
    // from contract internals). ----

    /// @dev index = (rank-2)*4 + suit; rank 2..14 (ace high), suit 0..3. Mirrors handEval.ts /
    /// the Hardhat parity test's `card()` helper.
    function _card(uint8 rank, uint8 suit) internal pure returns (uint8) {
        return (rank - 2) * 4 + suit;
    }

    function _pack(uint256 category, uint256 t1, uint256 t2, uint256 t3, uint256 t4, uint256 t5)
        internal
        pure
        returns (uint256)
    {
        return (category << 20) | (t1 << 16) | (t2 << 12) | (t3 << 8) | (t4 << 4) | t5;
    }

    function _hand(
        uint8 r0, uint8 s0,
        uint8 r1, uint8 s1,
        uint8 r2, uint8 s2,
        uint8 r3, uint8 s3,
        uint8 r4, uint8 s4,
        uint8 r5, uint8 s5,
        uint8 r6, uint8 s6
    ) internal pure returns (uint8[7] memory cards) {
        cards[0] = _card(r0, s0);
        cards[1] = _card(r1, s1);
        cards[2] = _card(r2, s2);
        cards[3] = _card(r3, s3);
        cards[4] = _card(r4, s4);
        cards[5] = _card(r5, s5);
        cards[6] = _card(r6, s6);
    }

    // ===================================================================================
    // Category coverage — ports of the Hardhat ANCHORS map (HandEvalParity.test.ts), one
    // deterministic 7-card hand per category, each hitting the rare categories a uniform
    // random draw would almost never reach (straight flush ~0.03%).
    // ===================================================================================

    function test_HighCard() public {
        uint8[7] memory cards = _hand(14, 1, 12, 2, 9, 3, 7, 0, 5, 1, 3, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(HIGH_CARD, 14, 12, 9, 7, 5), "high card");
    }

    function test_Pair() public {
        uint8[7] memory cards = _hand(14, 1, 14, 2, 9, 3, 7, 0, 5, 1, 3, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(PAIR, 14, 9, 7, 5, 0), "pair");
    }

    function test_TwoPair() public {
        uint8[7] memory cards = _hand(14, 1, 14, 2, 9, 3, 9, 0, 5, 1, 3, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(TWO_PAIR, 14, 9, 5, 0, 0), "two pair");
    }

    function test_Trips() public {
        uint8[7] memory cards = _hand(14, 1, 14, 2, 14, 3, 9, 0, 5, 1, 3, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(TRIPS, 14, 9, 5, 0, 0), "trips");
    }

    function test_Straight() public {
        uint8[7] memory cards = _hand(10, 1, 9, 2, 8, 3, 7, 0, 6, 1, 2, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(STRAIGHT, 10, 0, 0, 0, 0), "straight");
    }

    function test_Flush() public {
        uint8[7] memory cards = _hand(14, 1, 11, 1, 9, 1, 6, 1, 3, 1, 13, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(FLUSH, 14, 11, 9, 6, 3), "flush");
    }

    function test_FullHouse() public {
        uint8[7] memory cards = _hand(14, 1, 14, 2, 14, 3, 9, 0, 9, 1, 3, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(FULL_HOUSE, 14, 9, 0, 0, 0), "full house");
    }

    function test_Quads() public {
        uint8[7] memory cards = _hand(14, 1, 14, 2, 14, 3, 14, 0, 9, 1, 3, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(QUADS, 14, 9, 0, 0, 0), "quads");
    }

    function test_StraightFlush() public {
        uint8[7] memory cards = _hand(9, 1, 8, 1, 7, 1, 6, 1, 5, 1, 13, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(STRAIGHT_FLUSH, 9, 0, 0, 0, 0), "straight flush");
    }

    /// @dev Royal flush — the top of the STRAIGHT_FLUSH category (ports Hardhat's ROYAL const).
    function test_Royal() public {
        uint8[7] memory cards = _hand(14, 3, 13, 3, 12, 3, 11, 3, 10, 3, 2, 0, 3, 1);
        assertEq(eval.evaluate7(cards), _pack(STRAIGHT_FLUSH, 14, 0, 0, 0, 0), "royal");
    }

    /// @dev Wheel straight flush (A-2-3-4-5 same suit) — high card is 5, not 14. Ports
    /// Hardhat's WHEEL_SF const; this is the case _straightHigh's ace-low special-case exists
    /// for.
    function test_WheelStraightFlush() public {
        uint8[7] memory cards = _hand(14, 1, 2, 1, 3, 1, 4, 1, 5, 1, 13, 2, 12, 3);
        assertEq(eval.evaluate7(cards), _pack(STRAIGHT_FLUSH, 5, 0, 0, 0, 0), "wheel straight flush");
    }

    /// @dev Same wheel ranks as test_WheelStraightFlush but off-suit — a plain STRAIGHT, not a
    /// straight flush. Ports the Hardhat test's `wheel` local (second `it` block). Exercises the
    /// ace-low branch of _straightHigh independently of the isFlush&&straightHigh combination.
    function test_WheelStraight_NotFlush() public {
        uint8[7] memory cards = _hand(14, 1, 2, 2, 3, 3, 4, 0, 5, 1, 13, 2, 12, 3);
        assertEq(eval.evaluate7(cards), _pack(STRAIGHT, 5, 0, 0, 0, 0), "wheel straight (off-suit)");
    }

    // ===================================================================================
    // Swap-path vectors. The Hardhat anchors above list their 7 cards already sorted
    // rank-descending, so _score5's stable count-desc insertion sort and _ranksDesc's
    // rank-desc insertion sort never need to move an element — the "swap" side of each
    // `while (...)` loop body is never entered. These vectors deliberately scramble input
    // order (or put the higher-count group at a LOWER rank than a kicker) to force at least
    // one swap per call, and some to force several in a row.
    // ===================================================================================

    /// @dev Ranks supplied out of order -> _ranksDesc (the HIGH_CARD tiebreak sort) must swap.
    function test_HighCard_UnsortedInput_ForcesRanksDescSwap() public {
        uint8[7] memory cards = _hand(2, 0, 14, 1, 5, 2, 12, 3, 3, 0, 9, 1, 7, 2);
        assertEq(eval.evaluate7(cards), _pack(HIGH_CARD, 14, 12, 9, 7, 5), "unsorted high card");
    }

    /// @dev Same idea for the FLUSH category's own _ranksDesc call: 5 same-suit cards supplied
    /// out of rank order.
    function test_Flush_UnsortedInput_ForcesRanksDescSwap() public {
        uint8[7] memory cards = _hand(3, 1, 14, 1, 6, 1, 9, 1, 11, 1, 13, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(FLUSH, 14, 11, 9, 6, 3), "unsorted flush");
    }

    /// @dev Full house where the TRIPS rank (5) is lower than the PAIR rank (14). The
    /// rank-desc collection visits 14 before 5, so the count-desc sort must swap the trips
    /// group past both the pair and the singleton kicker to reach the front.
    function test_FullHouse_LowTripsHighPair_ForcesCountSort() public {
        uint8[7] memory cards = _hand(5, 0, 5, 1, 5, 2, 14, 0, 14, 1, 9, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(FULL_HOUSE, 5, 14, 0, 0, 0), "full house swap");
    }

    /// @dev Quads at a lower rank (5) than the kicker (14) — same swap pressure as above but for
    /// the gCnt[0]==4 branch.
    function test_Quads_LowQuadHighKicker_ForcesCountSort() public {
        uint8[7] memory cards = _hand(5, 0, 5, 1, 5, 2, 5, 3, 14, 1, 9, 2, 2, 3);
        assertEq(eval.evaluate7(cards), _pack(QUADS, 5, 14, 0, 0, 0), "quads swap");
    }

    /// @dev Trips at rank 5 with two HIGHER kickers (14, 9) — the trips group starts behind both
    /// kickers in rank-desc collection order and must bubble past both (two swap iterations).
    function test_Trips_LowTripsHighKickers_ForcesMultiSwap() public {
        uint8[7] memory cards = _hand(5, 0, 5, 1, 5, 2, 14, 1, 9, 2, 7, 3, 2, 0);
        assertEq(eval.evaluate7(cards), _pack(TRIPS, 5, 14, 9, 0, 0), "trips swap");
    }

    /// @dev Pair at rank 3 with FOUR higher kickers (14, 12, 9, 7) — forces the pair group to
    /// bubble past every one of the four singleton kicker groups (four swap iterations in a
    /// single call, the deepest swap chain any vector here exercises).
    function test_Pair_LowPairHighKickers_ForcesDeepMultiSwap() public {
        uint8[7] memory cards = _hand(3, 0, 3, 1, 14, 2, 12, 3, 9, 0, 7, 1, 2, 2);
        assertEq(eval.evaluate7(cards), _pack(PAIR, 3, 14, 12, 9, 0), "pair swap");
    }

    // ===================================================================================
    // Tie-break / kicker ladder — same-category hands that differ at successively deeper
    // tiebreak slots, each asserted with a direct score comparison (score is a single
    // comparable uint256 by construction, so `>` is exactly "wins the pot").
    // ===================================================================================

    /// @dev Two-pair: same pairs (14,9), lower third kicker (4 vs the anchor's 5) -> anchor wins.
    function test_TieBreak_TwoPair_KickerLadder() public {
        uint8[7] memory anchor = _hand(14, 1, 14, 2, 9, 3, 9, 0, 5, 1, 3, 2, 2, 3);
        uint8[7] memory lower = _hand(14, 1, 14, 2, 9, 3, 9, 0, 4, 1, 3, 2, 2, 3);
        assertGt(eval.evaluate7(anchor), eval.evaluate7(lower), "two pair kicker ladder");
    }

    /// @dev Full house: trip-rank has priority over pair-rank in the tiebreak, regardless of
    /// which numeric rank is larger. trips14/pair9 must beat trips9/pair14.
    function test_TieBreak_FullHouse_TripPriorityOverPairRank() public {
        uint8[7] memory tripsHigh = _hand(14, 1, 14, 2, 14, 3, 9, 0, 9, 1, 3, 2, 2, 3);
        uint8[7] memory tripsLow = _hand(9, 0, 9, 1, 9, 2, 14, 0, 14, 1, 3, 2, 2, 3);
        assertGt(eval.evaluate7(tripsHigh), eval.evaluate7(tripsLow), "full house trip priority");
    }

    /// @dev Straight high-card ladder: ace-high (broadway) > ten-high > wheel (five-high, the
    /// worst possible straight). Chains three category-4 hands.
    function test_TieBreak_Straight_HighCardLadder() public {
        uint8[7] memory aceHigh = _hand(14, 0, 13, 1, 12, 2, 11, 3, 10, 0, 2, 1, 3, 2);
        uint8[7] memory tenHigh = _hand(10, 1, 9, 2, 8, 3, 7, 0, 6, 1, 2, 2, 2, 3);
        uint8[7] memory wheel = _hand(14, 1, 2, 2, 3, 3, 4, 0, 5, 1, 13, 2, 12, 3);
        uint256 sAce = eval.evaluate7(aceHigh);
        uint256 sTen = eval.evaluate7(tenHigh);
        uint256 sWheel = eval.evaluate7(wheel);
        assertGt(sAce, sTen, "ace-high beats ten-high straight");
        assertGt(sTen, sWheel, "ten-high beats wheel straight");
    }

    /// @dev Straight-flush ladder: royal (14-high) > 9-high > wheel (5-high) — same ordering as
    /// plain straights, one category up.
    function test_TieBreak_StraightFlush_HighCardLadder() public {
        uint8[7] memory royal = _hand(14, 3, 13, 3, 12, 3, 11, 3, 10, 3, 2, 0, 3, 1);
        uint8[7] memory nineHigh = _hand(9, 1, 8, 1, 7, 1, 6, 1, 5, 1, 13, 2, 2, 3);
        uint8[7] memory wheelSf = _hand(14, 1, 2, 1, 3, 1, 4, 1, 5, 1, 13, 2, 12, 3);
        uint256 sRoyal = eval.evaluate7(royal);
        uint256 sNine = eval.evaluate7(nineHigh);
        uint256 sWheel = eval.evaluate7(wheelSf);
        assertGt(sRoyal, sNine, "royal beats nine-high straight flush");
        assertGt(sNine, sWheel, "nine-high beats wheel straight flush");
    }

    /// @dev Flush kicker ladder: same top card (14), second-highest kicker differs (11 vs 10).
    function test_TieBreak_Flush_KickerLadder() public {
        uint8[7] memory higher = _hand(14, 1, 11, 1, 9, 1, 6, 1, 3, 1, 13, 2, 2, 3);
        uint8[7] memory lower = _hand(14, 1, 10, 1, 9, 1, 6, 1, 3, 1, 13, 2, 2, 3);
        assertGt(eval.evaluate7(higher), eval.evaluate7(lower), "flush kicker ladder");
    }

    /// @dev High card: agrees on the first four ranks (14,12,9,7), differs only at the deepest
    /// (fifth) kicker slot t5 — proves the full 5-deep tiebreak ladder is actually compared, not
    /// just the top one or two ranks.
    function test_TieBreak_HighCard_DeepestKickerSlot() public {
        uint8[7] memory higher = _hand(14, 1, 12, 2, 9, 3, 7, 0, 5, 1, 3, 2, 2, 3);
        uint8[7] memory lower = _hand(14, 1, 12, 2, 9, 3, 7, 0, 4, 1, 3, 2, 2, 3);
        assertGt(eval.evaluate7(higher), eval.evaluate7(lower), "high card t5 ladder");
    }

    /// @dev Quads: same quad rank (14), lower kicker (7 vs the anchor's 9).
    function test_TieBreak_Quads_KickerLadder() public {
        uint8[7] memory higher = _hand(14, 1, 14, 2, 14, 3, 14, 0, 9, 1, 3, 2, 2, 3);
        uint8[7] memory lower = _hand(14, 1, 14, 2, 14, 3, 14, 0, 7, 1, 3, 2, 2, 3);
        assertGt(eval.evaluate7(higher), eval.evaluate7(lower), "quads kicker ladder");
    }

    /// @dev Trips: same trips rank (14) and top kicker (9), differ only at the second (deeper)
    /// kicker slot t3 (5 vs 4).
    function test_TieBreak_Trips_DeepKickerSlot() public {
        uint8[7] memory higher = _hand(14, 1, 14, 2, 14, 3, 9, 0, 5, 1, 3, 2, 2, 3);
        uint8[7] memory lower = _hand(14, 1, 14, 2, 14, 3, 9, 0, 4, 1, 3, 2, 2, 3);
        assertGt(eval.evaluate7(higher), eval.evaluate7(lower), "trips deep kicker ladder");
    }

    /// @dev Pair: same pair rank (14) and top two kickers (9,7), differ only at the deepest (t4)
    /// kicker slot (5 vs 4).
    function test_TieBreak_Pair_DeepestKickerSlot() public {
        // Fillers (3, 2) must stay BELOW the differing kicker (4/5) so they never displace it
        // from the top-3 kicker slots — otherwise both hands land on the same {9,7,6} kicker
        // set and the assertion degenerates into a tie (caught by an earlier draft of this test).
        uint8[7] memory higher = _hand(14, 1, 14, 2, 9, 3, 7, 0, 5, 1, 3, 2, 2, 3);
        uint8[7] memory lower = _hand(14, 1, 14, 2, 9, 3, 7, 0, 4, 1, 3, 2, 2, 3);
        assertGt(eval.evaluate7(higher), eval.evaluate7(lower), "pair t4 ladder");
    }

    /// @dev Category always dominates tiebreaks, however large the numbers underneath: chains
    /// all 9 categories using the anchors above, strictly descending. In particular the
    /// HIGH_CARD anchor's t1=14 is numerically the largest tiebreak value of ANY anchor here,
    /// yet must still lose to every other category — a direct regression check on the
    /// `category << 20` encoding.
    function test_CategoryDominance_FullChain() public {
        uint256 sf = eval.evaluate7(_hand(9, 1, 8, 1, 7, 1, 6, 1, 5, 1, 13, 2, 2, 3));
        uint256 quads = eval.evaluate7(_hand(14, 1, 14, 2, 14, 3, 14, 0, 9, 1, 3, 2, 2, 3));
        uint256 fh = eval.evaluate7(_hand(14, 1, 14, 2, 14, 3, 9, 0, 9, 1, 3, 2, 2, 3));
        uint256 flush = eval.evaluate7(_hand(14, 1, 11, 1, 9, 1, 6, 1, 3, 1, 13, 2, 2, 3));
        uint256 straight = eval.evaluate7(_hand(10, 1, 9, 2, 8, 3, 7, 0, 6, 1, 2, 2, 2, 3));
        uint256 trips = eval.evaluate7(_hand(14, 1, 14, 2, 14, 3, 9, 0, 5, 1, 3, 2, 2, 3));
        uint256 twoPair = eval.evaluate7(_hand(14, 1, 14, 2, 9, 3, 9, 0, 5, 1, 3, 2, 2, 3));
        uint256 pair = eval.evaluate7(_hand(14, 1, 14, 2, 9, 3, 7, 0, 5, 1, 3, 2, 2, 3));
        uint256 highCard = eval.evaluate7(_hand(14, 1, 12, 2, 9, 3, 7, 0, 5, 1, 3, 2, 2, 3));

        assertGt(sf, quads, "SF > quads");
        assertGt(quads, fh, "quads > full house");
        assertGt(fh, flush, "full house > flush");
        assertGt(flush, straight, "flush > straight");
        assertGt(straight, trips, "straight > trips");
        assertGt(trips, twoPair, "trips > two pair");
        assertGt(twoPair, pair, "two pair > pair");
        assertGt(pair, highCard, "pair > high card");
    }

    // ===================================================================================
    // Property-based fuzzing over the full 21-subset search (_evaluate7's C(7,5) scan) and
    // the packed-score structure, using arbitrary DISTINCT 7-card draws from a fuzzed seed.
    // ===================================================================================

    /// @dev Deterministically draw 7 DISTINCT deck indices (0..51) from `seed` via partial
    /// Fisher-Yates over a 52-card array. Pure + deterministic so a failing fuzz run is
    /// reproducible from the seed alone.
    function _distinctCards(uint256 seed) internal pure returns (uint8[7] memory cards) {
        uint8[52] memory deck;
        for (uint256 i = 0; i < 52; i++) {
            deck[i] = uint8(i);
        }
        for (uint256 i = 0; i < 7; i++) {
            uint256 j = i + (uint256(keccak256(abi.encode(seed, "draw", i))) % (52 - i));
            (deck[i], deck[j]) = (deck[j], deck[i]);
            cards[i] = deck[i];
        }
    }

    /// @dev _evaluate7 scans all C(7,5)=21 5-subsets and is documented as order-independent
    /// (the input is "2 hole + 5 board" but nothing in the algorithm relies on positional
    /// meaning). Shuffling the same 7 cards must not change the score.
    function testFuzz_OrderInvariance(uint256 seed) public {
        uint8[7] memory cards = _distinctCards(seed);
        uint8[7] memory permuted = cards;
        for (uint256 i = 6; i > 0; i--) {
            uint256 j = uint256(keccak256(abi.encode(seed, "perm", i))) % (i + 1);
            (permuted[i], permuted[j]) = (permuted[j], permuted[i]);
        }
        assertEq(eval.evaluate7(cards), eval.evaluate7(permuted), "score must be order-invariant");
    }

    /// @dev Sanity-check the packed score's documented structure holds for arbitrary hands:
    /// category in 0..8, every tiebreak nibble in 0..14 (ranks are 2..14; 0 means "unused
    /// slot"), and the score is never zero (every hand has at least one nonzero tiebreak rank).
    function testFuzz_ScoreStructureBounds(uint256 seed) public {
        uint8[7] memory cards = _distinctCards(seed);
        uint256 score = eval.evaluate7(cards);
        uint256 category = score >> 20;
        assertLe(category, STRAIGHT_FLUSH, "category out of range");
        assertGt(score, 0, "score must be nonzero");
        assertLe((score >> 16) & 0xF, 14, "t1 out of range");
        assertLe((score >> 12) & 0xF, 14, "t2 out of range");
        assertLe((score >> 8) & 0xF, 14, "t3 out of range");
        assertLe((score >> 4) & 0xF, 14, "t4 out of range");
        assertLe(score & 0xF, 14, "t5 out of range");
    }
}

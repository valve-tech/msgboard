// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaiGowRules} from "../../contracts/games/PaiGowRules.sol";

/// Thin external wrapper so vm.expectRevert can catch reverts of the (internal, inlined) library at a
/// lower call depth. Mirrors the harness in PaiGowRules.t.sol.
contract PaiGowRulesUnitHarness {
    function settle(PaiGowRules.PaiGowClaim calldata claim, uint256 escrowPlayer, uint256 escrowHouse)
        external
        pure
        returns (uint256, uint256)
    {
        return PaiGowRules.settle(claim, escrowPlayer, escrowHouse);
    }
}

/// TEST-ONLY byte-for-byte mirror of PaiGowRules' PRIVATE hand-evaluation internals, plus a deterministic
/// "target deck -> seed" inverter for the library's Fisher-Yates shuffle. PaiGowRules deliberately keeps
/// everything but `settle`/`commitLayout` `private`, so a test contract cannot call `_rankFive`, `_isFoul`,
/// etc. directly to steer coverage. Re-deriving the exact deck a given seed produces (forward) is cheap;
/// finding a seed that produces a SPECIFIC desired 7-card player/dealer hand (what we need to hit every
/// hand-category and foul sub-branch) is the inverse problem, solved here.
///
/// INVERSION: `_shuffle` is exactly the textbook Fisher-Yates ("for i = 51 downto 1: swap(deck[i],
/// deck[random_j in 0..i])"), which is a Lehmer-code / mixed-radix decode of `r`: at step i the digit
/// d_i = acc % (i+1), acc /= (i+1). Crucially, once step i's swap runs, deck[i] is FINAL (no later step
/// ever touches index >= its own i again). So to force a desired full 52-card arrangement `target`, we
/// walk i = 51 downto 1 and greedily choose j_i = the CURRENT index of `target[i]`'s card value (tracked
/// via a position map, updated after each swap) — the standard reverse-Fisher-Yates construction — then
/// re-encode the recorded digits back into r with the same mixed-radix weights the shuffle consumes them
/// with. `seedForDeck` is verified against `shuffle` (self-consistency) in every scenario below via
/// `_run`, so any transcription slip here would show up as a failing assertion, not silently wrong coverage.
library PGMirror {
    uint256 internal constant DECK_SIZE = 52;

    // -- verbatim mirror of PaiGowRules._shuffle --
    function shuffle(uint256 r) internal pure returns (uint8[52] memory deck) {
        for (uint256 k = 0; k < DECK_SIZE; k++) deck[k] = uint8(k);
        uint256 acc = r;
        for (uint256 i = DECK_SIZE - 1; i >= 1; i--) {
            uint256 window = i + 1;
            uint256 j = acc % window;
            acc = acc / window;
            (deck[i], deck[j]) = (deck[j], deck[i]);
        }
    }

    // -- inverse: find r such that shuffle(r) == target --
    function seedForDeck(uint8[52] memory target) internal pure returns (uint256 r) {
        uint8[52] memory arr;
        uint8[52] memory pos; // pos[cardValue] = current index of that value in arr
        for (uint256 k = 0; k < DECK_SIZE; k++) {
            arr[k] = uint8(k);
            pos[k] = uint8(k);
        }
        uint256 weight = 1;
        for (uint256 i = DECK_SIZE - 1; i >= 1; i--) {
            uint8 dv = target[i];
            uint256 j = pos[dv];
            r += j * weight;
            weight *= (i + 1);
            uint8 vi = arr[i];
            uint8 vj = arr[j];
            arr[i] = vj;
            arr[j] = vi;
            pos[vj] = uint8(i);
            pos[vi] = uint8(j);
        }
    }

    /// Place `player` at [0..6], `dealer` at [7..13], fill the rest with whatever cards are left over
    /// (ascending). Reverts (array OOB) if `player`/`dealer` are not 14 genuinely distinct cards.
    function buildDeck(uint8[7] memory player, uint8[7] memory dealer) internal pure returns (uint8[52] memory target) {
        bool[52] memory used;
        for (uint256 i = 0; i < 7; i++) {
            target[i] = player[i];
            used[player[i]] = true;
        }
        for (uint256 i = 0; i < 7; i++) {
            target[7 + i] = dealer[i];
            used[dealer[i]] = true;
        }
        uint256 k = 14;
        for (uint256 c = 0; c < DECK_SIZE; c++) {
            if (!used[c]) target[k++] = uint8(c);
        }
    }

    // -- verbatim mirrors of PaiGowRules' rank/suit/score helpers --
    function rankOf(uint8 card) internal pure returns (uint256) {
        return uint256(card) / 4 + 2;
    }

    function suitOf(uint8 card) internal pure returns (uint256) {
        return uint256(card) % 4;
    }

    function pack(uint256 category, uint256[5] memory ordered) internal pure returns (uint256 score) {
        score = category;
        for (uint256 i = 0; i < 5; i++) score = score * 15 + ordered[i];
    }

    function straightHigh5(uint256[5] memory dd) internal pure returns (bool ok, uint256 high) {
        bool consec = true;
        for (uint256 i = 1; i < 5; i++) if (dd[i] != dd[0] - i) consec = false;
        if (consec) return (true, dd[0]);
        if (dd[0] == 14 && dd[1] == 5 && dd[2] == 4 && dd[3] == 3 && dd[4] == 2) return (true, 5);
        return (false, 0);
    }

    function rankFive(uint8[5] memory cards) internal pure returns (uint256 category, uint256 score) {
        uint256[15] memory cnt;
        bool flush = true;
        uint256 suit0 = suitOf(cards[0]);
        for (uint256 i = 0; i < 5; i++) {
            cnt[rankOf(cards[i])]++;
            if (suitOf(cards[i]) != suit0) flush = false;
        }

        uint256[5] memory distinctDesc;
        uint256 dn;
        uint256 quad;
        uint256 trip;
        uint256 pairHi;
        uint256 pairLo;
        uint256 pairCount;
        uint256[5] memory singles;
        uint256 sn;
        for (uint256 rk = 14; rk >= 2; rk--) {
            uint256 c = cnt[rk];
            if (c != 0) {
                distinctDesc[dn++] = rk;
                if (c == 4) quad = rk;
                else if (c == 3) trip = rk;
                else if (c == 2) {
                    if (pairCount == 0) pairHi = rk;
                    else pairLo = rk;
                    pairCount++;
                } else singles[sn++] = rk;
            }
        }

        (bool isStraight, uint256 sHigh) = dn == 5 ? straightHigh5(distinctDesc) : (false, uint256(0));

        uint256[5] memory ordered;
        if (flush && isStraight) {
            category = 8;
            ordered[0] = sHigh;
        } else if (quad != 0) {
            category = 7;
            ordered[0] = quad;
            ordered[1] = singles[0];
        } else if (trip != 0 && pairCount >= 1) {
            category = 6;
            ordered[0] = trip;
            ordered[1] = pairHi;
        } else if (flush) {
            category = 5;
            for (uint256 i = 0; i < 5; i++) ordered[i] = distinctDesc[i];
        } else if (isStraight) {
            category = 4;
            ordered[0] = sHigh;
        } else if (trip != 0) {
            category = 3;
            ordered[0] = trip;
            ordered[1] = singles[0];
            ordered[2] = singles[1];
        } else if (pairCount == 2) {
            category = 2;
            ordered[0] = pairHi;
            ordered[1] = pairLo;
            ordered[2] = singles[0];
        } else if (pairCount == 1) {
            category = 1;
            ordered[0] = pairHi;
            ordered[1] = singles[0];
            ordered[2] = singles[1];
            ordered[3] = singles[2];
        } else {
            category = 0;
            for (uint256 i = 0; i < 5; i++) ordered[i] = distinctDesc[i];
        }
        score = pack(category, ordered);
    }

    function rankTwo(uint8 a, uint8 b) internal pure returns (uint256 category, uint256 score) {
        uint256 ra = rankOf(a);
        uint256 rb = rankOf(b);
        uint256[5] memory ordered;
        if (ra == rb) {
            category = 1;
            ordered[0] = ra;
            ordered[1] = ra;
        } else {
            category = 0;
            ordered[0] = ra > rb ? ra : rb;
            ordered[1] = ra > rb ? rb : ra;
        }
        score = pack(category, ordered);
    }

    function topTwo(uint8[5] memory cards) internal pure returns (uint256 top0, uint256 top1) {
        for (uint256 i = 0; i < 5; i++) {
            uint256 r = rankOf(cards[i]);
            if (r > top0) {
                top1 = top0;
                top0 = r;
            } else if (r > top1) top1 = r;
        }
    }

    function pairRankOf5(uint8[5] memory cards) internal pure returns (uint256) {
        uint256[15] memory cnt;
        for (uint256 i = 0; i < 5; i++) cnt[rankOf(cards[i])]++;
        for (uint256 rk = 14; rk >= 2; rk--) if (cnt[rk] == 2) return rk;
        return 0;
    }

    function isFoul(uint8[2] memory front, uint8[5] memory back) internal pure returns (bool) {
        (uint256 fcat,) = rankTwo(front[0], front[1]);
        (uint256 bcat,) = rankFive(back);
        if (bcat >= 2) return false;
        if (bcat == 1) {
            if (fcat == 0) return false;
            uint256 backPair = pairRankOf5(back);
            uint256 frontPair = rankOf(front[0]);
            return frontPair >= backPair;
        }
        if (fcat == 1) return true;
        uint256 f0 = rankOf(front[0]);
        uint256 f1 = rankOf(front[1]);
        (uint256 fHi, uint256 fLo) = f0 >= f1 ? (f0, f1) : (f1, f0);
        (uint256 bTop0, uint256 bTop1) = topTwo(back);
        if (fHi > bTop0) return true;
        if (fHi == bTop0 && fLo > bTop1) return true;
        return false;
    }

    function split(uint8[7] memory seven, uint256 a, uint256 b)
        internal
        pure
        returns (uint8[2] memory front, uint8[5] memory back)
    {
        front[0] = seven[a];
        front[1] = seven[b];
        uint256 k;
        for (uint256 p = 0; p < 7; p++) if (p != a && p != b) back[k++] = seven[p];
    }

    function houseWay(uint8[7] memory seven) internal pure returns (uint256 frontScore, uint256 backScore) {
        bool have = false;
        for (uint256 i = 0; i < 7; i++) {
            for (uint256 j = i + 1; j < 7; j++) {
                (uint8[2] memory front, uint8[5] memory back) = split(seven, i, j);
                if (isFoul(front, back)) continue;
                (, uint256 fs) = rankTwo(front[0], front[1]);
                (, uint256 bs) = rankFive(back);
                if (!have || bs > backScore || (bs == backScore && fs > frontScore)) {
                    backScore = bs;
                    frontScore = fs;
                    have = true;
                }
            }
        }
    }

    /// Mirror of the post-shuffle half of PaiGowRules.settle: given a full 52-card deck and the player's
    /// chosen front positions, replay the exact same foul-check / house-way / win-lose-push comparison and
    /// return the honest result (0 lose / 1 push / 2 win). Used to compute the CORRECT `claimedResult` for
    /// every engineered scenario below, so scenario authors never have to hand-derive win/lose/push by eye.
    function computeResult(uint8[52] memory deck, uint256 frontA, uint256 frontB) internal pure returns (uint8 result) {
        uint8[7] memory player;
        uint8[7] memory dealer;
        for (uint256 i = 0; i < 7; i++) {
            player[i] = deck[i];
            dealer[i] = deck[7 + i];
        }
        (uint8[2] memory pFront, uint8[5] memory pBack) = split(player, frontA, frontB);
        if (isFoul(pFront, pBack)) {
            result = 0;
        } else {
            (, uint256 pFrontScore) = rankTwo(pFront[0], pFront[1]);
            (, uint256 pBackScore) = rankFive(pBack);
            (uint256 dFrontScore, uint256 dBackScore) = houseWay(dealer);
            bool winsBack = pBackScore > dBackScore;
            bool winsFront = pFrontScore > dFrontScore;
            if (winsBack && winsFront) result = 2;
            else if (!winsBack && !winsFront) result = 0;
            else result = 1;
        }
    }
}

/// Deep branch-coverage suite for PaiGowRules (gameId 27), complementing the 8 TS-parity vectors in
/// PaiGowRules.t.sol. Every hand here is ENGINEERED (via PGMirror.seedForDeck, the reverse-Fisher-Yates
/// deck constructor above) rather than sourced from an off-chain TS run, so we can reach specific hand
/// categories and foul sub-branches deterministically. Correctness of each engineered vector's expected
/// result is established by PGMirror.computeResult (a byte-for-byte copy of the library's private logic),
/// and cross-checked against the real PaiGowRules.settle output — a transcription bug in the mirror would
/// surface as a mismatched assertion, not silently-wrong coverage.
contract PaiGowRulesUnitTest is Test {
    PaiGowRulesUnitHarness internal h;

    function setUp() public {
        h = new PaiGowRulesUnitHarness();
    }

    uint256 internal constant STAKE = 200;
    uint256 internal constant ESCROW_HOUSE = 200;

    function _c(uint256 rank, uint256 suit) internal pure returns (uint8) {
        return uint8((rank - 2) * 4 + suit);
    }

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

    /// Seven ranks {2,3,4,6,9,11,13}, all distinct, suits spread thin (max 2 per suit) so this dealer hand
    /// can NEVER pair/straight/flush — its best back is always a plain high-card hand, and house way is
    /// forced to keep its top 5 cards (front = its two lowest). A deliberately "boring" dealer so every
    /// scenario below is driven purely by the PLAYER's engineered hand.
    function _simpleDealer() internal pure returns (uint8[7] memory d) {
        d[0] = _c(2, 0);
        d[1] = _c(4, 1);
        d[2] = _c(6, 2);
        d[3] = _c(9, 3);
        d[4] = _c(11, 0);
        d[5] = _c(13, 1);
        d[6] = _c(3, 2);
    }

    /// Two Aces (different suits) + K,Q,J,9,3. Used to hit two `_houseWay` branches at once: (1) front =
    /// {both Aces} is a foul (pair beats a bare high-card back) — the `_isFoul` `continue` path; and (2)
    /// fronts {AceHearts,3} and {AceSpades,3} leave BACKS with the identical rank multiset {A,K,Q,J,9}
    /// (only the suit of the leftover Ace differs) — a genuine `backScore` TIE across two different
    /// non-foul splits, hitting `bs == backScore`.
    ///
    /// NOTE on the untestable half of that branch: `bs == backScore && fs > frontScore` can never be TRUE
    /// here (or for any single 7-card hand). Removing a fixed-multiset front from a FIXED 7-card rank
    /// multiset is an injective operation (multiset subtraction from a constant total is injective), so
    /// two different front choices that happen to leave an IDENTICAL back-rank-multiset must themselves be
    /// the identical front-rank-multiset — which forces `fs` to tie too (front score depends only on
    /// ranks). So whenever `bs == backScore` fires, `fs > frontScore` is mathematically forced false; that
    /// JUMPI's true side is dead code, not a coverage gap in this suite.
    function _twinAceDealer() internal pure returns (uint8[7] memory d) {
        d[0] = _c(14, 0); // A
        d[1] = _c(14, 1); // A
        d[2] = _c(13, 2); // K
        d[3] = _c(12, 3); // Q
        d[4] = _c(11, 0); // J
        d[5] = _c(9, 1); // 9
        d[6] = _c(3, 2); // 3
    }

    /// Build the seed for (player, dealer), sanity-check the reverse-Fisher-Yates construction against the
    /// mirror's own forward shuffle, compute the honest result via the mirror, settle for real, and assert
    /// the real contract's payout matches the (2x win / push / lose) formula for that result.
    function _run(uint8[7] memory player, uint8[7] memory dealer, uint8 frontA, uint8 frontB, string memory label)
        internal
    {
        uint8[52] memory target = PGMirror.buildDeck(player, dealer);
        uint256 seed = PGMirror.seedForDeck(target);
        assertEq(
            keccak256(abi.encode(PGMirror.shuffle(seed))),
            keccak256(abi.encode(target)),
            string.concat(label, ": seed reconstruction mismatch")
        );

        uint8 expected = PGMirror.computeResult(target, frontA, frontB);
        bytes32 commit = PaiGowRules.commitLayout(seed);
        (uint256 bP, uint256 bH) =
            PaiGowRules.settle(_claim(commit, seed, frontA, frontB, expected), STAKE, ESCROW_HOUSE);

        assertEq(bP + bH, STAKE + ESCROW_HOUSE, string.concat(label, ": conservation"));
        if (expected == 2) {
            assertEq(bP, 2 * STAKE, string.concat(label, ": win payout"));
            assertEq(bH, 0, string.concat(label, ": win house"));
        } else if (expected == 1) {
            assertEq(bP, STAKE, string.concat(label, ": push payout"));
            assertEq(bH, ESCROW_HOUSE, string.concat(label, ": push house"));
        } else {
            assertEq(bP, 0, string.concat(label, ": lose payout"));
            assertEq(bH, STAKE + ESCROW_HOUSE, string.concat(label, ": lose house"));
        }
    }

    // =====================================================================================================
    // _rankFive category matrix (player BACK = positions 0..4, front = positions 5,6 = ranks {2,3}, which
    // is legal against any back category >= 2 since `_isFoul` short-circuits false there).
    // =====================================================================================================

    uint8 internal constant FRONT_A = 5;
    uint8 internal constant FRONT_B = 6;

    function _lowFront() internal pure returns (uint8, uint8) {
        return (_c(2, 3), _c(3, 3));
    }

    function test_category_straightFlush() public {
        (uint8 f0, uint8 f1) = _lowFront();
        uint8[7] memory player =
            [_c(5, 0), _c(6, 0), _c(7, 0), _c(8, 0), _c(9, 0), f0, f1];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "straightFlush");
    }

    function test_category_quads() public {
        (uint8 f0, uint8 f1) = _lowFront();
        uint8[7] memory player =
            [_c(12, 0), _c(12, 1), _c(12, 2), _c(12, 3), _c(5, 3), f0, f1];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "quads");
    }

    function test_category_fullHouse() public {
        (uint8 f0, uint8 f1) = _lowFront();
        uint8[7] memory player =
            [_c(7, 0), _c(7, 1), _c(7, 2), _c(4, 0), _c(4, 2), f0, f1];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "fullHouse");
    }

    function test_category_flush() public {
        (uint8 f0, uint8 f1) = _lowFront();
        uint8[7] memory player =
            [_c(4, 2), _c(7, 2), _c(9, 2), _c(11, 2), _c(13, 2), f0, f1];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "flush");
    }

    function test_category_straight() public {
        (uint8 f0, uint8 f1) = _lowFront();
        uint8[7] memory player =
            [_c(5, 0), _c(6, 1), _c(7, 0), _c(8, 1), _c(9, 0), f0, f1];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "straight");
    }

    function test_category_straight_wheel() public {
        uint8[7] memory player =
            [_c(14, 1), _c(2, 2), _c(3, 1), _c(4, 3), _c(5, 2), _c(9, 1), _c(11, 1)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "wheelStraight");
    }

    function test_category_tripsAlone() public {
        (uint8 f0, uint8 f1) = _lowFront();
        uint8[7] memory player =
            [_c(7, 0), _c(7, 1), _c(7, 2), _c(4, 0), _c(9, 2), f0, f1];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "tripsAlone");
    }

    function test_category_twoPair() public {
        (uint8 f0, uint8 f1) = _lowFront();
        uint8[7] memory player =
            [_c(7, 0), _c(7, 1), _c(4, 0), _c(4, 2), _c(9, 1), f0, f1];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "twoPair");
    }

    // Also exercises the foul rule bcat==1 && fcat==0 -> not a foul (front is unpaired high card).
    function test_category_onePair() public {
        (uint8 f0, uint8 f1) = _lowFront();
        uint8[7] memory player =
            [_c(7, 0), _c(7, 1), _c(4, 0), _c(5, 1), _c(9, 2), f0, f1];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "onePair");
    }

    function test_category_highCard() public {
        uint8[7] memory player =
            [_c(4, 0), _c(7, 1), _c(9, 0), _c(12, 1), _c(14, 0), _c(2, 3), _c(3, 3)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "highCard");
    }

    // =====================================================================================================
    // _isFoul branch matrix. Back categories >= 2 short-circuit `false` regardless of front — already hit
    // by every category test above (fullHouse/flush/straight/wheel/trips/twoPair all have bcat >= 2).
    // =====================================================================================================

    // bcat == 1 (pair back), fcat == 1 (pair front), frontPair >= backPair -> FOUL.
    function test_foul_pairVsPair_frontHigher() public {
        uint8[7] memory player =
            [_c(6, 0), _c(6, 1), _c(9, 0), _c(11, 1), _c(13, 2), _c(10, 0), _c(10, 1)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "pairVsPair_frontHigher_FOUL");
    }

    // bcat == 1, fcat == 1, frontPair < backPair -> legal (not a foul).
    function test_foul_pairVsPair_frontLower() public {
        uint8[7] memory player =
            [_c(6, 0), _c(6, 1), _c(9, 0), _c(11, 1), _c(13, 2), _c(4, 2), _c(4, 3)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "pairVsPair_frontLower_legal");
    }

    // bcat == 0 (high-card back), fcat == 1 (pair front) -> always a FOUL.
    function test_foul_pairFrontVsHighBack() public {
        uint8[7] memory player =
            [_c(4, 0), _c(7, 1), _c(9, 0), _c(12, 1), _c(14, 0), _c(10, 0), _c(10, 1)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "pairFrontVsHighBack_FOUL");
    }

    // Shared high-card-back hand (no Ace, so a front Ace can clear bTop0) for the fHi/fLo comparison ladder.
    function _highBackNoAce() internal pure returns (uint8[5] memory back) {
        back[0] = _c(4, 0);
        back[1] = _c(7, 1);
        back[2] = _c(9, 0);
        back[3] = _c(11, 1);
        back[4] = _c(13, 0); // bTop0 = 13 (K), bTop1 = 11 (J)
    }

    // bcat == 0, fcat == 0, fHi > bTop0 -> FOUL.
    function test_foul_highCard_fHiBeatsTop() public {
        uint8[5] memory back = _highBackNoAce();
        uint8[7] memory player =
            [back[0], back[1], back[2], back[3], back[4], _c(14, 2), _c(3, 3)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "highCard_fHiBeatsTop_FOUL");
    }

    // bcat == 0, fcat == 0, fHi == bTop0 && fLo > bTop1 -> FOUL.
    function test_foul_highCard_tieTopFLoBeats() public {
        uint8[5] memory back = _highBackNoAce();
        uint8[7] memory player =
            [back[0], back[1], back[2], back[3], back[4], _c(13, 2), _c(12, 3)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "highCard_tieTopFLoBeats_FOUL");
    }

    // bcat == 0, fcat == 0, fHi < bTop0 -> legal (front[0] > front[1] ordering, i.e. f0>=f1 ternary true side).
    function test_foul_highCard_fHiBelowTop() public {
        uint8[5] memory back = _highBackNoAce();
        uint8[7] memory player =
            [back[0], back[1], back[2], back[3], back[4], _c(10, 2), _c(6, 3)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "highCard_fHiBelowTop_legal");
    }

    // bcat == 0, fcat == 0, fHi == bTop0 but fLo <= bTop1 -> legal. front[0] < front[1] here, exercising the
    // f0>=f1 ternary's FALSE side (fHi/fLo come from (f1,f0) instead of (f0,f1)).
    function test_foul_highCard_tieTopFLoLoses() public {
        uint8[5] memory back = _highBackNoAce();
        uint8[7] memory player =
            [back[0], back[1], back[2], back[3], back[4], _c(2, 3), _c(13, 2)];
        _run(player, _simpleDealer(), FRONT_A, FRONT_B, "highCard_tieTopFLoLoses_legal");
    }

    // =====================================================================================================
    // _houseWay: dealer-side foul `continue` + genuine backScore tie across two different non-foul splits
    // (see _twinAceDealer's docs for why the tie-break's second clause is provably unreachable).
    // =====================================================================================================

    function test_houseWay_foulContinue_and_backScoreTie() public {
        uint8[7] memory player =
            [_c(7, 0), _c(7, 1), _c(4, 2), _c(5, 3), _c(6, 0), _c(2, 0), _c(3, 1)];
        _run(player, _twinAceDealer(), FRONT_A, FRONT_B, "houseWay_tieAndFoulContinue");
    }

    // =====================================================================================================
    // Errors: CommitMismatch / BadMove (each sub-condition) / ResultMismatch (foul path) / PayoutExceedsPot.
    // =====================================================================================================

    function _winVector() internal pure returns (uint256 seed, bytes32 commit, uint8 expected) {
        uint8[7] memory player =
            [_c(12, 0), _c(12, 1), _c(12, 2), _c(12, 3), _c(8, 3), _c(10, 1), _c(9, 2)];
        uint8[52] memory target = PGMirror.buildDeck(player, _simpleDealer());
        seed = PGMirror.seedForDeck(target);
        commit = PaiGowRules.commitLayout(seed);
        expected = PGMirror.computeResult(target, FRONT_A, FRONT_B);
    }

    function test_winVector_isAnActualWin() public {
        (uint256 seed, bytes32 commit, uint8 expected) = _winVector();
        assertEq(expected, 2, "winVector must be an actual win for the PayoutExceedsPot test below to be meaningful");
        (uint256 bP, uint256 bH) =
            PaiGowRules.settle(_claim(commit, seed, FRONT_A, FRONT_B, 2), STAKE, ESCROW_HOUSE);
        assertEq(bP, 2 * STAKE);
        assertEq(bH, 0);
    }

    // The ONLY way payout can exceed the pot: a win (2x stake) with escrowHouse < escrowPlayer.
    function test_reject_payoutExceedsPot() public {
        (uint256 seed, bytes32 commit,) = _winVector();
        vm.expectRevert(PaiGowRules.PayoutExceedsPot.selector);
        h.settle(_claim(commit, seed, FRONT_A, FRONT_B, 2), STAKE, 50);
    }

    function test_reject_commitMismatch() public {
        (uint256 seed, bytes32 commit,) = _winVector();
        vm.expectRevert(PaiGowRules.CommitMismatch.selector);
        h.settle(_claim(commit, seed + 1, FRONT_A, FRONT_B, 2), STAKE, ESCROW_HOUSE);
    }

    function test_reject_badMove_frontAOutOfRange() public {
        (uint256 seed, bytes32 commit,) = _winVector();
        vm.expectRevert(PaiGowRules.BadMove.selector);
        h.settle(_claim(commit, seed, 7, 0, 2), STAKE, ESCROW_HOUSE);
    }

    function test_reject_badMove_frontBOutOfRange() public {
        (uint256 seed, bytes32 commit,) = _winVector();
        vm.expectRevert(PaiGowRules.BadMove.selector);
        h.settle(_claim(commit, seed, 0, 7, 2), STAKE, ESCROW_HOUSE);
    }

    function test_reject_badMove_frontAEqualsFrontB() public {
        (uint256 seed, bytes32 commit,) = _winVector();
        vm.expectRevert(PaiGowRules.BadMove.selector);
        h.settle(_claim(commit, seed, 3, 3, 2), STAKE, ESCROW_HOUSE);
    }

    // ResultMismatch's OWN guard (claimedResult > 2), as opposed to a mismatch against an honestly
    // computed 0/1/2 result (covered by PaiGowRules.t.sol's test_reject_wrongResult and by
    // test_reject_resultMismatch_foulPath / testFuzz_reject_resultMismatch below).
    function test_reject_resultMismatch_outOfRangeClaim() public {
        (uint256 seed, bytes32 commit,) = _winVector();
        vm.expectRevert(PaiGowRules.ResultMismatch.selector);
        h.settle(_claim(commit, seed, FRONT_A, FRONT_B, 3), STAKE, ESCROW_HOUSE);
    }

    // ResultMismatch reached via the FOUL path (result is forced to 0; claiming anything else must revert)
    // — the non-foul path's ResultMismatch is already covered by PaiGowRules.t.sol's test_reject_wrongResult.
    function test_reject_resultMismatch_foulPath() public {
        uint8[7] memory player =
            [_c(4, 0), _c(7, 1), _c(9, 0), _c(12, 1), _c(14, 0), _c(10, 0), _c(10, 1)];
        uint8[52] memory target = PGMirror.buildDeck(player, _simpleDealer());
        uint256 seed = PGMirror.seedForDeck(target);
        bytes32 commit = PaiGowRules.commitLayout(seed);
        assertEq(PGMirror.computeResult(target, FRONT_A, FRONT_B), 0, "sanity: this hand must foul");

        vm.expectRevert(PaiGowRules.ResultMismatch.selector);
        h.settle(_claim(commit, seed, FRONT_A, FRONT_B, 2), STAKE, ESCROW_HOUSE);
    }

    // =====================================================================================================
    // Fuzz: cross-check the real contract against the mirror over many random hands/fronts, and confirm
    // CommitMismatch/ResultMismatch reject broadly (not just for the hand-picked vectors above).
    // =====================================================================================================

    function testFuzz_settle_matchesMirror(uint256 rawSeed, uint8 rawA, uint8 rawB) public pure {
        uint256 seed = uint256(keccak256(abi.encode(rawSeed, "paigow-unit-fuzz")));
        uint8 frontA = rawA % 7;
        uint8 frontB = rawB % 7;
        if (frontA == frontB) frontB = uint8((frontB + 1) % 7);

        uint8[52] memory deck = PGMirror.shuffle(seed);
        uint8 expected = PGMirror.computeResult(deck, frontA, frontB);
        bytes32 commit = PaiGowRules.commitLayout(seed);

        (uint256 bP, uint256 bH) =
            PaiGowRules.settle(_claim(commit, seed, frontA, frontB, expected), STAKE, ESCROW_HOUSE);

        assert(bP + bH == STAKE + ESCROW_HOUSE);
        if (expected == 2) {
            assert(bP == 2 * STAKE && bH == 0);
        } else if (expected == 1) {
            assert(bP == STAKE && bH == ESCROW_HOUSE);
        } else {
            assert(bP == 0 && bH == STAKE + ESCROW_HOUSE);
        }
    }

    function testFuzz_reject_resultMismatch(uint256 rawSeed, uint8 rawA, uint8 rawB) public {
        uint256 seed = uint256(keccak256(abi.encode(rawSeed, "paigow-unit-fuzz-mismatch")));
        uint8 frontA = rawA % 7;
        uint8 frontB = rawB % 7;
        if (frontA == frontB) frontB = uint8((frontB + 1) % 7);

        uint8[52] memory deck = PGMirror.shuffle(seed);
        uint8 expected = PGMirror.computeResult(deck, frontA, frontB);
        uint8 wrong = uint8((expected + 1) % 3);
        bytes32 commit = PaiGowRules.commitLayout(seed);

        vm.expectRevert(PaiGowRules.ResultMismatch.selector);
        h.settle(_claim(commit, seed, frontA, frontB, wrong), STAKE, ESCROW_HOUSE);
    }

    function testFuzz_reject_commitMismatch(uint256 rawSeed) public {
        uint256 seed = uint256(keccak256(abi.encode(rawSeed, "paigow-unit-fuzz-commit")));
        bytes32 commit = PaiGowRules.commitLayout(seed);

        vm.expectRevert(PaiGowRules.CommitMismatch.selector);
        h.settle(_claim(commit, seed + 1, 0, 1, 0), STAKE, ESCROW_HOUSE);
    }
}

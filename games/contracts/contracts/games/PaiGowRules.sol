// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Pure on-chain dispute-replay mirror of PAI GOW POKER (gameId 27), a single-player-vs-house card game.
///
/// Like the other seeded-deck card games the deck is a pure function of the sealed round seed
/// (commit = keccak256(abi.encode(uint256 seed))), so a permissionless settle can REPLAY the whole deal.
/// Each side is dealt 7 cards (player = deck[0..6], dealer = deck[7..13]); each is split into a 5-card
/// "back" and a 2-card "front" with the rule that the back must rank at least as high as the front (an
/// illegal "foul" arrangement loses). The DEALER always sets by a fixed HOUSE WAY (strongest legal back,
/// tie-broken by the strongest front); the player sets their own split — the co-signed decision, carried
/// here as the two front-card positions. Each hand is compared with the DEALER WINNING COPIES (ties): the
/// player wins the bet by winning BOTH hands, loses by winning neither, else pushes.
///
/// VARIANT (documented, mirror src/games/paiGow.ts): commission-free, even-money wins, standard 52-card
/// deck with NO JOKER (so the deal reuses the on-chain-reproducible shuffle). The edge is STRUCTURAL (the
/// copy rule + push frequency), not a rake.
///
/// `settle` is the replay: given the co-signed claim (commit + seed + the player's two front positions +
/// the claimed result) and the two escrows it rechecks the commitment, replays the deal, recomputes the
/// win/push/lose result, requires it to equal the claim (rejects a lie), and returns the conserved
/// (balancePlayer, balanceHouse) split — the same shape as GamePayouts/LadderRules/MinesRules. Parity
/// with the TS reference is pinned by foundry vectors generated from the canonical game code
/// (test/foundry/PaiGowRules.t.sol). This is a bit-for-bit port of paiGow.ts (rankFivePaiGow,
/// rankTwoPaiGow, isFoul, houseWaySplit, settlePaiGow).
library PaiGowRules {
    uint8 internal constant GAME_ID = 27;

    uint256 internal constant DECK_SIZE = 52;

    error CommitMismatch();
    error BadMove();
    error ResultMismatch();
    error PayoutExceedsPot();

    /// The co-signed claim being adjudicated. `frontA`/`frontB` are the two positions (0..6, distinct)
    /// of the cards the player placed in the front (low) hand; the other 5 form the back. `claimedResult`
    /// is 0 lose / 1 push / 2 win.
    struct PaiGowClaim {
        bytes32 commit;
        uint256 seed;
        uint8 frontA;
        uint8 frontB;
        uint8 claimedResult;
    }

    /// commitLayout(seed) = keccak256(abi.encode(uint256 seed)) — mirror ladder.ts / commitPaiGow.
    function commitLayout(uint256 seed) internal pure returns (bytes32) {
        return keccak256(abi.encode(seed));
    }

    // ---------------------------------------------------------------------------
    // deck — mirror src/cards.ts shuffleDeck + rankOf/suitOf
    // ---------------------------------------------------------------------------

    /// Full Fisher–Yates shuffle of [0..51] driven by `r` (identical uint256 division order to
    /// shuffleDeck in cards.ts). deck[0] is dealt first.
    function _shuffle(uint256 r) private pure returns (uint8[52] memory deck) {
        for (uint256 k = 0; k < DECK_SIZE; k++) deck[k] = uint8(k);
        uint256 acc = r;
        for (uint256 i = DECK_SIZE - 1; i >= 1; i--) {
            uint256 window = i + 1;
            uint256 j = acc % window;
            acc = acc / window;
            (deck[i], deck[j]) = (deck[j], deck[i]);
        }
    }

    /// rank 2..14, ace high (index/4 + 2) — mirror rankOf.
    function _rank(uint8 card) private pure returns (uint256) {
        return uint256(card) / 4 + 2;
    }

    /// suit 0..3 — mirror suitOf (index % 4).
    function _suit(uint8 card) private pure returns (uint256) {
        return uint256(card) % 4;
    }

    // ---------------------------------------------------------------------------
    // hand evaluation — base-15 comparable scores (mirror rankFivePaiGow / rankTwoPaiGow)
    // ---------------------------------------------------------------------------

    /// Pack a category + up to 5 significant ranks into one comparable score (base-15, 5 slots).
    function _pack(uint256 category, uint256[5] memory ordered) private pure returns (uint256 score) {
        score = category;
        for (uint256 i = 0; i < 5; i++) score = score * 15 + ordered[i];
    }

    /// Straight high over 5 DISTINCT ranks in DESCENDING order (ace-low wheel A-2-3-4-5 → 5), or (false,0).
    function _straightHigh5(uint256[5] memory dd) private pure returns (bool ok, uint256 high) {
        bool consec = true;
        for (uint256 i = 1; i < 5; i++) if (dd[i] != dd[0] - i) consec = false;
        if (consec) return (true, dd[0]);
        if (dd[0] == 14 && dd[1] == 5 && dd[2] == 4 && dd[3] == 3 && dd[4] == 2) return (true, 5);
        return (false, 0);
    }

    /// Evaluate a 5-card back hand into (category, comparable score). Mirror rankFivePaiGow.
    function _rankFive(uint8[5] memory cards) private pure returns (uint256 category, uint256 score) {
        uint256[15] memory cnt; // indexed by rank 2..14
        bool flush = true;
        uint256 suit0 = _suit(cards[0]);
        for (uint256 i = 0; i < 5; i++) {
            cnt[_rank(cards[i])]++;
            if (_suit(cards[i]) != suit0) flush = false;
        }

        // descending scan collects distinct ranks + count-class members (all in descending order).
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
                else if (c == 2) { if (pairCount == 0) pairHi = rk; else pairLo = rk; pairCount++; }
                else singles[sn++] = rk;
            }
        }

        (bool isStraight, uint256 sHigh) = dn == 5 ? _straightHigh5(distinctDesc) : (false, uint256(0));

        uint256[5] memory ordered; // zero-initialized
        if (flush && isStraight) {
            category = 8; // straight flush (royal folds in)
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
        score = _pack(category, ordered);
    }

    /// Evaluate a 2-card front hand into (category, score): HIGH_CARD (0) or PAIR (1). Mirror rankTwoPaiGow.
    function _rankTwo(uint8 a, uint8 b) private pure returns (uint256 category, uint256 score) {
        uint256 ra = _rank(a);
        uint256 rb = _rank(b);
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
        score = _pack(category, ordered);
    }

    /// The two highest ranks of a card set, descending (used by the high-card foul comparison).
    function _topTwo(uint8[5] memory cards) private pure returns (uint256 top0, uint256 top1) {
        for (uint256 i = 0; i < 5; i++) {
            uint256 r = _rank(cards[i]);
            if (r > top0) { top1 = top0; top0 = r; }
            else if (r > top1) top1 = r;
        }
    }

    /// The rank of the (single) pair in a 5-card hand known to be exactly a pair — for the foul compare.
    function _pairRankOf5(uint8[5] memory cards) private pure returns (uint256) {
        uint256[15] memory cnt;
        for (uint256 i = 0; i < 5; i++) cnt[_rank(cards[i])]++;
        for (uint256 rk = 14; rk >= 2; rk--) if (cnt[rk] == 2) return rk;
        return 0; // unreachable when the caller has established category == PAIR
    }

    /// Is the split a FOUL (front outranks back)? Mirror isFoul in paiGow.ts.
    function _isFoul(uint8[2] memory front, uint8[5] memory back) private pure returns (bool) {
        (uint256 fcat,) = _rankTwo(front[0], front[1]);
        (uint256 bcat,) = _rankFive(back);
        if (bcat >= 2) return false;
        if (bcat == 1) {
            if (fcat == 0) return false;
            uint256 backPair = _pairRankOf5(back);
            uint256 frontPair = _rank(front[0]); // front is a pair here
            return frontPair >= backPair;
        }
        // back is a high card
        if (fcat == 1) return true;
        uint256 f0 = _rank(front[0]);
        uint256 f1 = _rank(front[1]);
        (uint256 fHi, uint256 fLo) = f0 >= f1 ? (f0, f1) : (f1, f0);
        (uint256 bTop0, uint256 bTop1) = _topTwo(back);
        if (fHi > bTop0) return true;
        if (fHi == bTop0 && fLo > bTop1) return true;
        return false;
    }

    // ---------------------------------------------------------------------------
    // split + house way
    // ---------------------------------------------------------------------------

    /// Build the front (positions a,b) and back (the other 5) from a 7-card hand.
    function _split(uint8[7] memory seven, uint256 a, uint256 b)
        private
        pure
        returns (uint8[2] memory front, uint8[5] memory back)
    {
        front[0] = seven[a];
        front[1] = seven[b];
        uint256 k;
        for (uint256 p = 0; p < 7; p++) if (p != a && p != b) back[k++] = seven[p];
    }

    /// The HOUSE WAY of a 7-card hand: among all legal splits, the strongest back, tie-broken by the
    /// strongest front. Returns the (frontScore, backScore). Mirror houseWaySplit.
    function _houseWay(uint8[7] memory seven) private pure returns (uint256 frontScore, uint256 backScore) {
        bool have = false;
        for (uint256 i = 0; i < 7; i++) {
            for (uint256 j = i + 1; j < 7; j++) {
                (uint8[2] memory front, uint8[5] memory back) = _split(seven, i, j);
                if (_isFoul(front, back)) continue;
                (, uint256 fs) = _rankTwo(front[0], front[1]);
                (, uint256 bs) = _rankFive(back);
                if (!have || bs > backScore || (bs == backScore && fs > frontScore)) {
                    backScore = bs;
                    frontScore = fs;
                    have = true;
                }
            }
        }
    }

    // ---------------------------------------------------------------------------
    // dispute-replay settle
    // ---------------------------------------------------------------------------

    /// Adjudicate a disputed Pai Gow hand and return the conserved payout split. Reverts on a forged seed,
    /// an illegal front, or a claimed result that disagrees with the honest replay. `escrowPlayer` is the
    /// stake; the house escrow must cover an even-money win (2.00x, i.e. escrowHouse >= stake).
    function settle(PaiGowClaim memory claim, uint256 escrowPlayer, uint256 escrowHouse)
        internal
        pure
        returns (uint256 balancePlayer, uint256 balanceHouse)
    {
        if (commitLayout(claim.seed) != claim.commit) revert CommitMismatch();
        if (claim.frontA > 6 || claim.frontB > 6 || claim.frontA == claim.frontB) revert BadMove();
        if (claim.claimedResult > 2) revert ResultMismatch();

        uint8[52] memory deck = _shuffle(claim.seed);
        uint8[7] memory player;
        uint8[7] memory dealer;
        for (uint256 i = 0; i < 7; i++) {
            player[i] = deck[i];
            dealer[i] = deck[7 + i];
        }

        (uint8[2] memory pFront, uint8[5] memory pBack) = _split(player, claim.frontA, claim.frontB);

        uint8 result;
        if (_isFoul(pFront, pBack)) {
            result = 0; // fouled ⇒ loss
        } else {
            (, uint256 pFrontScore) = _rankTwo(pFront[0], pFront[1]);
            (, uint256 pBackScore) = _rankFive(pBack);
            (uint256 dFrontScore, uint256 dBackScore) = _houseWay(dealer);
            bool winsBack = pBackScore > dBackScore; // dealer wins copies (ties)
            bool winsFront = pFrontScore > dFrontScore;
            if (winsBack && winsFront) result = 2; // win
            else if (!winsBack && !winsFront) result = 0; // lose
            else result = 1; // push
        }

        if (result != claim.claimedResult) revert ResultMismatch();

        uint256 pot = escrowPlayer + escrowHouse;
        uint256 payout = result == 2 ? 2 * escrowPlayer : result == 1 ? escrowPlayer : 0;
        if (payout > pot) revert PayoutExceedsPot();
        balancePlayer = payout;
        balanceHouse = pot - payout;
    }
}

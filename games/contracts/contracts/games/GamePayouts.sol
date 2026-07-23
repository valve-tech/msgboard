// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameTables} from "./GameTables.sol";

/// Pure on-chain reproduction of the msgboard-games settlement math.
/// M1 mirrored dice + limbo; Phase-1 "free reskins" add crash (==limbo curve), monte and dicex2.
/// The "pure-RNG games on-chain" milestone added the seeded-deck card games — baccarat (11), dragon
/// tiger (12), andar bahar (13) — and the cascade tumbling slot (24). The "table games on-chain"
/// milestone adds plinko (3), keno (4), pachinko (7) and wheel (8): all are pure functions of the round
/// random `r` (no player decisions, no stored state), so they settle on this single-draw path. The RTP
/// tables are embedded (GameTables.sol) for plinko/pachinko/keno; wheel's uniform table is recomputed.
/// Returns the conserved (balancePlayer, balanceHouse) split for a single-draw round. Parity with
/// the TS reference is pinned by foundry vectors generated from the canonical game code.
///
/// STILL NOT mirrored on-chain: the STATEFUL/decision games (mines, the ladder family, three-card
/// poker, video poker, blackjack) whose recompute needs the per-step transcript, not just `r`. Those
/// track the separate "stateful games on-chain" milestone; meanwhile they ride the co-signed path.
library GamePayouts {
    error UnknownGame();

    // shared constants — mirror examples/games/msgboard-games/src/game.ts
    uint256 internal constant EDGE_BPS = 100;     // 1% house edge (bps)
    uint256 internal constant HUNDREDTHS = 100;   // 1.00x == 100
    uint256 internal constant BPS = 10_000;       // basis-point scale

    // dice — mirror src/games/dice.ts
    uint256 internal constant DICE_ROLL_SPACE = 10_000;
    uint256 internal constant DICE_MIN_TARGET = 1;
    uint256 internal constant DICE_MAX_TARGET = 9899;

    // limbo — mirror src/games/limbo.ts
    uint256 internal constant LIMBO_U_SPACE = 1_000_000;
    uint256 internal constant LIMBO_ONE_MINUS_EDGE_X100 = (10_000 - EDGE_BPS) / HUNDREDTHS; // 99
    uint256 internal constant LIMBO_MIN_TARGET = 100;                                       // 1.00x
    uint256 internal constant LIMBO_MAX_TARGET = LIMBO_ONE_MINUS_EDGE_X100 * LIMBO_U_SPACE; // 99_000_000

    // monte — mirror src/games/monte.ts (3 cards, pays SLOTS*(1-edge))
    uint256 internal constant MONTE_SLOTS = 3;

    // dicex2 — mirror src/games/dicex2.ts (two derived rolls; NUM = (1-edge)*ROLL_SPACE*HUNDREDTHS)
    uint256 internal constant DICEX2_MIN_TARGET = 100;
    uint256 internal constant DICEX2_MAX_TARGET = 9899;
    uint256 internal constant DICEX2_NUM = (DICE_ROLL_SPACE - EDGE_BPS) * DICE_ROLL_SPACE * HUNDREDTHS; // 9_900_000_000

    // cards — mirror src/cards.ts (52-card deck; rank = index/4 + 2, ace high = 14)
    uint256 internal constant DECK_SIZE = 52;

    // cascade — mirror src/games/cascade.ts (6×5 tumbling-grid slot)
    uint256 internal constant CASCADE_COLS = 6;
    uint256 internal constant CASCADE_ROWS = 5;
    uint256 internal constant CASCADE_CELLS = 30;
    uint256 internal constant CASCADE_SYMBOLS = 8;
    uint256 internal constant CASCADE_MIN_MATCH = 8;
    uint256 internal constant CASCADE_MAX_TUMBLES = 200;
    uint256 internal constant CASCADE_MAX_MULT_X100 = 5_000; // 50.00x hard cap (= escrow ceiling)

    function settle(
        uint8 gameId,
        uint256 r,
        bytes memory params,
        uint256 escrowPlayer,
        uint256 escrowHouse
    ) internal pure returns (uint256 balancePlayer, uint256 balanceHouse) {
        uint256 stake = escrowPlayer; // escrowFor: escrowPlayer == stake
        uint256 payout;

        if (gameId == 1) {
            payout = _dice(r, params, stake);
        } else if (gameId == 2) {
            payout = _limbo(r, params, stake);
        } else if (gameId == 6) {
            // crash (auto-cashout) is the limbo curve with target == autoCashout — identical math.
            payout = _limbo(r, params, stake);
        } else if (gameId == 9) {
            payout = _monte(r, params, stake);
        } else if (gameId == 10) {
            payout = _dicex2(r, params, stake);
        } else if (gameId == 3) {
            payout = _plinko(r, params, stake);
        } else if (gameId == 4) {
            payout = _keno(r, params, stake);
        } else if (gameId == 7) {
            payout = _pachinko(r, params, stake);
        } else if (gameId == 8) {
            payout = _wheel(r, params, stake);
        } else if (gameId == 11) {
            payout = _baccarat(r, params, stake);
        } else if (gameId == 12) {
            payout = _dragonTiger(r, params, stake);
        } else if (gameId == 13) {
            payout = _andarBahar(r, params, stake);
        } else if (gameId == 24) {
            payout = _cascade(r, stake);
        } else {
            revert UnknownGame();
        }

        uint256 pot = escrowPlayer + escrowHouse;
        require(payout <= pot, "payout exceeds pot"); // escrow ceiling guarantees this; assert for safety
        balancePlayer = payout;
        balanceHouse = pot - payout;
    }

    /// dice (gameId 1): roll-under target in hundredths of a percent. Ports diceMultiplierX100 +
    /// settleRound from src/games/dice.ts using the EXACT TS operation order:
    ///   multX100 = (ROLL_SPACE - EDGE_BPS) * ROLL_SPACE / targetX100 / HUNDREDTHS
    ///   payout   = win ? stake * multX100 / HUNDREDTHS : 0
    function _dice(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        uint256 targetX100 = abi.decode(params, (uint256));
        require(targetX100 >= DICE_MIN_TARGET && targetX100 <= DICE_MAX_TARGET, "dice: target out of range");
        uint256 roll = r % DICE_ROLL_SPACE;
        if (roll >= targetX100) return 0; // loss
        uint256 multX100 = (DICE_ROLL_SPACE - EDGE_BPS) * DICE_ROLL_SPACE / targetX100 / HUNDREDTHS;
        return stake * multX100 / HUNDREDTHS;
    }

    /// limbo (gameId 2): result = (1-edge)/(1-U). Ports limboResultX100 + settleRound from
    /// src/games/limbo.ts using the EXACT TS operation order:
    ///   u          = r % U_SPACE
    ///   resultX100 = (ONE_MINUS_EDGE_X100 * U_SPACE) / (U_SPACE - u)
    ///   win        = resultX100 >= targetX100
    ///   payout     = win ? stake * targetX100 / HUNDREDTHS : 0
    function _limbo(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        uint256 targetX100 = abi.decode(params, (uint256));
        require(targetX100 >= LIMBO_MIN_TARGET && targetX100 <= LIMBO_MAX_TARGET, "limbo: target out of range");
        uint256 u = r % LIMBO_U_SPACE;
        uint256 resultX100 = (LIMBO_ONE_MINUS_EDGE_X100 * LIMBO_U_SPACE) / (LIMBO_U_SPACE - u);
        if (resultX100 < targetX100) return 0; // loss
        return stake * targetX100 / HUNDREDTHS;
    }

    /// monte (gameId 9): three-card monte. Ports monteWinningSlot + monteMultiplierX100 + settleRound
    /// from src/games/monte.ts using the EXACT TS operation order:
    ///   winning = r % SLOTS
    ///   multX100 = SLOTS * HUNDREDTHS * (BPS - EDGE_BPS) / BPS    (3*100*9900/10000 = 297)
    ///   payout  = pick == winning ? stake * multX100 / HUNDREDTHS : 0
    function _monte(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        uint256 pick = abi.decode(params, (uint256));
        require(pick < MONTE_SLOTS, "monte: pick out of range");
        uint256 winning = r % MONTE_SLOTS;
        if (pick != winning) return 0;
        uint256 multX100 = MONTE_SLOTS * HUNDREDTHS * (BPS - EDGE_BPS) / BPS;
        return stake * multX100 / HUNDREDTHS;
    }

    /// dicex2 (gameId 10): two independent rolls derived from r via keccak (matches src/rng.ts
    /// subRandom: uint256(keccak256(abi.encode(uint256 r, uint64 index)))). Ports settleRound from
    /// src/games/dicex2.ts using the EXACT TS operation order:
    ///   roll_i = subRandom(r, i) % ROLL_SPACE
    ///   win    = mode==0 ? (roll1<target && roll2<target) : (roll1<target || roll2<target)
    ///   winCountScaled = mode==0 ? target^2 : ROLL_SPACE^2 - (ROLL_SPACE-target)^2
    ///   multX100 = NUM / winCountScaled ; payout = win ? stake * multX100 / HUNDREDTHS : 0
    /// params = abi.encode(uint256 targetX100, uint256 mode) ; mode 0 = both, 1 = either.
    function _dicex2(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        (uint256 targetX100, uint256 mode) = abi.decode(params, (uint256, uint256));
        require(targetX100 >= DICEX2_MIN_TARGET && targetX100 <= DICEX2_MAX_TARGET, "dicex2: target out of range");
        require(mode <= 1, "dicex2: bad mode");
        uint256 roll1 = uint256(keccak256(abi.encode(r, uint64(0)))) % DICE_ROLL_SPACE;
        uint256 roll2 = uint256(keccak256(abi.encode(r, uint64(1)))) % DICE_ROLL_SPACE;
        bool aUnder = roll1 < targetX100;
        bool bUnder = roll2 < targetX100;
        bool win = mode == 0 ? (aUnder && bUnder) : (aUnder || bUnder);
        if (!win) return 0;
        uint256 winCountScaled = mode == 0
            ? targetX100 * targetX100
            : DICE_ROLL_SPACE * DICE_ROLL_SPACE - (DICE_ROLL_SPACE - targetX100) * (DICE_ROLL_SPACE - targetX100);
        uint256 multX100 = DICEX2_NUM / winCountScaled;
        return stake * multX100 / HUNDREDTHS;
    }

    // ============================ seeded 52-card deck (mirror src/cards.ts) ============================

    /// Full Fisher–Yates shuffle of [0..51] driven by `r`, consuming base-(i+1) digits from the high end
    /// down (deck[i] <-> deck[j], j = r % (i+1)). IDENTICAL uint256 division order to shuffleDeck in
    /// src/cards.ts, so deck[0] is dealt first and the order matches the TS reference bit-for-bit.
    function _shuffle(uint256 r) private pure returns (uint8[52] memory deck) {
        for (uint256 k = 0; k < DECK_SIZE; k++) deck[k] = uint8(k);
        uint256 acc = r;
        for (uint256 i = DECK_SIZE - 1; i >= 1; i--) {
            uint256 window = i + 1;
            uint256 j = acc % window;
            acc = acc / window;
            (deck[i], deck[j]) = (deck[j], deck[i]);
        } // i never decrements below 1 to 0-and-continue: at i==1 the body runs, i-- -> 0, 0>=1 is false → exit
    }

    /// rank 2..14, ace high (index/4 + 2) — mirror rankOf in src/cards.ts.
    function _rank(uint8 card) private pure returns (uint256) {
        return uint256(card) / 4 + 2;
    }

    /// baccarat pip value: A=1, 2..9 face, 10/J/Q/K=0 — mirror baccaratValue in src/cards.ts.
    function _bacVal(uint8 card) private pure returns (uint256) {
        uint256 rk = _rank(card);
        if (rk == 14) return 1; // ace
        if (rk >= 10) return 0; // 10, J, Q, K
        return rk; // 2..9
    }

    /// dragon-tiger rank: ace LOW (1), else 2..13 — mirror dragonTigerRank in src/cards.ts.
    function _dtRank(uint8 card) private pure returns (uint256) {
        uint256 rk = _rank(card);
        return rk == 14 ? 1 : rk;
    }

    // ============================ pure-RNG card games (no player decisions) ============================

    /// baccarat (gameId 11): deal both hands from the shuffled deck per the FIXED third-card rules, pay
    /// the chosen bet. Ports dealBaccarat + settleRound from src/games/baccarat.ts. params = uint256 bet
    /// (0 player, 1 banker, 2 tie). Payout multiplier: player 200, banker 195, tie 900; a player/banker
    /// bet PUSHES on a tie (100 == stake back); a tie bet loses on a non-tie.
    function _baccarat(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        uint256 bet = abi.decode(params, (uint256));
        require(bet <= 2, "baccarat: bad bet");
        uint8[52] memory deck = _shuffle(r);
        uint256 ptr = 4;
        uint256 pSum = _bacVal(deck[0]) + _bacVal(deck[2]); // player cards 0,2
        uint256 bSum = _bacVal(deck[1]) + _bacVal(deck[3]); // banker cards 1,3
        uint256 pt = pSum % 10;
        uint256 bt = bSum % 10;

        if (pt < 8 && bt < 8) {
            // not a natural — apply the fixed draw rules
            bool playerDrew = false;
            uint256 playerThirdPip = 0;
            if (pt <= 5) {
                playerThirdPip = _bacVal(deck[ptr++]);
                pSum += playerThirdPip;
                pt = pSum % 10;
                playerDrew = true;
            }
            bool bankerDraws = !playerDrew ? (bt <= 5) : _bankerDrawsAfterPlayerThird(bt, playerThirdPip);
            if (bankerDraws) {
                bSum += _bacVal(deck[ptr++]);
                bt = bSum % 10;
            }
        }

        uint256 winner = pt > bt ? 0 : bt > pt ? 1 : 2; // 0 player, 1 banker, 2 tie
        uint256 multX100;
        if (winner == 2 && bet != 2) {
            multX100 = HUNDREDTHS; // push: player/banker bet returns the stake on a tie
        } else if (winner == bet) {
            multX100 = bet == 0 ? 200 : bet == 1 ? 195 : 900;
        } else {
            multX100 = 0;
        }
        return stake * multX100 / HUNDREDTHS;
    }

    /// banker third-card rule given the banker's 2-card total and the player's third-card pip — mirror
    /// bankerDrawsAfterPlayerThird in src/games/baccarat.ts.
    function _bankerDrawsAfterPlayerThird(uint256 bankerTotal, uint256 pip) private pure returns (bool) {
        if (bankerTotal <= 2) return true;
        if (bankerTotal == 3) return pip != 8;
        if (bankerTotal == 4) return pip >= 2 && pip <= 7;
        if (bankerTotal == 5) return pip >= 4 && pip <= 7;
        if (bankerTotal == 6) return pip >= 6 && pip <= 7;
        return false; // 7 stands
    }

    /// dragon tiger (gameId 12): one card each (deck[0] dragon, deck[1] tiger), higher rank wins, ace
    /// low. Ports dealDragonTiger + settleRound from src/games/dragonTiger.ts. params = uint256 bet
    /// (0 dragon, 1 tiger, 2 tie). Win pays 200 (dragon/tiger) or 1200 (tie); on a tie a dragon/tiger
    /// bet returns HALF (50).
    function _dragonTiger(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        uint256 bet = abi.decode(params, (uint256));
        require(bet <= 2, "dragon-tiger: bad bet");
        uint8[52] memory deck = _shuffle(r);
        uint256 dr = _dtRank(deck[0]);
        uint256 tr = _dtRank(deck[1]);
        uint256 winner = dr > tr ? 0 : tr > dr ? 1 : 2; // 0 dragon, 1 tiger, 2 tie
        uint256 multX100;
        if (winner == 2 && bet != 2) {
            multX100 = 50; // tie, dragon/tiger bet: lose half
        } else if (winner == bet) {
            multX100 = bet == 2 ? 1200 : 200;
        } else {
            multX100 = 0;
        }
        return stake * multX100 / HUNDREDTHS;
    }

    /// andar bahar (gameId 13): reveal joker (deck[0]); deal alternately Andar (first), Bahar… until the
    /// joker RANK is matched; the matching side wins. Ports dealAndarBahar + settleRound from
    /// src/games/andarBahar.ts. params = uint256 bet (0 andar, 1 bahar). Andar pays 190, Bahar 200.
    function _andarBahar(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        uint256 bet = abi.decode(params, (uint256));
        require(bet <= 1, "andar-bahar: bad bet");
        uint8[52] memory deck = _shuffle(r);
        uint256 jokerRank = _rank(deck[0]);
        uint256 turn = 0; // 0 andar, 1 bahar
        uint256 winner = 2; // sentinel; a match is guaranteed (3 of the joker rank remain)
        for (uint256 i = 1; i < DECK_SIZE; i++) {
            if (_rank(deck[i]) == jokerRank) {
                winner = turn;
                break;
            }
            turn = turn == 0 ? 1 : 0;
        }
        require(winner != 2, "andar-bahar: no match"); // unreachable for a full deck
        uint256 multX100 = winner == bet ? (bet == 0 ? 190 : 200) : 0;
        return stake * multX100 / HUNDREDTHS;
    }

    // ================================ cascade tumbling slot (gameId 24) ================================

    /// per-symbol base pay (×100 of bet) for the smallest cluster — mirror SYMBOL_BASE_X100 in cascade.ts.
    function _cascadeSymBase(uint256 s) private pure returns (uint256) {
        if (s == 0) return 66;
        if (s == 1) return 82;
        if (s == 2) return 99;
        if (s == 3) return 132;
        if (s == 4) return 181;
        if (s == 5) return 264;
        if (s == 6) return 429;
        return 742;
    }

    /// pay for a winning cluster of `count` cells of `symbol` — mirror cascadePayX100 in cascade.ts.
    function _cascadePay(uint256 symbol, uint256 count) private pure returns (uint256) {
        uint256 factor = count >= 12 ? 12 : count >= 10 ? 3 : 1;
        return _cascadeSymBase(symbol) * factor;
    }

    /// the symbol for the cell filled at stream position `index` — mirror cascadeSymbol (subRandom % 8).
    function _cascadeSymbol(uint256 r, uint256 index) private pure returns (uint8) {
        return uint8(uint256(keccak256(abi.encode(r, uint64(index)))) % CASCADE_SYMBOLS);
    }

    /// cascade (gameId 24): a 6×5 tumbling-grid slot. Scatter-pays at 8+ of a symbol; winners clear,
    /// survivors fall, fresh symbols drop in from the seed stream, repeat until no match. Ports
    /// resolveCascade from src/games/cascade.ts EXACTLY (grid index = row*6+col, row 0 top; survivors
    /// fall bottom-up; refills top-down). The total is hard-capped at 50.00x (the escrow ceiling) with a
    /// bounded tumble count, so it always terminates. Pure but keccak-heavy — a dispute-only recompute.
    function _cascade(uint256 r, uint256 stake) private pure returns (uint256) {
        uint8[30] memory grid;
        for (uint256 i = 0; i < CASCADE_CELLS; i++) grid[i] = _cascadeSymbol(r, i);
        uint256 nextIndex = CASCADE_CELLS;
        uint256 totalX100 = 0;

        for (uint256 t = 0; t < CASCADE_MAX_TUMBLES; t++) {
            uint256[8] memory counts;
            for (uint256 c = 0; c < CASCADE_CELLS; c++) counts[grid[c]]++;

            bool[8] memory isWinner;
            bool any = false;
            uint256 stepPay = 0;
            for (uint256 s = 0; s < CASCADE_SYMBOLS; s++) {
                if (counts[s] >= CASCADE_MIN_MATCH) {
                    isWinner[s] = true;
                    any = true;
                    stepPay += _cascadePay(s, counts[s]);
                }
            }
            if (!any) break;

            totalX100 += stepPay;
            if (totalX100 >= CASCADE_MAX_MULT_X100) {
                totalX100 = CASCADE_MAX_MULT_X100;
                break;
            }

            // collapse: per column, survivors fall to the bottom (keeping order); empties refill top-down.
            for (uint256 col = 0; col < CASCADE_COLS; col++) {
                uint8[5] memory survivors;
                uint256 sn = 0;
                for (uint256 k = 0; k < CASCADE_ROWS; k++) {
                    uint256 idx = (CASCADE_ROWS - 1 - k) * CASCADE_COLS + col; // bottom-up
                    if (!isWinner[grid[idx]]) survivors[sn++] = grid[idx];
                }
                for (uint256 k = 0; k < CASCADE_ROWS; k++) {
                    uint256 idx = (CASCADE_ROWS - 1 - k) * CASCADE_COLS + col;
                    if (k < sn) grid[idx] = survivors[k]; // k == fromBottom
                    else { grid[idx] = _cascadeSymbol(r, nextIndex); nextIndex++; }
                }
            }
        }
        return stake * totalX100 / HUNDREDTHS;
    }

    // ================================ table games (single-draw, RTP tables) ================================

    /// apply the standard 1% house edge to a fair multiplier (×100), flooring — mirrors the TS edge
    /// helpers (plinkoEdgedX100 / wheelEdgedX100 / keno.applyEdgeX100 are all floor(fair*9900/10000)).
    function _edgedX100(uint256 fair) private pure returns (uint256) {
        return fair * (BPS - EDGE_BPS) / BPS;
    }

    /// count the set bits in the low `bits` bits of `r` — the binomial bucket/slot for plinko/pachinko
    /// (one seed bit per row; mirror plinkoBucket in src/games/plinko.ts).
    function _popcount(uint256 r, uint256 bits) private pure returns (uint256 c) {
        for (uint256 i = 0; i < bits; i++) if ((r >> i) & 1 == 1) c++;
    }

    /// plinko (gameId 3): land in bucket = popcount(low 16 bits); pay the edged table value. Always pays
    /// stake*mult/100 (sub-1x buckets return a partial). params = abi.encode(uint256 rows, uint256 riskIdx)
    /// with riskIdx 0=low 1=medium 2=high. Only rows=16 is shipped (the single reference table).
    function _plinko(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        (uint256 rows, uint256 riskIdx) = abi.decode(params, (uint256, uint256));
        require(rows == 16, "plinko: only rows=16 mirrored");
        uint256 mult = _edgedX100(GameTables.plinkoFair(riskIdx, _popcount(r, 16)));
        return stake * mult / HUNDREDTHS;
    }

    /// pachinko (gameId 7): identical engine to plinko, own table. rows=12, slot = popcount(low 12 bits).
    function _pachinko(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        (uint256 rows, uint256 riskIdx) = abi.decode(params, (uint256, uint256));
        require(rows == 12, "pachinko: only rows=12 mirrored");
        uint256 mult = _edgedX100(GameTables.pachinkoFair(riskIdx, _popcount(r, 12)));
        return stake * mult / HUNDREDTHS;
    }

    /// wheel shape value at segment `i` — mirror wheelShape in src/games/wheel.ts (riskIdx 0=low 1=med 2=high).
    function _wheelShapeAt(uint256 riskIdx, uint256 segments, uint256 i) private pure returns (uint256) {
        if (riskIdx == 0) return (i % 5 == 0) ? 0 : 13; // low: ~20% lose, rest near-flat
        if (riskIdx == 1) return (i == segments - 1) ? 90 : (i % 2 == 0 ? 0 : 20); // medium: half lose + spike
        return (i == segments - 1) ? 1 : 0; // high: single jackpot
    }

    /// wheel (gameId 8): segment = r % segments; pay the edged table value. The table is UNIFORM-weighted,
    /// so it is recomputed on-chain (no embed): fair[i] = floor(shape[i]*segments*100/sumShape), with the
    /// whole flooring deficit added to the lowest-index winner — exactly what scaledFairTableX100 does for
    /// uniform weights. params = abi.encode(uint256 segments, uint256 riskIdx).
    function _wheel(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        (uint256 segments, uint256 riskIdx) = abi.decode(params, (uint256, uint256));
        require(riskIdx < 3, "wheel: bad risk");
        require(
            segments == 10 || segments == 20 || segments == 30 || segments == 40 || segments == 50,
            "wheel: unsupported segments"
        );
        uint256 segment = r % segments;
        uint256 target = segments * HUNDREDTHS;

        uint256 sumShape = 0;
        for (uint256 i = 0; i < segments; i++) sumShape += _wheelShapeAt(riskIdx, segments, i);

        uint256 flooredSum = 0;
        uint256 firstWinner = type(uint256).max;
        for (uint256 i = 0; i < segments; i++) {
            uint256 sh = _wheelShapeAt(riskIdx, segments, i);
            flooredSum += sh * target / sumShape;
            if (sh > 0 && firstWinner == type(uint256).max) firstWinner = i;
        }
        uint256 deficit = target - flooredSum;

        uint256 fair = _wheelShapeAt(riskIdx, segments, segment) * target / sumShape;
        if (segment == firstWinner) fair += deficit; // uniform weights → entire deficit on the first winner
        uint256 mult = _edgedX100(fair);
        return stake * mult / HUNDREDTHS;
    }

    /// keno (gameId 4): draw 10 of 40 (Fisher-Yates partial, mirror kenoDraw), count hits among `picks`,
    /// pay the edged table value for (pickCount, hits) — but ONLY when the edged multiplier exceeds 1.00x
    /// (keno's win is strict; sub-1x rows pay nothing, unlike plinko). params = abi.encode(uint256[] picks).
    function _keno(uint256 r, bytes memory params, uint256 stake) private pure returns (uint256) {
        uint256[] memory picks = abi.decode(params, (uint256[]));
        uint256 p = picks.length;
        require(p >= 1 && p <= 10, "keno: picks 1..10");

        // draw 10 distinct of 40 via a partial Fisher-Yates from `r` (pool holds values 1..40).
        uint8[40] memory pool;
        for (uint256 k = 0; k < 40; k++) pool[k] = uint8(k + 1);
        bool[41] memory drawn; // indexed by value 1..40
        uint256 acc = r;
        for (uint256 i = 39; i >= 30; i--) {
            uint256 window = i + 1;
            uint256 j = acc % window;
            acc = acc / window;
            (pool[i], pool[j]) = (pool[j], pool[i]);
            drawn[pool[i]] = true;
        } // i stops at 30: body runs, i-- -> 29, 29>=30 false → exit (no underflow)

        uint256 hits = 0;
        for (uint256 m = 0; m < p; m++) {
            uint256 pick = picks[m];
            if (pick >= 1 && pick <= 40 && drawn[pick]) hits++;
        }

        uint256 mult = _edgedX100(GameTables.kenoFair(p, hits));
        return mult > HUNDREDTHS ? stake * mult / HUNDREDTHS : 0;
    }
}

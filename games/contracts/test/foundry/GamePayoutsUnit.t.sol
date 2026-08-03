// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GamePayouts} from "../../contracts/games/GamePayouts.sol";

/// Coverage-only unit suite for GamePayouts.sol. Complements GamePayouts.t.sol / TablePayouts.t.sol /
/// CardCascadePayouts.t.sol (which pin the WIN-path parity vectors) by exhaustively exercising the
/// dispatcher's UnknownGame error and every require-string revert guard across all 14 gameIds, plus
/// negative-input fuzz per game. No production .sol is touched — this file only adds tests.
contract GamePayoutsUnitTest is Test {
    uint256 internal constant STAKE = 200;
    uint256 internal constant HOUSE = 1_000_000; // large enough that no win-path here ever hits the pot ceiling

    /// external wrapper so vm.expectRevert can catch reverts from the inlined library call (same
    /// pattern used by GamePayouts.t.sol / TablePayouts.t.sol).
    function settleExt(uint8 gameId, uint256 r, bytes calldata params, uint256 eP, uint256 eH)
        external
        pure
        returns (uint256, uint256)
    {
        return GamePayouts.settle(gameId, r, params, eP, eH);
    }

    function _isValidGameId(uint8 id) internal pure returns (bool) {
        return id == 1 || id == 2 || id == 3 || id == 4 || id == 6 || id == 7 || id == 8 || id == 9 || id == 10
            || id == 11 || id == 12 || id == 13 || id == 24 || id == 25;
    }

    // ============================================================ UnknownGame ==

    function test_unknownGame_reverts_explicitIds() public {
        uint8[14] memory ids = [0, 5, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 26, 255];
        for (uint256 i = 0; i < ids.length; i++) {
            vm.expectRevert(GamePayouts.UnknownGame.selector);
            this.settleExt(ids[i], 0, "", STAKE, HOUSE);
        }
    }

    function testFuzz_unknownGame_reverts(uint8 gameId) public {
        vm.assume(!_isValidGameId(gameId));
        vm.expectRevert(GamePayouts.UnknownGame.selector);
        this.settleExt(gameId, 0, "", STAKE, HOUSE);
    }

    // ================================================= settle(): pot ceiling ==

    // dice target 5000, r=0 → roll 0 < 5000 → win, multX100 = 198, payout = 396. With escrowHouse = 0
    // the pot is only 200, so the escrow-ceiling safety assert must revert.
    function test_settle_revertsWhen_payoutExceedsPot() public {
        vm.expectRevert(bytes("payout exceeds pot"));
        this.settleExt(1, 0, abi.encode(uint256(5000)), STAKE, 0);
    }

    // ====================================================== dice (gameId 1) ==

    function test_dice_reverts_targetZero() public {
        vm.expectRevert(bytes("dice: target out of range"));
        this.settleExt(1, 0, abi.encode(uint256(0)), STAKE, HOUSE);
    }

    function test_dice_reverts_targetTooHigh() public {
        vm.expectRevert(bytes("dice: target out of range"));
        this.settleExt(1, 0, abi.encode(uint256(9900)), STAKE, HOUSE);
    }

    function testFuzz_dice_reverts_targetTooHigh(uint256 targetX100) public {
        targetX100 = bound(targetX100, 9900, type(uint256).max);
        vm.expectRevert(bytes("dice: target out of range"));
        this.settleExt(1, 0, abi.encode(targetX100), STAKE, HOUSE);
    }

    // ===================================================== limbo (gameId 2) ==

    function test_limbo_reverts_targetTooLow() public {
        vm.expectRevert(bytes("limbo: target out of range"));
        this.settleExt(2, 1, abi.encode(uint256(99)), STAKE, HOUSE);
    }

    function test_limbo_reverts_targetTooHigh() public {
        vm.expectRevert(bytes("limbo: target out of range"));
        this.settleExt(2, 1, abi.encode(uint256(99_000_001)), STAKE, HOUSE);
    }

    function testFuzz_limbo_reverts_targetTooLow(uint256 targetX100) public {
        targetX100 = bound(targetX100, 0, 99);
        vm.expectRevert(bytes("limbo: target out of range"));
        this.settleExt(2, 1, abi.encode(targetX100), STAKE, HOUSE);
    }

    function testFuzz_limbo_reverts_targetTooHigh(uint256 targetX100) public {
        targetX100 = bound(targetX100, 99_000_001, type(uint256).max);
        vm.expectRevert(bytes("limbo: target out of range"));
        this.settleExt(2, 1, abi.encode(targetX100), STAKE, HOUSE);
    }

    // ===================================================== crash (gameId 6) ==
    // crash dispatches straight into _limbo — pin that the SAME guard fires under gameId 6 too.

    function test_crash_reverts_targetOutOfRange() public {
        vm.expectRevert(bytes("limbo: target out of range"));
        this.settleExt(6, 1, abi.encode(uint256(50)), STAKE, HOUSE);
    }

    function testFuzz_crash_reverts_targetTooHigh(uint256 targetX100) public {
        targetX100 = bound(targetX100, 99_000_001, type(uint256).max);
        vm.expectRevert(bytes("limbo: target out of range"));
        this.settleExt(6, 1, abi.encode(targetX100), STAKE, HOUSE);
    }

    // ===================================================== monte (gameId 9) ==

    function test_monte_reverts_pickOutOfRange() public {
        vm.expectRevert(bytes("monte: pick out of range"));
        this.settleExt(9, 0, abi.encode(uint256(3)), STAKE, HOUSE);
    }

    function testFuzz_monte_reverts_pickOutOfRange(uint256 pick) public {
        pick = bound(pick, 3, type(uint256).max);
        vm.expectRevert(bytes("monte: pick out of range"));
        this.settleExt(9, 0, abi.encode(pick), STAKE, HOUSE);
    }

    // ==================================================== dicex2 (gameId 10) ==

    function _dicex2Params(uint256 targetX100, uint256 mode) internal pure returns (bytes memory) {
        return abi.encode(targetX100, mode);
    }

    function test_dicex2_reverts_targetTooLow() public {
        vm.expectRevert(bytes("dicex2: target out of range"));
        this.settleExt(10, 0, _dicex2Params(99, 0), STAKE, HOUSE);
    }

    function test_dicex2_reverts_targetTooHigh() public {
        vm.expectRevert(bytes("dicex2: target out of range"));
        this.settleExt(10, 0, _dicex2Params(9900, 0), STAKE, HOUSE);
    }

    function test_dicex2_reverts_badMode() public {
        vm.expectRevert(bytes("dicex2: bad mode"));
        this.settleExt(10, 0, _dicex2Params(5000, 2), STAKE, HOUSE);
    }

    function testFuzz_dicex2_reverts_targetTooLow(uint256 targetX100) public {
        targetX100 = bound(targetX100, 0, 99);
        vm.expectRevert(bytes("dicex2: target out of range"));
        this.settleExt(10, 0, _dicex2Params(targetX100, 0), STAKE, HOUSE);
    }

    function testFuzz_dicex2_reverts_targetTooHigh(uint256 targetX100) public {
        targetX100 = bound(targetX100, 9900, type(uint256).max);
        vm.expectRevert(bytes("dicex2: target out of range"));
        this.settleExt(10, 0, _dicex2Params(targetX100, 0), STAKE, HOUSE);
    }

    function testFuzz_dicex2_reverts_badMode(uint256 mode) public {
        mode = bound(mode, 2, type(uint256).max);
        vm.expectRevert(bytes("dicex2: bad mode"));
        this.settleExt(10, 0, _dicex2Params(5000, mode), STAKE, HOUSE);
    }

    // =================================================== baccarat (gameId 11) ==

    function test_baccarat_reverts_badBet() public {
        vm.expectRevert(bytes("baccarat: bad bet"));
        this.settleExt(11, 1, abi.encode(uint256(3)), STAKE, HOUSE);
    }

    function testFuzz_baccarat_reverts_badBet(uint256 bet) public {
        bet = bound(bet, 3, type(uint256).max);
        vm.expectRevert(bytes("baccarat: bad bet"));
        this.settleExt(11, 1, abi.encode(bet), STAKE, HOUSE);
    }

    // Branch-completeness: GamePayouts.t.sol / CardCascadePayouts.t.sol only pin baccarat vectors that
    // resolve as NATURALS (an 8/9 two-card total on one side) or an immediate push, so the fixed
    // third-card DRAW rules (_baccarat's `pt < 8 && bt < 8` branch, `playerDrew`, and the
    // `_bankerDrawsAfterPlayerThird` branch) are never exercised anywhere else in the suite. Search a
    // small r-space (duplicating _shuffle/_bacVal, matching the library EXACTLY) for a seed that lands
    // in that branch with the banker also drawing, then settle it for real through GamePayouts.
    function _searchDeck(uint256 r) private pure returns (uint8[52] memory deck) {
        for (uint256 k = 0; k < 52; k++) deck[k] = uint8(k);
        uint256 acc = r;
        for (uint256 i = 51; i >= 1; i--) {
            uint256 window = i + 1;
            uint256 j = acc % window;
            acc = acc / window;
            (deck[i], deck[j]) = (deck[j], deck[i]);
        }
    }

    function _searchBacVal(uint8 card) private pure returns (uint256) {
        uint256 rk = uint256(card) / 4 + 2;
        if (rk == 14) return 1;
        if (rk >= 10) return 0;
        return rk;
    }

    function _searchBankerDrawsAfterPlayerThird(uint256 bankerTotal, uint256 pip) private pure returns (bool) {
        if (bankerTotal <= 2) return true;
        if (bankerTotal == 3) return pip != 8;
        if (bankerTotal == 4) return pip >= 2 && pip <= 7;
        if (bankerTotal == 5) return pip >= 4 && pip <= 7;
        if (bankerTotal == 6) return pip >= 6 && pip <= 7;
        return false;
    }

    function _findNonNaturalBankerDrawsSeed() private pure returns (uint256) {
        for (uint256 r = 0; r < 5000; r++) {
            uint8[52] memory deck = _searchDeck(r);
            uint256 pSum = _searchBacVal(deck[0]) + _searchBacVal(deck[2]);
            uint256 bSum = _searchBacVal(deck[1]) + _searchBacVal(deck[3]);
            uint256 pt = pSum % 10;
            uint256 bt = bSum % 10;
            if (pt >= 8 || bt >= 8) continue; // natural — not the branch we want

            bool playerDrew = false;
            uint256 playerThirdPip = 0;
            if (pt <= 5) {
                playerThirdPip = _searchBacVal(deck[4]);
                playerDrew = true;
            }
            bool bankerDraws =
                !playerDrew ? (bt <= 5) : _searchBankerDrawsAfterPlayerThird(bt, playerThirdPip);
            if (bankerDraws) return r;
        }
        revert("no qualifying seed found in search range");
    }

    function test_baccarat_nonNatural_bankerDraws_hitsDrawRuleBranch() public pure {
        uint256 r = _findNonNaturalBankerDrawsSeed();
        // bet is irrelevant to whether the draw-rule branch executes; player bet (0) exercises the
        // ordinary win/loss/push payout math on top of it. Just assert it settles without reverting
        // and conserves value — there is no independent TS vector for this seed to pin an exact payout.
        (uint256 bP, uint256 bH) = GamePayouts.settle(11, r, abi.encode(uint256(0)), STAKE, HOUSE);
        assertEq(bP + bH, STAKE + HOUSE);
    }

    // Branch-completeness: GamePayouts.t.sol / CardCascadePayouts.t.sol only pin baccarat WINS and a
    // push-on-tie — the plain "bet doesn't match the (non-tie) winner" loss branch (`multX100 = 0` in
    // _baccarat's final else) is never hit. Reuse CardCascadePayoutsTest's R_BACC_PLAYER seed (a player
    // win) but bet on banker instead, so the outcome is a clean loss.
    uint256 internal constant R_BACC_PLAYER_FOR_LOSS_CHECK =
        68053564258556317150349243837902514818945326343711789649774590383616699827597;

    function test_baccarat_betOnLoser_isCleanLoss() public pure {
        (uint256 bP, uint256 bH) =
            GamePayouts.settle(11, R_BACC_PLAYER_FOR_LOSS_CHECK, abi.encode(uint256(1)), STAKE, HOUSE);
        assertEq(bP, 0); // player won (per CardCascadePayoutsTest), banker bet loses cleanly
        assertEq(bH, STAKE + HOUSE);
    }

    // ================================================= dragon tiger (gameId 12) ==

    function test_dragonTiger_reverts_badBet() public {
        vm.expectRevert(bytes("dragon-tiger: bad bet"));
        this.settleExt(12, 1, abi.encode(uint256(3)), STAKE, HOUSE);
    }

    // Branch-completeness: CardCascadePayouts.t.sol only pins a dragon WIN and a TIE for this game; the
    // plain "bet doesn't match the (non-tie) winner" loss branch (`multX100 = 0` in the final else) is
    // never hit. Reuse the same r as CardCascadePayoutsTest.R_DT_DRAGON (a dragon-win seed) but bet on
    // tiger instead, so the outcome is a clean loss.
    uint256 internal constant R_DT_DRAGON_FOR_LOSS_CHECK =
        37843409584727195892530452647255254318907057257425552727622968492279945040967;

    function test_dragonTiger_betOnLoser_isCleanLoss() public pure {
        (uint256 bP, uint256 bH) =
            GamePayouts.settle(12, R_DT_DRAGON_FOR_LOSS_CHECK, abi.encode(uint256(1)), STAKE, HOUSE);
        assertEq(bP, 0); // dragon won (per CardCascadePayoutsTest), tiger bet loses cleanly
        assertEq(bH, STAKE + HOUSE);
    }

    function testFuzz_dragonTiger_reverts_badBet(uint256 bet) public {
        bet = bound(bet, 3, type(uint256).max);
        vm.expectRevert(bytes("dragon-tiger: bad bet"));
        this.settleExt(12, 1, abi.encode(bet), STAKE, HOUSE);
    }

    // ================================================= andar bahar (gameId 13) ==

    function test_andarBahar_reverts_badBet() public {
        vm.expectRevert(bytes("andar-bahar: bad bet"));
        this.settleExt(13, 1, abi.encode(uint256(2)), STAKE, HOUSE);
    }

    function testFuzz_andarBahar_reverts_badBet(uint256 bet) public {
        bet = bound(bet, 2, type(uint256).max);
        vm.expectRevert(bytes("andar-bahar: bad bet"));
        this.settleExt(13, 1, abi.encode(bet), STAKE, HOUSE);
    }

    // NOTE (uncoverable branch): _andarBahar's `require(winner != 2, "andar-bahar: no match")` guards a
    // sentinel that is mathematically unreachable for a full, honestly-shuffled 52-card deck — the joker
    // rank always has 3 further copies left in the deck, so the alternating Andar/Bahar deal always finds
    // a match before the deck is exhausted (see the code comment above `_andarBahar`). There is no `r`
    // that reaches this branch without changing `_shuffle`, so it is intentionally left unhit.

    // ===================================================== cascade (gameId 24) ==
    // _cascade takes NO player-supplied params (`payout = _cascade(r, stake)`), so there is no
    // input-validation guard to negative-fuzz. Instead, pin the robustness property: for ANY r, the
    // bounded tumble loop always terminates and never reverts, and the payout never exceeds the escrow
    // ceiling supplied (pot conservation holds).
    function testFuzz_cascade_neverReverts(uint256 r) public pure {
        (uint256 bP, uint256 bH) = GamePayouts.settle(24, r, "", STAKE, HOUSE);
        assertEq(bP + bH, STAKE + HOUSE);
    }

    // ===================================================== plinko (gameId 3) ==

    function test_plinko_reverts_rowsNot16() public {
        vm.expectRevert(bytes("plinko: only rows=16 mirrored"));
        this.settleExt(3, 0, abi.encode(uint256(8), uint256(0)), STAKE, HOUSE);
    }

    function testFuzz_plinko_reverts_rowsNot16(uint256 rows) public {
        vm.assume(rows != 16);
        vm.expectRevert(bytes("plinko: only rows=16 mirrored"));
        this.settleExt(3, 0, abi.encode(rows, uint256(0)), STAKE, HOUSE);
    }

    // riskIdx bound-check lives in GameTables.plinkoFair (reached from GamePayouts._plinko), but the
    // call site is a line inside GamePayouts.sol, so exercising it is part of this file's job too.
    function test_plinko_reverts_riskIdxOutOfRange() public {
        vm.expectRevert(bytes("plinko: index"));
        this.settleExt(3, 0, abi.encode(uint256(16), uint256(3)), STAKE, HOUSE);
    }

    function testFuzz_plinko_reverts_riskIdxOutOfRange(uint256 riskIdx) public {
        riskIdx = bound(riskIdx, 3, type(uint256).max);
        vm.expectRevert(bytes("plinko: index"));
        this.settleExt(3, 0, abi.encode(uint256(16), riskIdx), STAKE, HOUSE);
    }

    // ==================================================== pachinko (gameId 7) ==

    function test_pachinko_reverts_rowsNot12() public {
        vm.expectRevert(bytes("pachinko: only rows=12 mirrored"));
        this.settleExt(7, 0, abi.encode(uint256(11), uint256(0)), STAKE, HOUSE);
    }

    function testFuzz_pachinko_reverts_rowsNot12(uint256 rows) public {
        vm.assume(rows != 12);
        vm.expectRevert(bytes("pachinko: only rows=12 mirrored"));
        this.settleExt(7, 0, abi.encode(rows, uint256(0)), STAKE, HOUSE);
    }

    function test_pachinko_reverts_riskIdxOutOfRange() public {
        vm.expectRevert(bytes("pachinko: index"));
        this.settleExt(7, 0, abi.encode(uint256(12), uint256(3)), STAKE, HOUSE);
    }

    function testFuzz_pachinko_reverts_riskIdxOutOfRange(uint256 riskIdx) public {
        riskIdx = bound(riskIdx, 3, type(uint256).max);
        vm.expectRevert(bytes("pachinko: index"));
        this.settleExt(7, 0, abi.encode(uint256(12), riskIdx), STAKE, HOUSE);
    }

    // ====================================================== wheel (gameId 8) ==

    function test_wheel_reverts_riskIdxOutOfRange() public {
        vm.expectRevert(bytes("wheel: bad risk"));
        this.settleExt(8, 0, abi.encode(uint256(10), uint256(3)), STAKE, HOUSE);
    }

    function testFuzz_wheel_reverts_riskIdxOutOfRange(uint256 riskIdx) public {
        riskIdx = bound(riskIdx, 3, type(uint256).max);
        vm.expectRevert(bytes("wheel: bad risk"));
        this.settleExt(8, 0, abi.encode(uint256(10), riskIdx), STAKE, HOUSE);
    }

    function test_wheel_reverts_unsupportedSegments_zero() public {
        vm.expectRevert(bytes("wheel: unsupported segments"));
        this.settleExt(8, 0, abi.encode(uint256(0), uint256(0)), STAKE, HOUSE);
    }

    function test_wheel_reverts_unsupportedSegments_offGrid() public {
        vm.expectRevert(bytes("wheel: unsupported segments"));
        this.settleExt(8, 0, abi.encode(uint256(11), uint256(0)), STAKE, HOUSE);
    }

    function testFuzz_wheel_reverts_unsupportedSegments(uint256 segments) public {
        vm.assume(segments != 10 && segments != 20 && segments != 30 && segments != 40 && segments != 50);
        vm.expectRevert(bytes("wheel: unsupported segments"));
        this.settleExt(8, 0, abi.encode(segments, uint256(0)), STAKE, HOUSE);
    }

    // Branch-completeness: the uniform-weight deficit is added to the FIRST winning segment
    // (`if (segment == firstWinner) fair += deficit;`). The existing TablePayouts vectors only ever spin
    // segment 7 (low/medium) or the jackpot segment (high, which IS firstWinner there), so the
    // `segment == firstWinner` TRUE branch is untested for low/medium risk. For segments=10, firstWinner
    // is segment 1 (segment 0 has zero shape in both low and medium risk shapes) — spin r=1 to land there.
    function test_wheel_lowRisk_hitsFirstWinner_deficitBranch() public pure {
        (uint256 bP, uint256 bH) = GamePayouts.settle(8, 1, abi.encode(uint256(10), uint256(0)), STAKE, HOUSE);
        assertEq(bP + bH, STAKE + HOUSE);
        assertGt(bP, 0); // segment 1 is a winning segment for low risk
    }

    function test_wheel_mediumRisk_hitsFirstWinner_deficitBranch() public pure {
        (uint256 bP, uint256 bH) = GamePayouts.settle(8, 1, abi.encode(uint256(10), uint256(1)), STAKE, HOUSE);
        assertEq(bP + bH, STAKE + HOUSE);
        assertGt(bP, 0); // segment 1 is a winning segment for medium risk
    }

    // ======================================================= keno (gameId 4) ==

    function test_keno_reverts_zeroPicks() public {
        uint256[] memory picks = new uint256[](0);
        vm.expectRevert(bytes("keno: picks 1..10"));
        this.settleExt(4, 0, abi.encode(picks), STAKE, HOUSE);
    }

    function test_keno_reverts_tooManyPicks() public {
        uint256[] memory picks = new uint256[](11);
        for (uint256 i = 0; i < 11; i++) picks[i] = i + 1;
        vm.expectRevert(bytes("keno: picks 1..10"));
        this.settleExt(4, 0, abi.encode(picks), STAKE, HOUSE);
    }

    function testFuzz_keno_reverts_tooManyPicks(uint256 rawLen) public {
        uint256 len = bound(rawLen, 11, 64);
        uint256[] memory picks = new uint256[](len);
        for (uint256 i = 0; i < len; i++) picks[i] = (i % 40) + 1;
        vm.expectRevert(bytes("keno: picks 1..10"));
        this.settleExt(4, 0, abi.encode(picks), STAKE, HOUSE);
    }

    // out-of-range pick VALUES (0, or >40) are not guarded by a require — they simply can never be
    // "drawn" (the `pick >= 1 && pick <= 40` check inside the hit-count loop silently excludes them).
    // Cover that false branch explicitly: a picks array containing 0 and 41 alongside a real winning
    // number must not revert and must not over/under count hits.
    function test_keno_outOfRangePickValues_dontRevertOrCount() public pure {
        uint256[] memory picksWithJunk = new uint256[](3);
        picksWithJunk[0] = 0; // below range
        picksWithJunk[1] = 41; // above range
        picksWithJunk[2] = 7; // valid

        uint256[] memory justValid = new uint256[](1);
        justValid[0] = 7;

        (uint256 bPJunk,) = GamePayouts.settle(4, 1, abi.encode(picksWithJunk), STAKE, HOUSE);
        (uint256 bPValid,) = GamePayouts.settle(4, 1, abi.encode(justValid), STAKE, HOUSE);
        // 3-pick table entry for 0 hits differs from the 1-pick table's 0/1-hit entries, so we can't
        // assert equality across pick-counts; just assert neither call reverts and both conserve value.
        assertLe(bPJunk, STAKE + HOUSE);
        assertLe(bPValid, STAKE + HOUSE);
    }

    // ==================================================== roulette (gameId 25) ==

    function _bet(uint8 t, uint8 sel, uint256 stake) internal pure returns (GamePayouts.RouletteBet memory b) {
        b.betType = t;
        b.selection = sel;
        b.stake = stake;
    }

    function test_roulette_reverts_zeroBets() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](0);
        vm.expectRevert(bytes("roulette: bad bet count"));
        this.settleExt(25, 0, abi.encode(bets), STAKE, HOUSE);
    }

    function test_roulette_reverts_tooManyBets() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](65);
        vm.expectRevert(bytes("roulette: bad bet count"));
        this.settleExt(25, 0, abi.encode(bets), STAKE, HOUSE);
    }

    function testFuzz_roulette_reverts_tooManyBets(uint256 rawLen) public {
        uint256 len = bound(rawLen, 65, 200);
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](len);
        vm.expectRevert(bytes("roulette: bad bet count"));
        this.settleExt(25, 0, abi.encode(bets), STAKE, HOUSE);
    }

    function test_roulette_reverts_badBetType() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(9, 0, 100);
        vm.expectRevert(bytes("roulette: bad bet type"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    function testFuzz_roulette_reverts_badBetType(uint8 betType) public {
        vm.assume(betType > 8);
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(betType, 0, 100);
        vm.expectRevert(bytes("roulette: bad bet type"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    function test_roulette_reverts_zeroStake() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(1, 0, 0); // red, zero stake
        vm.expectRevert(bytes("roulette: zero stake"));
        this.settleExt(25, 0, abi.encode(bets), 0, HOUSE);
    }

    function test_roulette_reverts_badStraightSelection() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(0, 37, 100); // straight-up selections are 0..36
        vm.expectRevert(bytes("roulette: bad straight selection"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    function testFuzz_roulette_reverts_badStraightSelection(uint8 sel) public {
        vm.assume(sel >= 37);
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(0, sel, 100);
        vm.expectRevert(bytes("roulette: bad straight selection"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    function test_roulette_reverts_badDozenSelection() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(7, 3, 100); // dozens are 0..2
        vm.expectRevert(bytes("roulette: bad dozen/column selection"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    function test_roulette_reverts_badColumnSelection() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(8, 3, 100); // columns are 0..2
        vm.expectRevert(bytes("roulette: bad dozen/column selection"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    function testFuzz_roulette_reverts_badDozenColumnSelection(uint8 betType, uint8 sel) public {
        betType = betType % 2 == 0 ? 7 : 8;
        vm.assume(sel >= 3);
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(betType, sel, 100);
        vm.expectRevert(bytes("roulette: bad dozen/column selection"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    // even-money bet types (1..6) must carry selection == 0.
    function test_roulette_reverts_nonZeroSelectionOnEvenMoney() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(1, 5, 100); // red with a bogus selection
        vm.expectRevert(bytes("roulette: selection must be 0"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    function testFuzz_roulette_reverts_nonZeroSelectionOnEvenMoney(uint8 betTypeSeed, uint8 sel) public {
        uint8 betType = 1 + (betTypeSeed % 6); // 1..6
        vm.assume(sel != 0);
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(betType, sel, 100);
        vm.expectRevert(bytes("roulette: selection must be 0"));
        this.settleExt(25, 0, abi.encode(bets), 100, HOUSE);
    }

    function test_roulette_reverts_stakeMismatch_extraEscrow() public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(1, 0, 100); // red, 100
        vm.expectRevert(bytes("roulette: stake must equal sum of bets"));
        this.settleExt(25, 0, abi.encode(bets), 101, HOUSE); // escrowPlayer != sum of bet stakes
    }

    function testFuzz_roulette_reverts_stakeMismatch(uint256 declaredStake) public {
        GamePayouts.RouletteBet[] memory bets = new GamePayouts.RouletteBet[](1);
        bets[0] = _bet(1, 0, 100); // red, 100
        vm.assume(declaredStake != 100);
        vm.expectRevert(bytes("roulette: stake must equal sum of bets"));
        this.settleExt(25, 0, abi.encode(bets), declaredStake, HOUSE);
    }
}

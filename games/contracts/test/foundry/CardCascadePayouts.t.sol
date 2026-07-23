// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GamePayouts} from "../../contracts/games/GamePayouts.sol";

// Parity vectors for the "pure-RNG games on-chain" milestone: baccarat (11), dragon tiger (12),
// andar bahar (13), cascade (24). Every `r`/`payout` below is printed by the REAL msgboard-games
// reference (scripts/gen-card-cascade-vectors.ts, stake 200), so the Solidity port is checked against
// the canonical TS math — including the seeded Fisher-Yates shuffle and the cascade tumble loop.
contract CardCascadePayoutsTest is Test {
    uint256 internal constant STAKE = 200;

    function _bet(uint256 b) internal pure returns (bytes memory) {
        return abi.encode(b);
    }

    function _settle(uint8 gameId, uint256 r, bytes memory params, uint256 escrowHouse)
        internal pure returns (uint256 bP, uint256 bH)
    {
        (bP, bH) = GamePayouts.settle(gameId, r, params, STAKE, escrowHouse);
        assertEq(bP + bH, STAKE + escrowHouse); // conservation
    }

    // ─────────────────────────────── baccarat (11) ───────────────────────────────
    uint256 internal constant R_BACC_PLAYER =
        68053564258556317150349243837902514818945326343711789649774590383616699827597;
    uint256 internal constant R_BACC_BANKER =
        84157554483925481790078325868819927141269412419533080553588607633004150223059;
    uint256 internal constant R_BACC_TIE =
        45471705140318273411081630220278833569503542448848512084931783747051985107271;

    function test_baccarat_player_win() public pure {
        (uint256 bP,) = _settle(11, R_BACC_PLAYER, _bet(0), 200); // player bet, max 2.00x → escrowHouse 200
        assertEq(bP, 400);
    }

    function test_baccarat_banker_win() public pure {
        (uint256 bP,) = _settle(11, R_BACC_BANKER, _bet(1), 190); // banker bet, 1.95x → escrowHouse 190
        assertEq(bP, 390); // 0.95:1 commission baked in
    }

    function test_baccarat_tie_bet_win() public pure {
        (uint256 bP,) = _settle(11, R_BACC_TIE, _bet(2), 1600); // tie bet, 9.00x → escrowHouse 1600
        assertEq(bP, 1800);
    }

    function test_baccarat_player_bet_pushes_on_tie() public pure {
        (uint256 bP,) = _settle(11, R_BACC_TIE, _bet(0), 200); // player bet on a TIE result → push (stake back)
        assertEq(bP, 200);
    }

    // ─────────────────────────────── dragon tiger (12) ───────────────────────────────
    uint256 internal constant R_DT_DRAGON =
        37843409584727195892530452647255254318907057257425552727622968492279945040967;
    uint256 internal constant R_DT_TIE =
        108174256589026683124305912205446370618204099420522125478345491452742619876089;

    function test_dragonTiger_dragon_win() public pure {
        (uint256 bP,) = _settle(12, R_DT_DRAGON, _bet(0), 200); // dragon bet, 2.00x → escrowHouse 200
        assertEq(bP, 400);
    }

    function test_dragonTiger_tie_bet_win() public pure {
        (uint256 bP,) = _settle(12, R_DT_TIE, _bet(2), 2200); // tie bet, 12.00x → escrowHouse 2200
        assertEq(bP, 2400);
    }

    function test_dragonTiger_dragon_bet_loses_half_on_tie() public pure {
        (uint256 bP,) = _settle(12, R_DT_TIE, _bet(0), 200); // dragon bet on a TIE → returns half (0.50x)
        assertEq(bP, 100);
    }

    // ─────────────────────────────── andar bahar (13) ───────────────────────────────
    uint256 internal constant R_AB_ANDAR =
        84157554483925481790078325868819927141269412419533080553588607633004150223059;
    uint256 internal constant R_AB_BAHAR =
        68053564258556317150349243837902514818945326343711789649774590383616699827597;

    function test_andarBahar_andar_win() public pure {
        (uint256 bP,) = _settle(13, R_AB_ANDAR, _bet(0), 180); // andar bet, 1.90x → escrowHouse 180
        assertEq(bP, 380); // andar pays 0.9:1
    }

    function test_andarBahar_bahar_win() public pure {
        (uint256 bP,) = _settle(13, R_AB_BAHAR, _bet(1), 200); // bahar bet, 2.00x → escrowHouse 200
        assertEq(bP, 400);
    }

    // ─────────────────────────────── cascade (24) ───────────────────────────────
    // params unused (no player choice). escrowHouse 9800 → pot 10000 = the 50x cap (escrow ceiling).
    uint256 internal constant CASCADE_ESCROW_HOUSE = 9800;
    uint256 internal constant R_CASCADE_ZERO =
        18569430475105882587588266137607568536673111973893317399460219858819262702947;
    uint256 internal constant R_CASCADE_SMALL =
        62514009886607029107290561805838585334079798074568712924583230797734656856475;
    uint256 internal constant R_CASCADE_BIG =
        54733025029901088831001604925566009236597535723592674609900492207440442601457;

    function test_cascade_zero() public pure {
        (uint256 bP,) = _settle(24, R_CASCADE_ZERO, "", CASCADE_ESCROW_HOUSE);
        assertEq(bP, 0); // no matching cluster → no pay
    }

    function test_cascade_small_pay() public pure {
        (uint256 bP,) = _settle(24, R_CASCADE_SMALL, "", CASCADE_ESCROW_HOUSE);
        assertEq(bP, 824); // total 4.12x → 200*412/100
    }

    function test_cascade_big_pay() public pure {
        (uint256 bP,) = _settle(24, R_CASCADE_BIG, "", CASCADE_ESCROW_HOUSE);
        assertEq(bP, 2342); // total 11.71x (multi-tumble) → 200*1171/100
    }

    // structural r-parity: the card vectors are real roundRandom(serverSeed, clientSeed, nonce) values.
    function test_r_parity_card() public pure {
        // bacc-player used (s(3), s(4), nonce 1) — same triple as dice-loss in GamePayouts.t.sol.
        uint256 r = uint256(keccak256(abi.encode(bytes32(uint256(3)), bytes32(uint256(4)), uint64(1))));
        assertEq(r, R_BACC_PLAYER);
    }
}

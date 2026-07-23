// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GamePayouts} from "../../contracts/games/GamePayouts.sol";

// Parity vectors for the "table games on-chain" milestone: plinko (3), keno (4), pachinko (7),
// wheel (8). Every payout below is printed by the REAL msgboard-games reference (gen-tables2.ts,
// stake 200) so the embedded RTP tables + the on-chain index math (popcount / r%segments / keno's
// Fisher-Yates draw) and the wheel table recompute are checked against the canonical TS.
contract TablePayoutsTest is Test {
    uint256 internal constant STAKE = 200;
    uint256 internal constant ESCROW_HOUSE = 1_000_000; // > the largest vector payout (200050); pot covers all

    function _settle(uint8 gameId, uint256 r, bytes memory params) internal pure returns (uint256 bP) {
        uint256 bH;
        (bP, bH) = GamePayouts.settle(gameId, r, params, STAKE, ESCROW_HOUSE);
        assertEq(bP + bH, STAKE + ESCROW_HOUSE); // conservation
    }

    /// external wrapper so vm.expectRevert can catch reverts from the inlined library call.
    function settleExt(uint8 gameId, uint256 r, bytes calldata params) external pure returns (uint256, uint256) {
        return GamePayouts.settle(gameId, r, params, STAKE, ESCROW_HOUSE);
    }

    // riskIdx 0=low 1=medium 2=high
    function _rows(uint256 rows, uint256 riskIdx) internal pure returns (bytes memory) {
        return abi.encode(rows, riskIdx);
    }

    function _picks(uint256[] memory picks) internal pure returns (bytes memory) {
        return abi.encode(picks);
    }

    // raw values reused across vectors (from gen-tables2.ts)
    uint256 constant RAW_A =
        20349940423862035287868699599764962454537984981628200184279725786303353984557; // roundRandom(s1,s2,1)
    uint256 constant RAW_WHEEL_LOSS5 =
        80993214276315491623959226907866530535036351595879588825777340747427721698035;
    uint256 constant RAW_W_HIGH_SEG9 =
        84157554483925481790078325868819927141269412419533080553588607633004150223059;
    uint256 constant RAW_W_HIGH50_SEG49 =
        77578781846134579271335976801088210590528933250273039165910287247354249302499;
    uint256 constant RAW_KENO10_WIN =
        37843409584727195892530452647255254318907057257425552727622968492279945040967;
    uint256 constant RAW_KENO7_WIN =
        68053564258556317150349243837902514818945326343711789649774590383616699827597;

    // ───────────────────────── plinko (3), rows=16 ─────────────────────────
    function test_plinko_edgeBucket_perRisk() public pure {
        // r=0 → bucket 0 (the high-paying edge); low/medium/high.
        assertEq(_settle(3, 0, _rows(16, 0)), 2976);
        assertEq(_settle(3, 0, _rows(16, 1)), 24220);
        assertEq(_settle(3, 0, _rows(16, 2)), 200050);
        // r=65535 → bucket 16 (symmetric mirror of bucket 0) → same payouts.
        assertEq(_settle(3, 65535, _rows(16, 0)), 2976);
        assertEq(_settle(3, 65535, _rows(16, 2)), 200050);
    }

    function test_plinko_centerBucket_perRisk() public pure {
        // r=255 → low 8 bits set → bucket 8 (center, the sub-1x buckets).
        assertEq(_settle(3, 255, _rows(16, 0)), 166);
        assertEq(_settle(3, 255, _rows(16, 1)), 88);
        assertEq(_settle(3, 255, _rows(16, 2)), 38);
    }

    function test_plinko_rejects_unshipped_rows() public {
        vm.expectRevert(bytes("plinko: only rows=16 mirrored"));
        this.settleExt(3, 0, _rows(8, 0));
    }

    // ───────────────────────── pachinko (7), rows=12 ─────────────────────────
    function test_pachinko_perRisk() public pure {
        assertEq(_settle(7, 0, _rows(12, 0)), 1882); // slot 0
        assertEq(_settle(7, 0, _rows(12, 1)), 11158);
        assertEq(_settle(7, 0, _rows(12, 2)), 87178);
        assertEq(_settle(7, 63, _rows(12, 0)), 168); // slot 6 (center)
        assertEq(_settle(7, 63, _rows(12, 2)), 38);
        assertEq(_settle(7, 4095, _rows(12, 2)), 87178); // slot 12 (mirror of 0)
    }

    // ───────────────────────── wheel (8) ─────────────────────────
    function test_wheel_segments10() public pure {
        assertEq(_settle(8, RAW_A, _rows(10, 0)), 246); // low, segment 7 (a win)
        assertEq(_settle(8, RAW_WHEEL_LOSS5, _rows(10, 0)), 0); // low, segment 5 (lose)
        assertEq(_settle(8, RAW_A, _rows(10, 1)), 230); // medium, segment 7
        assertEq(_settle(8, RAW_W_HIGH_SEG9, _rows(10, 2)), 1980); // high jackpot, segment 9
        assertEq(_settle(8, RAW_A, _rows(10, 2)), 0); // high, segment 7 (lose)
    }

    function test_wheel_segments50() public pure {
        assertEq(_settle(8, RAW_W_HIGH50_SEG49, _rows(50, 2)), 9900); // high jackpot, segment 49
        assertEq(_settle(8, RAW_A, _rows(50, 1)), 346); // medium, segment 7
    }

    function test_wheel_rejects_unsupported_segments() public {
        vm.expectRevert(bytes("wheel: unsupported segments"));
        this.settleExt(8, RAW_A, _rows(7, 0));
    }

    // ───────────────────────── keno (4) ─────────────────────────
    function test_keno_10picks() public pure {
        uint256[] memory picks = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) picks[i] = i + 1; // [1..10]
        assertEq(_settle(4, RAW_KENO10_WIN, _picks(picks)), 1740); // 5 hits
        assertEq(_settle(4, RAW_A, _picks(picks)), 0); // sub-threshold hits → keno pays nothing
    }

    function test_keno_4picks_and_1pick() public pure {
        uint256[] memory four = new uint256[](4);
        four[0] = 3;
        four[1] = 11;
        four[2] = 22;
        four[3] = 33;
        assertEq(_settle(4, RAW_A, _picks(four)), 334);

        uint256[] memory one = new uint256[](1);
        one[0] = 7;
        assertEq(_settle(4, RAW_KENO7_WIN, _picks(one)), 792); // the 7 is drawn → 1 hit pays
        assertEq(_settle(4, RAW_A, _picks(one)), 0); // not drawn → no pay
    }
}

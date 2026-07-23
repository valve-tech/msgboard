// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Packed RTP fair-multiplier tables (uint24 big-endian, in HUNDREDTHS, PRE-edge) for the table games,
/// generated verbatim from the canonical msgboard-games reference (examples/games/msgboard-settle/
/// scripts/gen-recompute-vectors.ts → table section). These are the exact normalized tables the TS
/// builds via src/rtp.ts; embedding them avoids re-porting the deficit-distribution normalization (and
/// its sort/tiebreak) on-chain, where a one-ulp mismatch would break recompute parity. Wheel is NOT
/// here — its uniform-weight table is cheap and safe to recompute on-chain (see GamePayouts._wheel).
/// Parity with the TS reference is pinned by test/foundry/TablePayouts.t.sol.
library GameTables {
    // plinko rows=16: risks low,medium,high (in that order), each 17 buckets [0..16].
    bytes constant PLINKO =
        hex"0005e000034e0000bc00008500008300007100006600005e00005400005e0000660000710000830000850000bc00034e0005e0002fc9000e540003960001ca0000f600009800005b00003e00002d00003e00005b0000980000f60001ca000396000e54002fc9018aac00334f000a430003900001940000cb0000140000140000140000140000140000cb000194000390000a4300334f018aac";
    // pachinko rows=12: risks low,medium,high, each 13 slots [0..12].
    bytes constant PACHINKO =
        hex"0003b700011b00009900007100006700005f00005500005f00006700007100009900011b0003b700160400057e0001d40000ea00005e00002f00002300002f00005e0000ea0001d400057e00160400abfe00075e00020c0000d200003e00001600001400001600003e0000d200020c00075e00abfe";
    // keno: pick-rows 1..10 concatenated; row p has p+1 entries (hits 0..p). Row start = (p-1)(p+2)/2.
    bytes constant KENO =
        hex"0000000001900000000000760003b30000000000350001b00005ad0000000000000000a90005490011dc00000000000000005300029f0008d70014fc00000000000000000000010b00085d001c330042f500000000000000000000008a000452000e9900229d0043b00000000000000000000000000001ce000e710030c000739300e1a80000000000000000000000000000f40007a90019d6003d3900779f00ce9500000000000000000000000000000000036f001b7c005cc900dbd701ad8b02e64b";

    uint256 internal constant PLINKO_STRIDE = 17; // rows16 → 17 buckets
    uint256 internal constant PACHINKO_STRIDE = 13; // rows12 → 13 slots
    uint256 internal constant RISKS = 3;

    /// read the big-endian uint24 at entry `idx` of a packed table.
    function _u24(bytes memory data, uint256 idx) private pure returns (uint256) {
        uint256 o = idx * 3;
        return (uint256(uint8(data[o])) << 16) | (uint256(uint8(data[o + 1])) << 8) | uint256(uint8(data[o + 2]));
    }

    /// fair multiplier (×100, pre-edge) for plinko bucket `bucket` at risk index `riskIdx` (0/1/2).
    function plinkoFair(uint256 riskIdx, uint256 bucket) internal pure returns (uint256) {
        require(riskIdx < RISKS && bucket < PLINKO_STRIDE, "plinko: index");
        return _u24(PLINKO, riskIdx * PLINKO_STRIDE + bucket);
    }

    /// fair multiplier (×100, pre-edge) for pachinko slot `slot` at risk index `riskIdx`.
    function pachinkoFair(uint256 riskIdx, uint256 slot) internal pure returns (uint256) {
        require(riskIdx < RISKS && slot < PACHINKO_STRIDE, "pachinko: index");
        return _u24(PACHINKO, riskIdx * PACHINKO_STRIDE + slot);
    }

    /// entry offset where the keno row for `picks` (1..10) starts: sum_{k=1}^{picks-1}(k+1).
    function kenoRowStart(uint256 picks) internal pure returns (uint256) {
        return ((picks - 1) * (picks + 2)) / 2;
    }

    /// fair multiplier (×100, pre-edge) for keno with `picks` picks and `hits` hits.
    function kenoFair(uint256 picks, uint256 hits) internal pure returns (uint256) {
        require(picks >= 1 && picks <= 10 && hits <= picks, "keno: index");
        return _u24(KENO, kenoRowStart(picks) + hits);
    }
}

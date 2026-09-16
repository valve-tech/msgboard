// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CardTableSecp} from "../../contracts/zk/CardTableSecp.sol";
import {EllipticCurve} from "../../contracts/zk/lib/EllipticCurve.sol";

/// @notice Round-trip proof for CardTableSecp.matchCard against on-chain secp256k1 scalar
/// multiplication (EllipticCurve.ecMul), plus a live cross-check against the SAME generator
/// (games/zk-core/scripts/gen-card-table-secp.mts) that produced the vendored library — the
/// tripwire against the checked-in table silently drifting from games/zk-core/src/elgamal.ts's
/// cardPoint(i) convention.
///
/// Non-ffi assertions run under the default profile. The full 52-point cross-check requires
/// --ffi (run via the `ffi` profile):
///   FOUNDRY_PROFILE=ffi forge test --match-path 'test/foundry/CardTableSecp.t.sol' --ffi
contract CardTableSecpTest is Test {
    /// @dev Computes (i+1)*G on-chain via EllipticCurve.ecMul, independent of the hardcoded
    /// table CardTableSecp.matchCard reads from.
    function _cardPoint(uint256 i) internal pure returns (uint256 x, uint256 y) {
        return EllipticCurve.ecMul(i + 1, EllipticCurve.GX, EllipticCurve.GY);
    }

    /// A handful of known indices, spanning the low end, a middle value, and the last card —
    /// each independently recomputed via EllipticCurve.ecMul and checked against
    /// CardTableSecp.matchCard.
    function test_matchKnownIndices() public pure {
        uint256[5] memory indices = [uint256(0), 1, 2, 25, 51];
        for (uint256 j = 0; j < indices.length; j++) {
            uint256 i = indices[j];
            (uint256 x, uint256 y) = _cardPoint(i);
            (bool ok, uint8 card) = CardTableSecp.matchCard(x, y);
            assertTrue(ok, "known card point must match");
            assertEq(card, i, "matched card index mismatch");
        }
    }

    /// card 0 is pinned to the secp256k1 generator G itself (cardPoint(0) = 1*G).
    function test_matchCardZeroIsGenerator() public pure {
        (bool ok, uint8 card) = CardTableSecp.matchCard(EllipticCurve.GX, EllipticCurve.GY);
        assertTrue(ok, "generator point must match card 0");
        assertEq(card, 0, "generator must decode to card index 0");
    }

    /// matchCard() must be non-reverting and report ok=false for points that are not one of the
    /// 52 canonical entries — the split/void fallback the showdown decode path depends on.
    function test_matchReturnsFalseForNonTablePoint() public pure {
        (bool ok, uint8 card) = CardTableSecp.matchCard(1, 2);
        assertFalse(ok, "garbage point must not be recognized as a card");
        assertEq(card, 0, "unmatched matchCard() returns card=0");
    }

    /// The zero point (0,0) — the "missing/garbage share" sentinel HoldemShowdownLib produces
    /// when a slot's shares don't fully cancel c2 — must not accidentally match any table row.
    function test_matchReturnsFalseForZeroPoint() public pure {
        (bool ok, ) = CardTableSecp.matchCard(0, 0);
        assertFalse(ok, "zero point must not match any card");
    }

    /// A table x-coordinate paired with the WRONG y (the negated/other curve root) must not
    /// match — matchCard() checks both x and y, not x alone.
    function test_matchRejectsWrongYForKnownX() public pure {
        (uint256 x, uint256 y) = _cardPoint(0);
        // secp256k1 field prime, mirrored from EllipticCurve.PP (private-const duplicate here
        // avoided by reading it directly is not possible since PP is internal-const on the
        // library — recompute the negated y the same way EllipticCurve does: p - y).
        uint256 pp = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f;
        uint256 wrongY = pp - y;
        (bool ok, ) = CardTableSecp.matchCard(x, wrongY);
        assertFalse(ok, "correct x with the wrong y must not match");
    }

    /// Live cross-check: shells out to the SAME generator that produced the checked-in
    /// CardTableSecp.sol, re-derives all 52 points independently, and asserts the vendored
    /// library decodes every one to the matching index. Guards against silent drift between
    /// the checked-in table and games/zk-core/src/elgamal.ts's cardPoint(i)/CARD_TABLE.
    function test_matchParityWithLiveGenerator() public {
        string[] memory cmd = new string[](3);
        cmd[0] = "../../node_modules/.bin/tsx";
        cmd[1] = "../zk-core/scripts/gen-card-table-secp.mts";
        cmd[2] = "--json";
        bytes memory res = vm.ffi(cmd);
        uint256[104] memory words = abi.decode(res, (uint256[104]));

        for (uint256 i = 0; i < 52; i++) {
            uint256 x = words[2 * i];
            uint256 y = words[2 * i + 1];
            (bool ok, uint8 card) = CardTableSecp.matchCard(x, y);
            assertTrue(ok, "vendored CardTableSecp fails to recognize a live-generator point");
            assertEq(card, i, "vendored CardTableSecp disagrees with the live generator for this index");
        }
    }
}

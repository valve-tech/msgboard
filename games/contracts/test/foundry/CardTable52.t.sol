// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CardTable52} from "../../contracts/vendor/uzkge/CardTable52.sol";

/// @notice Decode-PARITY tripwire against secret-engine version drift. The vendored
/// CardTable52 (generated once, checked in, via games/zk-core/scripts/gen-card-table.mts) is
/// NOT compared against a static fixture here — this test shells out to the SAME generator's
/// `--json` dump mode via `vm.ffi`, which re-derives all 52 canonical points from whatever
/// zypher-game secret-engine npm package is installed RIGHT NOW, and asserts the checked-in library
/// decodes every one of them to the matching index. If a future secret-engine bump reorders or
/// changes the encoding table and nobody regenerates CardTable52.sol, this test fails loudly
/// instead of the mismatch surfacing as a silent wrong-card-decoded bug in a live showdown.
///
/// Requires --ffi (run via the `ffi` profile: `FOUNDRY_PROFILE=ffi forge test --match-path
/// 'test/foundry/CardTable52.t.sol' --ffi`). Shells out exactly once (a single
/// init_prover_key(52) setup, ~seconds) for all 52 points, not once per point.
contract CardTable52Test is Test {
    function test_decodeParityWithLiveEngine() public {
        string[] memory cmd = new string[](3);
        cmd[0] = "../../node_modules/.bin/tsx";
        cmd[1] = "../zk-core/scripts/gen-card-table.mts";
        cmd[2] = "--json";
        bytes memory res = vm.ffi(cmd);
        uint256[104] memory words = abi.decode(res, (uint256[104]));

        for (uint256 i = 0; i < 52; i++) {
            uint256 x = words[2 * i];
            uint256 y = words[2 * i + 1];
            (bool ok, uint8 card) = CardTable52.decode(x, y);
            assertTrue(ok, "vendored CardTable52 fails to recognize a live-engine point");
            assertEq(card, i, "vendored CardTable52 disagrees with the live engine for this index");
        }
    }

    /// decode() must be non-reverting and report ok=false for a point that is not one of the 52
    /// canonical entries (the fallback finalizeShowdown's split branch depends on).
    function test_decodeReturnsFalseForNonTablePoint() public pure {
        (bool ok, uint8 card) = CardTable52.decode(1, 2);
        assertFalse(ok, "garbage point must not be recognized as a card");
        assertEq(card, 0, "unmatched decode returns card=0");
    }
}

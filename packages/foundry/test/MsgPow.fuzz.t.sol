// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";

/// @notice Fuzz and property tests for MsgPow pure-function helpers.
/// None of these require a live node — all inputs are synthetic.
///
/// Tests are grouped by the function under test:
///   scalarHash — cheap, default run count
///   verify     — calls ecMul (~700k gas each), low run count
///   powTarget  — cheap, default run count
contract MsgPowFuzzTest is Test {
    // ── External wrappers so vm.expectRevert works on library internal calls ──

    function ext_verify(MsgPow.Message calldata m, uint256 difficulty) external pure returns (bool) {
        return MsgPow.verify(m, difficulty);
    }

    function ext_powTarget(uint256 d) external pure returns (uint256) {
        return MsgPow.powTarget(d);
    }

    // ── scalarHash ──────────────────────────────────────────────────────────────

    /// scalarHash is deterministic.
    function testFuzz_scalarHash_deterministic(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd
    ) public pure {
        MsgPow.Message memory m = MsgPow.Message(1, nonce, blockHash, category, data, wm, wd);
        assertEq(MsgPow.scalarHash(m), MsgPow.scalarHash(m), "scalarHash must be deterministic");
    }

    /// The nonce enters scalarHash as its low 8 bytes; a change there must change the hash.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_scalarHash_sensitive_to_nonce(
        uint64 nonce,
        uint64 otherNonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd
    ) public pure {
        vm.assume(nonce != otherNonce);
        MsgPow.Message memory m1 = MsgPow.Message(1, nonce, blockHash, category, data, wm, wd);
        MsgPow.Message memory m2 = MsgPow.Message(1, otherNonce, blockHash, category, data, wm, wd);
        assertNotEq(MsgPow.scalarHash(m1), MsgPow.scalarHash(m2), "different nonce must change scalarHash");
    }

    /// Changing data with everything else fixed must change the payloadHash (sha256 collision
    /// resistance — would only fail on a sha256 preimage collision).
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_payloadHash_sensitive_to_data(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        bytes calldata otherData,
        uint64 wm,
        uint64 wd
    ) public pure {
        vm.assume(keccak256(data) != keccak256(otherData));
        MsgPow.Message memory m1 = MsgPow.Message(1, nonce, blockHash, category, data, wm, wd);
        MsgPow.Message memory m2 = MsgPow.Message(1, nonce, blockHash, category, otherData, wm, wd);
        assertNotEq(MsgPow.payloadHash(m1), MsgPow.payloadHash(m2), "different data must change payloadHash");
    }

    // ── verify ──────────────────────────────────────────────────────────────────

    /// verify must always revert when difficulty == 0.
    function testFuzz_verify_reverts_on_zero_difficulty(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd
    ) public {
        MsgPow.Message memory m = MsgPow.Message(1, nonce, blockHash, category, data, wm, wd);
        vm.expectRevert("MsgPow: zero difficulty");
        this.ext_verify(m, 0);
    }

    /// verify is deterministic.
    /// forge-config: default.fuzz.runs = 24
    function testFuzz_verify_deterministic(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd,
        uint256 difficulty
    ) public pure {
        vm.assume(difficulty != 0);
        MsgPow.Message memory m = MsgPow.Message(1, nonce, blockHash, category, data, wm, wd);
        assertEq(MsgPow.verify(m, difficulty), MsgPow.verify(m, difficulty), "verify must be deterministic");
    }

    /// difficulty == 1 → target == 2^256, so every in-range scalar passes. A miss is only possible
    /// when the scalar is out of range (about a 2^-128 chance), so this asserts the target rule,
    /// not the scalar range: verify at difficulty 1 equals "scalar in range".
    /// forge-config: default.fuzz.runs = 24
    function testFuzz_verify_difficulty_one_passes_when_scalar_in_range(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd
    ) public pure {
        MsgPow.Message memory m = MsgPow.Message(1, nonce, blockHash, category, data, wm, wd);
        (bool ok,) = MsgPow.workHash(m);
        assertEq(MsgPow.verify(m, 1), ok, "difficulty=1 passes iff the scalar is in range");
    }

    // ── powTarget ─────────────────────────────────────────────────────────────

    /// powTarget reverts for d < 2 (the true target 2^256 does not fit in a uint256).
    function test_powTarget_reverts_below_two() public {
        vm.expectRevert("MsgPow: target overflow");
        this.ext_powTarget(1);
        vm.expectRevert("MsgPow: target overflow");
        this.ext_powTarget(0);
    }

    /// powTarget is the exact floor of 2^256 / d: d * target <= 2^256 < d * (target + 1). Rearranged
    /// without overflow: target <= max/d, and the remainder max - d*target is below d (accounting for
    /// the +1 that turns max into 2^256).
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_powTarget_is_floor(uint256 d) public pure {
        vm.assume(d >= 2);
        uint256 target = MsgPow.powTarget(d);
        // target <= floor(2^256 / d) <= floor(max / d) + 1
        assertLe(target, type(uint256).max / d + 1, "target upper bound");
        // d * target must not exceed 2^256, i.e. it fits in a uint256 unless it is exactly 2^256.
        // Check via: target <= max / d + (max % d + 1 >= d ? 1 : 0), reproduced independently.
        uint256 expected = type(uint256).max / d;
        if (type(uint256).max % d + 1 >= d) expected += 1;
        assertEq(target, expected, "powTarget must equal the overflow-safe floor");
    }

    /// powTarget is monotonically non-increasing in d (harder difficulty → smaller target).
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_powTarget_monotonic(uint256 d1, uint256 d2) public pure {
        vm.assume(d1 >= 2 && d2 >= 2);
        if (d1 <= d2) {
            assertGe(MsgPow.powTarget(d1), MsgPow.powTarget(d2), "larger difficulty must not raise the target");
        }
    }
}

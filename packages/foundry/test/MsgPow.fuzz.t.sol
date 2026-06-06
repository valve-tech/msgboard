// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";

/// @notice Fuzz and property tests for MsgPow pure-function helpers.
/// None of these require a live node — all inputs are synthetic.
///
/// Tests are grouped by the function under test:
///   minimalBytes — cheap (no ecMul), default run count
///   digest       — cheap, default run count
///   workHash     — calls ecMul (~700k gas each), low run count
///   verify       — same cost as workHash, low run count
contract MsgPowFuzzTest is Test {
    // ── External wrappers so vm.expectRevert works on library internal calls ──

    function ext_verify(MsgPow.Message calldata m, uint256 difficulty) external pure returns (bool) {
        return MsgPow.verify(m, difficulty);
    }

    // ── minimalBytes ──────────────────────────────────────────────────────────

    /// No leading zero bytes unless x == 0.
    function testFuzz_minimalBytes_no_leading_zeros(uint256 x) public pure {
        bytes memory b = MsgPow.minimalBytes(x);
        if (x == 0) {
            assertEq(b.length, 0, "zero must produce empty bytes");
        } else {
            assertGt(b.length, 0, "nonzero must produce nonempty bytes");
            assertNotEq(uint8(b[0]), 0, "first byte must be nonzero");
        }
    }

    /// Encoding always fits in 32 bytes (uint256 is at most 256 bits).
    function testFuzz_minimalBytes_bounded(uint256 x) public pure {
        assertLe(MsgPow.minimalBytes(x).length, 32, "result must fit within 32 bytes");
    }

    /// Decoding the produced bytes must recover x exactly.
    function testFuzz_minimalBytes_roundtrip(uint256 x) public pure {
        bytes memory b = MsgPow.minimalBytes(x);
        uint256 recovered;
        for (uint256 i = 0; i < b.length; i++) {
            recovered = (recovered << 8) | uint8(b[i]);
        }
        assertEq(recovered, x, "minimalBytes must encode x losslessly");
    }

    // ── digest ────────────────────────────────────────────────────────────────

    /// digest is the low 128 bits of a sha256, so it must always fit in 128 bits.
    function testFuzz_digest_bounded(uint64 wm, uint64 wd) public pure {
        assertLe(MsgPow.digest(wm, wd), type(uint128).max, "digest must fit in 128 bits");
    }

    /// digest is deterministic: same inputs produce the same output.
    function testFuzz_digest_deterministic(uint64 wm, uint64 wd) public pure {
        assertEq(MsgPow.digest(wm, wd), MsgPow.digest(wm, wd));
    }

    // ── workHash ──────────────────────────────────────────────────────────────

    /// workHash is deterministic: two calls with the same inputs must agree.
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_workHash_deterministic(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd
    ) public pure {
        MsgPow.Message memory m = MsgPow.Message(nonce, blockHash, category, data, wm, wd);
        assertEq(MsgPow.workHash(m), MsgPow.workHash(m), "workHash must be deterministic");
    }

    /// Changing data with everything else fixed must change the workHash (sha256 collision
    /// resistance — would only fail on a sha256 preimage collision).
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_workHash_sensitive_to_data(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        bytes calldata otherData,
        uint64 wm,
        uint64 wd
    ) public pure {
        vm.assume(keccak256(data) != keccak256(otherData));
        MsgPow.Message memory m1 = MsgPow.Message(nonce, blockHash, category, data, wm, wd);
        MsgPow.Message memory m2 = MsgPow.Message(nonce, blockHash, category, otherData, wm, wd);
        assertNotEq(MsgPow.workHash(m1), MsgPow.workHash(m2), "different data must produce different workHash");
    }

    /// Changing category with everything else fixed must change the workHash.
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_workHash_sensitive_to_category(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes32 otherCategory,
        bytes calldata data,
        uint64 wm,
        uint64 wd
    ) public pure {
        vm.assume(category != otherCategory);
        MsgPow.Message memory m1 = MsgPow.Message(nonce, blockHash, category, data, wm, wd);
        MsgPow.Message memory m2 = MsgPow.Message(nonce, blockHash, otherCategory, data, wm, wd);
        assertNotEq(MsgPow.workHash(m1), MsgPow.workHash(m2), "different category must produce different workHash");
    }

    // ── verify ────────────────────────────────────────────────────────────────

    /// verify must always revert when difficulty == 0.
    function testFuzz_verify_reverts_on_zero_difficulty(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd
    ) public {
        MsgPow.Message memory m = MsgPow.Message(nonce, blockHash, category, data, wm, wd);
        vm.expectRevert("MsgPow: zero difficulty");
        this.ext_verify(m, 0);
    }

    /// difficulty == 1 must accept every message because uint256 % 1 == 0 for all uint256.
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_verify_difficulty_one_always_passes(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd
    ) public pure {
        MsgPow.Message memory m = MsgPow.Message(nonce, blockHash, category, data, wm, wd);
        assertTrue(MsgPow.verify(m, 1), "difficulty=1 must accept every message");
    }

    /// If a message passes a stricter (larger) difficulty D, it must also pass difficulty == 1.
    /// (Converse of the subset property: passing harder implies passing trivial.)
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_verify_stricter_implies_trivial(
        uint256 nonce,
        bytes32 blockHash,
        bytes32 category,
        bytes calldata data,
        uint64 wm,
        uint64 wd,
        uint256 difficulty
    ) public pure {
        vm.assume(difficulty > 1);
        MsgPow.Message memory m = MsgPow.Message(nonce, blockHash, category, data, wm, wd);
        if (MsgPow.verify(m, difficulty)) {
            assertTrue(MsgPow.verify(m, 1), "a message passing difficulty D must pass difficulty 1");
        }
    }

    /// verify is deterministic: two calls with identical inputs must return the same bool.
    /// forge-config: default.fuzz.runs = 32
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
        MsgPow.Message memory m = MsgPow.Message(nonce, blockHash, category, data, wm, wd);
        assertEq(MsgPow.verify(m, difficulty), MsgPow.verify(m, difficulty), "verify must be deterministic");
    }
}

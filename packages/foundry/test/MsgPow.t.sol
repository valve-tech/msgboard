// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";

contract MsgPowTest is Test {
    // ── loaders ─────────────────────────────────────────────────────────────────

    /// Loads a legacy stamp (valid.json or boundary.json) at the given path.
    function _loadLegacy(string memory file) internal view returns (MsgPow.Message memory m, uint256 difficulty) {
        string memory json = vm.readFile(file);
        m.version = uint8(vm.parseUint(vm.parseJsonString(json, ".version")));
        m.nonce = vm.parseUint(vm.parseJsonString(json, ".nonce"));
        m.blockHash = vm.parseJsonBytes32(json, ".blockHash");
        m.category = vm.parseJsonBytes32(json, ".category");
        m.data = vm.parseJsonBytes(json, ".data");
        m.workMultiplier = uint64(vm.parseUint(vm.parseJsonString(json, ".workMultiplier")));
        m.workDivisor = uint64(vm.parseUint(vm.parseJsonString(json, ".workDivisor")));
        difficulty = vm.parseUint(vm.parseJsonString(json, ".difficulty"));
    }

    function _load() internal view returns (MsgPow.Message memory m, uint256 difficulty) {
        return _loadLegacy("./test/vectors/valid.json");
    }

    /// Loads the revised stamp from v2.json (.stamp.*).
    function _loadRevisedStamp() internal view returns (MsgPow.Message memory m, uint256 difficulty) {
        string memory json = vm.readFile("./test/vectors/v2.json");
        m.version = uint8(vm.parseUint(vm.parseJsonString(json, ".stamp.version")));
        m.nonce = vm.parseUint(vm.parseJsonString(json, ".stamp.nonce"));
        m.blockHash = vm.parseJsonBytes32(json, ".stamp.blockHash");
        m.category = vm.parseJsonBytes32(json, ".stamp.category");
        m.data = vm.parseJsonBytes(json, ".stamp.data");
        m.workMultiplier = uint64(vm.parseUint(vm.parseJsonString(json, ".stamp.workMultiplier")));
        m.workDivisor = uint64(vm.parseUint(vm.parseJsonString(json, ".stamp.workDivisor")));
        difficulty = vm.parseUint(vm.parseJsonString(json, ".stamp.difficulty"));
    }

    // ── legacy ────────────────────────────────────────────────────────────────────

    function test_verifies_valid_vector() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        assertTrue(MsgPow.verifyLegacy(m, difficulty), "valid legacy vector must verify");
    }

    function test_rejects_tampered_nonce() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        m.nonce += 1;
        assertFalse(MsgPow.verifyLegacy(m, difficulty), "tampered nonce must not verify");
    }

    function test_workHash_matches_core() public view {
        (MsgPow.Message memory m,) = _load();
        string memory json = vm.readFile("./test/vectors/valid.json");
        bytes32 expected = vm.parseJsonBytes32(json, ".workHash");
        assertEq(MsgPow.workHashLegacy(m), expected, "legacy workHash must match msgboard/core");
    }

    /// The boundary vector's challengeX is below 2^248 (a leading zero byte). The retired
    /// `minimalBytes` encoding would emit 31 bytes here and disagree with core — so this
    /// asserts the fixed 32-byte encoding.
    function test_verifies_boundary_vector() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _loadLegacy("./test/vectors/boundary.json");
        string memory json = vm.readFile("./test/vectors/boundary.json");
        // Confirm the vector really is the leading-zero boundary case.
        uint256 x = uint256(vm.parseJsonBytes32(json, ".challengeX"));
        assertLt(x, 2 ** 248, "boundary challengeX must be below 2^248");
        assertEq(MsgPow.challengeX(m), x, "challengeX must match core");
        assertTrue(MsgPow.verifyLegacy(m, difficulty), "boundary vector must verify");
        bytes32 expected = vm.parseJsonBytes32(json, ".workHash");
        assertEq(MsgPow.workHashLegacy(m), expected, "boundary workHash must match core (fixed 32-byte x)");
    }

    // ── revised (canonical) ───────────────────────────────────────────────────────

    /// Reproduces the pinned digest fixture in Solidity: version=2, blockHash=keccak256("v2-golden-block"),
    /// category=keccak256("v2-golden-cat"), data=0x0102030405, nonce=42, wm=wd=1.
    function test_v2_fixture_digests_match_core() public pure {
        MsgPow.Message memory m = MsgPow.Message({
            version: 2,
            nonce: 42,
            blockHash: keccak256("v2-golden-block"),
            category: keccak256("v2-golden-cat"),
            data: hex"0102030405",
            workMultiplier: 1,
            workDivisor: 1
        });
        assertEq(
            MsgPow.payloadHash(m),
            0xd73f3e001a3e81f1483ac0cdc9c56e2fe4d8b0fff3d8e9c4b385be4941289671,
            "payloadHash must match core golden fixture"
        );
        assertEq(
            MsgPow.scalarHash(m),
            0xb30158e41c77b19c5fa193978fc81310a3690db47085eb2e62bf819fa4311a89,
            "scalarHash must match core golden fixture"
        );
    }

    /// The digest fixture from v2.json also matches (guards the vector generator).
    function test_v2_fixture_digests_match_vector() public view {
        string memory json = vm.readFile("./test/vectors/v2.json");
        MsgPow.Message memory m;
        m.version = uint8(vm.parseUint(vm.parseJsonString(json, ".fixture.version")));
        m.nonce = vm.parseUint(vm.parseJsonString(json, ".fixture.nonce"));
        m.blockHash = vm.parseJsonBytes32(json, ".fixture.blockHash");
        m.category = vm.parseJsonBytes32(json, ".fixture.category");
        m.data = vm.parseJsonBytes(json, ".fixture.data");
        m.workMultiplier = uint64(vm.parseUint(vm.parseJsonString(json, ".fixture.workMultiplier")));
        m.workDivisor = uint64(vm.parseUint(vm.parseJsonString(json, ".fixture.workDivisor")));
        assertEq(MsgPow.payloadHash(m), vm.parseJsonBytes32(json, ".fixture.payloadHash"), "payloadHash");
        assertEq(MsgPow.scalarHash(m), vm.parseJsonBytes32(json, ".fixture.scalarHash"), "scalarHash");
    }

    function test_v2_verifies_stamp() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _loadRevisedStamp();
        string memory json = vm.readFile("./test/vectors/v2.json");
        assertEq(MsgPow.payloadHash(m), vm.parseJsonBytes32(json, ".stamp.payloadHash"), "payloadHash");
        assertEq(MsgPow.scalarHash(m), vm.parseJsonBytes32(json, ".stamp.scalarHash"), "scalarHash");
        (bool ok, bytes32 wh) = MsgPow.workHash(m);
        assertTrue(ok, "revised scalar must be in range");
        assertEq(wh, vm.parseJsonBytes32(json, ".stamp.workHash"), "revised workHash must match core");
        // verify() is the canonical (revised) algorithm.
        assertTrue(MsgPow.verify(m, difficulty), "revised stamp must verify");
    }

    function test_v2_rejects_tampered_nonce() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _loadRevisedStamp();
        m.nonce += 1;
        assertFalse(MsgPow.verify(m, difficulty), "tampered revised nonce must not verify");
    }

    /// powTarget matches core: 2^256/256 == 2^248.
    function test_v2_powTarget_matches_core() public view {
        (, uint256 difficulty) = _loadRevisedStamp();
        string memory json = vm.readFile("./test/vectors/v2.json");
        uint256 expected = uint256(vm.parseJsonBytes32(json, ".stamp.powTarget"));
        assertEq(MsgPow.powTarget(difficulty), expected, "powTarget must match core");
        assertEq(MsgPow.powTarget(256), 2 ** 248, "powTarget(256) == 2^248");
    }
}

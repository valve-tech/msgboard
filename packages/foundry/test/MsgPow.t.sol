// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";

contract MsgPowTest is Test {
    function _load() internal view returns (MsgPow.Message memory m, uint256 difficulty) {
        string memory json = vm.readFile("./test/vectors/valid.json");
        m.nonce = vm.parseUint(vm.parseJsonString(json, ".nonce"));
        m.blockHash = vm.parseJsonBytes32(json, ".blockHash");
        m.category = vm.parseJsonBytes32(json, ".category");
        m.data = vm.parseJsonBytes(json, ".data");
        m.workMultiplier = uint64(vm.parseUint(vm.parseJsonString(json, ".workMultiplier")));
        m.workDivisor = uint64(vm.parseUint(vm.parseJsonString(json, ".workDivisor")));
        difficulty = vm.parseUint(vm.parseJsonString(json, ".difficulty"));
    }

    function test_verifies_valid_vector() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        assertTrue(MsgPow.verify(m, difficulty), "valid vector must verify");
    }

    function test_rejects_tampered_nonce() public view {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        m.nonce += 1;
        assertFalse(MsgPow.verify(m, difficulty), "tampered nonce must not verify");
    }

    function test_workHash_matches_core() public view {
        (MsgPow.Message memory m,) = _load();
        string memory json = vm.readFile("./test/vectors/valid.json");
        bytes32 expected = vm.parseJsonBytes32(json, ".workHash");
        assertEq(MsgPow.workHash(m), expected, "workHash must match @msgboard/core");
    }
}

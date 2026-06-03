// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";
import {PoWGate} from "../examples/PoWGate.sol";

/// Exercises the PoWGate example end-to-end using the golden vector (deterministic, CI-safe).
contract PoWGateTest is Test {
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

    function test_gate_accepts_valid_work() public {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        PoWGate gate = new PoWGate(difficulty);
        bytes32 wh = gate.enter(m);
        assertEq(wh, MsgPow.workHash(m), "returns the work hash");
        assertTrue(gate.used(wh), "marks the stamp used");
    }

    function test_gate_rejects_replay() public {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        PoWGate gate = new PoWGate(difficulty);
        gate.enter(m);
        vm.expectRevert("PoWGate: stamp already used");
        gate.enter(m);
    }

    function test_gate_rejects_invalid_work() public {
        (MsgPow.Message memory m, uint256 difficulty) = _load();
        PoWGate gate = new PoWGate(difficulty);
        m.nonce += 1; // tamper
        vm.expectRevert("PoWGate: invalid work");
        gate.enter(m);
    }
}

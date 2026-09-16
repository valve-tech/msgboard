// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";
import {PoWGate} from "../examples/PoWGate.sol";

/// @notice Drives PoWGate with a mix of valid (golden vector) and alternative nonce calls.
/// Tracks whether the golden stamp has ever been accepted so the invariant can
/// assert it was never subsequently cleared.
///
/// @dev The gate runs the canonical (revised) algorithm, so this handler feeds the revised
/// golden stamp. In the revised scheme each nonce hashes into an independent scalar, so — unlike
/// the legacy scheme — there is no nonce periodicity to exploit: a changed nonce yields a fresh,
/// independent stamp. The handler's enterAlt function explores alternate nonces; a fraction clear
/// the difficulty and consume their OWN stamp (a different workHash), while collisions with the
/// golden workHash are effectively impossible. Either outcome is fine for the invariant.
contract PoWGateHandler is Test {
    PoWGate public immutable gate;

    MsgPow.Message internal _golden;
    bytes32 public immutable goldenHash;

    /// True once gate.enter() succeeds with any message that has goldenHash.
    bool public goldenHashUsed;

    constructor() {
        string memory json = vm.readFile("./test/vectors/v2.json");
        _golden.version        = uint8(vm.parseUint(vm.parseJsonString(json, ".stamp.version")));
        _golden.nonce          = vm.parseUint(vm.parseJsonString(json, ".stamp.nonce"));
        _golden.blockHash      = vm.parseJsonBytes32(json, ".stamp.blockHash");
        _golden.category       = vm.parseJsonBytes32(json, ".stamp.category");
        _golden.data           = vm.parseJsonBytes(json, ".stamp.data");
        _golden.workMultiplier = uint64(vm.parseUint(vm.parseJsonString(json, ".stamp.workMultiplier")));
        _golden.workDivisor    = uint64(vm.parseUint(vm.parseJsonString(json, ".stamp.workDivisor")));

        uint256 difficulty = vm.parseUint(vm.parseJsonString(json, ".stamp.difficulty"));

        gate       = new PoWGate(difficulty);
        (, goldenHash) = MsgPow.workHash(_golden);
    }

    /// Submit the golden vector. First call succeeds and marks the stamp used;
    /// subsequent calls revert ("stamp already used") — both are fine.
    function enterGolden() external {
        try gate.enter(_golden) {
            goldenHashUsed = true;
        } catch {}
    }

    /// Submit a message with an alternate nonce. In the revised scheme every nonce produces an
    /// independent stamp, so an alternate nonce either clears the difficulty with its OWN workHash
    /// or is rejected by verify(). It does not reproduce the golden workHash. The handler accepts
    /// either outcome.
    function enterAlt(uint256 nonceOffset) external {
        vm.assume(nonceOffset != 0);
        MsgPow.Message memory m = _golden;
        unchecked { m.nonce = _golden.nonce + nonceOffset; }
        try gate.enter(m) returns (bytes32 wh) {
            if (wh == goldenHash) goldenHashUsed = true;
        } catch {}
    }
}

/// @notice Invariant suite for PoWGate.
///
/// Invariants:
///   1. used_stamps_never_cleared — once gate.used(wh) is true it stays true.
///      The used mapping transitions only false → true, never back.
///   2. min_difficulty_immutable  — gate.minDifficulty() never changes (it is
///      immutable in the contract, but asserted here as a regression guard).
contract PoWGateInvariantTest is StdInvariant, Test {
    PoWGateHandler internal _handler;
    uint256 internal _expectedDifficulty;

    function setUp() public {
        _handler = new PoWGateHandler();
        _expectedDifficulty = _handler.gate().minDifficulty();
        targetContract(address(_handler));
    }

    /// Once gate.used(goldenHash) transitions to true it must never revert to false.
    /// This is the core monotonicity property: stamps are consumed, never restored.
    function invariant_used_stamps_never_cleared() public view {
        if (_handler.goldenHashUsed()) {
            assertTrue(
                _handler.gate().used(_handler.goldenHash()),
                "used stamp must remain true once set"
            );
        }
    }

    /// minDifficulty is immutable — no sequence of calls can change it.
    function invariant_min_difficulty_immutable() public view {
        assertEq(
            _handler.gate().minDifficulty(),
            _expectedDifficulty,
            "minDifficulty must never change"
        );
    }
}

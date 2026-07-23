// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {GameBase} from "../GameBase.sol";
import {PreimageLocation} from "../PreimageLocation.sol";

/// @notice Concrete GameBase so its internals can be unit-tested (GameBase is abstract). Exposes
/// the escrow, subset-validation, and heat helpers, and supplies the abstract members.
contract GameBaseHarness is GameBase {
    bytes32 public lastSettledInstance;
    bytes32 public lastSettledSeed;

    constructor(address _random) GameBase(_random) {}

    function takeStake(uint256 expected) external payable {
        _take(expected);
    }

    function payOut(address to, uint256 amount) external {
        _pay(to, amount);
    }

    // --- forwards to GameBase internals ---
    function validateSubset(address[] calldata subset) external view {
        _validateSubset(subset);
    }

    function heatBound(address[] calldata subset, PreimageLocation.Info[] calldata locations)
        external
        returns (bytes32 key)
    {
        key = _heatBound(subset, locations);
    }
    function bindInstance(bytes32 key, bytes32 instanceId) external { instanceByKey[key] = instanceId; }

    function _settle(bytes32 instanceId, bytes32 seed) internal override {
        lastSettledInstance = instanceId;
        lastSettledSeed = seed;
    }

    function isStale(uint256 armedAtBlock) external view returns (bool) {
        return _isStale(armedAtBlock);
    }

    receive() external payable {}
}

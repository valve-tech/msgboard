// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {PreimageLocation} from "../PreimageLocation.sol";

interface ICoinFlipEnter {
    function enterAndMatch(uint8 side, address[] calldata validatorSubset, PreimageLocation.Info[] calldata validatorLocations)
        external
        payable
        returns (uint256 id);
}

/// @notice Test-only player that can transiently refuse incoming ETH. While `reject` is true the
/// `receive()` fallback reverts, so a CoinFlip onCast push to this contract fails — Random swallows
/// the revert (FailedToCall), the seed is still finalized, and the flip stays Pending. Flipping
/// `reject` to false then lets `claim` pay this contract, exercising the pull-based fallback.
contract RejectableReceiver {
    bool public reject = true;

    function setReject(bool value) external {
        reject = value;
    }

    /// @notice Forward an entry into CoinFlip so this contract is the recorded player. The caller
    /// funds the stake via msg.value.
    function enter(
        address coinFlip,
        uint8 side,
        address[] calldata validatorSubset,
        PreimageLocation.Info[] calldata validatorLocations
    ) external payable returns (uint256) {
        return ICoinFlipEnter(coinFlip).enterAndMatch{value: msg.value}(side, validatorSubset, validatorLocations);
    }

    receive() external payable {
        if (reject) revert("rejecting");
    }
}

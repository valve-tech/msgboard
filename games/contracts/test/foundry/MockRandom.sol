// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IRandom} from "../../contracts/implementations/IRandom.sol";
import {ConsumerReceiver} from "../../contracts/implementations/ConsumerReceiver.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";

/// @notice Minimal IRandom stand-in for forge fuzz/invariant tests. heat() mints a fresh key
/// without touching real preimages (so a round/flip can be armed any number of times), randomness()
/// returns whatever seed was driven for a key, and pushCast/pushChop invoke the game's callbacks AS
/// this contract so GameBase's `msg.sender == random` guard is satisfied. The exact entropy that
/// Random would produce is irrelevant to the properties under test (accounting, state machine,
/// winner selection); only the seed value matters, and the tests choose it.
contract MockRandom is IRandom {
    uint256 internal _nonce;

    function heat(uint256, PreimageLocation.Info calldata, PreimageLocation.Info[] calldata, bool)
        external
        payable
        override
        returns (bytes32)
    {
        unchecked {
            return keccak256(abi.encode(address(this), ++_nonce));
        }
    }

    function pointer(PreimageLocation.Info calldata) external view override returns (address) {
        return address(0);
    }

    function consumed(PreimageLocation.Info calldata) external view override returns (bool) {
        return false;
    }

    function latest(address, bool, bool) external view override returns (bytes32) {
        return bytes32(0);
    }

    function randomness(bytes32 key) external view override returns (Randomness memory r) {
        r.seed = _seed[key];
    }

    /// @notice Drive a finalized seed and deliver the push callback (what Random does in cast).
    function pushCast(address game, bytes32 key, bytes32 seed) external {
        _seed[key] = seed;
        ConsumerReceiver(game).onCast(key, seed);
    }

    /// @notice Set the finalized seed without delivering the push (forces the pull fallback path).
    function setSeed(bytes32 key, bytes32 seed) external {
        _seed[key] = seed;
    }

    /// @notice Deliver the chop callback (what Random does when a request expires unfulfilled).
    function pushChop(address game, bytes32 key) external {
        ConsumerReceiver(game).onChop(key);
    }
}

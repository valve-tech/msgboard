// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IGameRules} from "../zk/IGameRules.sol";

/// Permissive, configurable rules for ZkTable unit tests.
contract MockGameRules is IGameRules {
    uint8 public turnMask = 3;
    bool public finalAll = true;
    bytes public nextState;
    bool public applyReverts;
    address public revealVerifierAddr;

    function setTurnMask(uint8 m) external { turnMask = m; }
    function setFinalAll(bool f) external { finalAll = f; }
    function setApply(bytes calldata s, bool revert_) external { nextState = s; applyReverts = revert_; }
    function setRevealVerifier(address a) external { revealVerifierAddr = a; }

    function gameId() external pure returns (uint16) { return 0; }
    function hashGameState(bytes calldata gameState) external pure returns (bytes32) { return keccak256(gameState); }
    function whoseTurn(bytes calldata) external view returns (uint8) { return turnMask; }
    function isFinal(uint8) external view returns (bool) { return finalAll; }
    function applyMove(bytes calldata, bytes calldata) external view returns (bytes memory) {
        require(!applyReverts, "mock: illegal");
        return nextState;
    }
    function revealVerifier() external view returns (address) { return revealVerifierAddr; }
}

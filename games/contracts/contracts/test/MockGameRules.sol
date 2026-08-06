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
    bool public resultDecided;
    uint8 public resultWinner;
    bool public showdownEligible;
    uint32 public showdownSlotA;
    uint32 public showdownSlotB;
    uint8 public showdownWinner;

    function setTurnMask(uint8 m) external { turnMask = m; }
    function setFinalAll(bool f) external { finalAll = f; }
    function setApply(bytes calldata s, bool revert_) external { nextState = s; applyReverts = revert_; }
    function setRevealVerifier(address a) external { revealVerifierAddr = a; }
    function setResult(bool decided_, uint8 winner_) external { resultDecided = decided_; resultWinner = winner_; }
    function setShowdownSlots(bool eligible_, uint32 slotA_, uint32 slotB_) external {
        showdownEligible = eligible_;
        showdownSlotA = slotA_;
        showdownSlotB = slotB_;
    }
    function setShowdownWinner(uint8 winner_) external { showdownWinner = winner_; }

    function gameId() external pure returns (uint16) { return 0; }
    function hashGameState(bytes calldata gameState) external pure returns (bytes32) { return keccak256(gameState); }
    function whoseTurn(bytes calldata) external view returns (uint8) { return turnMask; }
    function result(bytes calldata) external view returns (bool, uint8) { return (resultDecided, resultWinner); }
    function isFinal(uint8) external view returns (bool) { return finalAll; }
    function applyMove(bytes calldata, bytes calldata) external view returns (bytes memory) {
        require(!applyReverts, "mock: illegal");
        return nextState;
    }
    function revealVerifier() external view returns (address) { return revealVerifierAddr; }
    function showdownSlots(bytes calldata) external view returns (bool, uint32, uint32) {
        return (showdownEligible, showdownSlotA, showdownSlotB);
    }
    function showdownResult(bytes calldata, uint8, uint8) external view returns (uint8) {
        return showdownWinner;
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IGameRulesN} from "../zk/IGameRulesN.sol";

/// Permissive, configurable N-seat rules for HoldemTableN unit tests.
/// Mirror of MockGameRules but whoseTurn returns a uint256 mask.
contract MockGameRulesN is IGameRulesN {
    uint256 public turnMask = type(uint256).max; // every seat owes => any demandSeat passes
    bool public finalAll = true;
    bytes public nextState;
    bool public applyReverts;

    function setTurnMask(uint256 m) external { turnMask = m; }
    function setFinalAll(bool f) external { finalAll = f; }
    function setApply(bytes calldata s, bool revert_) external { nextState = s; applyReverts = revert_; }

    function gameId() external pure returns (uint16) { return 0; }
    function hashGameState(bytes calldata gameState) external pure returns (bytes32) { return keccak256(gameState); }
    function whoseTurn(bytes calldata) external view returns (uint256) { return turnMask; }
    function isFinal(uint8) external view returns (bool) { return finalAll; }
    function applyMove(bytes calldata, bytes calldata) external view returns (bytes memory) {
        require(!applyReverts, "mock: illegal");
        return nextState;
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IGameRulesN} from "../zk/IGameRulesN.sol";
import {SidePot} from "../zk/ChannelStateN.sol";

/// Permissive, configurable N-seat rules for HoldemTableN unit tests.
/// Mirror of MockGameRules but whoseTurn returns a uint256 mask.
contract MockGameRulesN is IGameRulesN {
    uint256 public turnMask = type(uint256).max; // every seat owes => any demandSeat passes
    bool public finalAll = true;
    bytes public nextState;
    bool public applyReverts;

    // showdownEligible/settleShowdown configuration (defaults: ineligible / empty settle).
    bool public showdownEligibleFlag;
    uint8 public showdownNSeats;
    uint256 public showdownLiveMask;
    bool public showdownStub;
    uint256[] internal showdownBalances;
    uint256 public showdownRake;
    bool public settleReverts;

    function setTurnMask(uint256 m) external { turnMask = m; }
    function setFinalAll(bool f) external { finalAll = f; }
    function setApply(bytes calldata s, bool revert_) external { nextState = s; applyReverts = revert_; }

    function setShowdownEligible(bool eligible_, uint8 nSeats_, uint256 liveMask_, bool stub_) external {
        showdownEligibleFlag = eligible_;
        showdownNSeats = nSeats_;
        showdownLiveMask = liveMask_;
        showdownStub = stub_;
    }

    function setSettleShowdown(uint256[] calldata balances_, uint256 rake_, bool revert_) external {
        delete showdownBalances;
        for (uint256 i = 0; i < balances_.length; i++) showdownBalances.push(balances_[i]);
        showdownRake = rake_;
        settleReverts = revert_;
    }

    function gameId() external pure returns (uint16) { return 0; }
    function hashGameState(bytes calldata gameState) external pure returns (bytes32) { return keccak256(gameState); }
    function whoseTurn(bytes calldata) external view returns (uint256) { return turnMask; }
    function isFinal(uint8) external view returns (bool) { return finalAll; }
    function applyMove(bytes calldata, bytes calldata) external view returns (bytes memory) {
        require(!applyReverts, "mock: illegal");
        return nextState;
    }

    function showdownEligible(bytes calldata, uint256[] calldata, uint256, SidePot[] calldata)
        external
        view
        returns (bool eligible, uint8 nSeats, uint256 liveMask, bool stub)
    {
        return (showdownEligibleFlag, showdownNSeats, showdownLiveMask, showdownStub);
    }

    function settleShowdown(bytes calldata, uint8[2][] calldata, uint8[5] calldata, uint256)
        external
        view
        returns (uint256[] memory balances, uint256 rakeAccrued)
    {
        require(!settleReverts, "mock: settle reverts");
        return (showdownBalances, showdownRake);
    }
}

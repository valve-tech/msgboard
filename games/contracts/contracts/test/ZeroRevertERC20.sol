// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20 as SolERC20} from "solady/src/tokens/ERC20.sol";

/// @notice M1 test fixture: an ERC20 whose `transfer` reverts on a zero-value amount. This is the
/// failure mode `BonusChips1155.createSeries`'s zero-value-transfer probe exists to reject — an
/// unmodified `GameEscrow.refund` of bet B's zero stake (`token.safeTransfer(player, 0)`) would
/// otherwise revert the whole boosted refund and freeze the player's stake.
contract ZeroRevertERC20 is SolERC20 {
    error ZeroTransfer();

    function name() public pure override returns (string memory) {
        return "";
    }

    function symbol() public pure override returns (string memory) {
        return "";
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (amount == 0) revert ZeroTransfer();
        return super.transfer(to, amount);
    }
}

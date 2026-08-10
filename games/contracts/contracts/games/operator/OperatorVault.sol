// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {GameEscrow} from "./GameEscrow.sol";

/// @notice Minimal EIP-1167-cloneable default funding vault. Holds an operator's capital and funds the
/// GameEscrow bankroll on demand. BYO funding stays first-class — this is a convenience for onboarding,
/// not a required path. Clones share this implementation's code and run initialize() in place of a
/// constructor.
contract OperatorVault {
    using SafeTransferLib for address;

    error AlreadyInit();
    error NotOwner();

    address public owner;
    address public escrow;

    event Funded(address indexed token, uint256 amount);
    event Swept(address indexed token, uint256 amount);

    function initialize(address owner_, address escrow_) external {
        if (owner != address(0)) revert AlreadyInit();
        owner = owner_;
        escrow = escrow_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Move `amount` of the vault's own `token` balance into the escrow's bankroll under the
    /// owner's (owner, token) bucket. The escrow pulls via transferFrom, so approve it first.
    function fund(address token, uint256 amount) external onlyOwner {
        token.safeApprove(escrow, amount);
        GameEscrow(escrow).depositBankroll(owner, token, amount);
        emit Funded(token, amount);
    }

    function sweep(address token, uint256 amount) external onlyOwner {
        token.safeTransfer(owner, amount);
        emit Swept(token, amount);
    }
}

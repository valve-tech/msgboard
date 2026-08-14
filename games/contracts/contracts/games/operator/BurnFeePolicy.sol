// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {IFeePolicy} from "./IFeePolicy.sol";

/// @notice The default neutral sink: burns everything routed to it. Never a round participant, so it is
/// a safe forfeit destination. `feeBps` is 0 (the forfeit site routes the full amount and ignores it).
contract BurnFeePolicy is IFeePolicy {
    using SafeTransferLib for address;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Total burned per token, for QA and observability.
    mapping(address token => uint256) public burned;

    function feeBps(bytes32, address, address) external pure returns (uint16) {
        return 0;
    }

    /// @notice Burn `amount` of `token` already delivered to this contract by sending it to the dead
    /// address. Reverts if the transfer fails (a token that blocks dead-address transfers), so the
    /// caller's try/catch parks the amount rather than losing it.
    function route(bytes32, address token, uint256 amount, bytes calldata) external {
        burned[token] += amount;
        token.safeTransfer(DEAD, amount);
    }
}

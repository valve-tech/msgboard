// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {EscrowLib} from "./EscrowLib.sol";
import {OperatorRegistry} from "./OperatorRegistry.sol";

/// @notice The standardized settlement seam — the safety-critical core of the table-maintainer
/// substrate. Holds ALL player and operator funds in per-(operator, token) isolated ledgers, pulls
/// every deposit with balance-delta verification (fee-on-transfer / rebasing safe), and pays out
/// deterministically. It is token-agnostic (any ERC-20, no whitelist, no oracle). Bet lifecycle
/// (lockExposure / settle / refund / rake) is added in Tasks 4–6.
contract GameEscrow {
    using SafeTransferLib for address;
    using EscrowLib for EscrowLib.Ledger;

    address public immutable registry;

    mapping(bytes32 key => EscrowLib.Ledger) internal ledgers;

    event BankrollDeposited(address indexed operator, address indexed token, address indexed from, uint256 credited);
    event BankrollWithdrawn(address indexed operator, address indexed token, uint256 amount);

    constructor(address registry_) {
        registry = registry_;
    }

    function _ledgerKey(address operator, address token) internal pure returns (bytes32) {
        return keccak256(abi.encode(operator, token));
    }

    function bankrollOf(address operator, address token) external view returns (uint256) {
        return ledgers[_ledgerKey(operator, token)].bankroll;
    }

    /// @notice Pull `amount` of `token` from `from` and return the MEASURED delta actually received.
    /// Crediting the delta (not the requested amount) keeps the books exact for fee-on-transfer and
    /// rebasing tokens, and contains any such token to its own bucket.
    function _pullVerified(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balBefore;
    }

    /// @notice Fund an operator's (operator, token) bankroll from msg.sender — the BYO funding source
    /// (EOA, Safe, OperatorVault clone). Anyone may fund any operator; only the measured delta is
    /// credited.
    function depositBankroll(address operator, address token, uint256 amount) external {
        uint256 credited = _pullVerified(token, msg.sender, amount);
        ledgers[_ledgerKey(operator, token)].creditBankroll(credited);
        emit BankrollDeposited(operator, token, msg.sender, credited);
    }

    /// @notice Operator withdraws its own idle bankroll. Debits its (operator, token) ledger only —
    /// locked and rake are untouchable here.
    function withdrawBankroll(address token, uint256 amount) external {
        ledgers[_ledgerKey(msg.sender, token)].debitBankroll(amount);
        token.safeTransfer(msg.sender, amount);
        emit BankrollWithdrawn(msg.sender, token, amount);
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Minimal classic (SSTORE) reentrancy mutex for the operator substrate.
///
/// Deliberately NOT Solady's `ReentrancyGuard`: that implementation uses transient storage (TSTORE),
/// a Cancun opcode that reverts as "invalid opcode" on the pre-Cancun chains this substrate targets
/// (PulseChain 943/369). A plain storage-slot mutex emits only SLOAD/SSTORE — MCOPY/TSTORE-free — so
/// it deploys and runs there.
///
/// Why the substrate needs it: `GameEscrow` credits ledgers by the MEASURED balance delta across an
/// external `transferFrom`. A hostile/hooked token (ERC-777 and friends) that re-enters a second
/// deposit mid-transfer makes the outer delta span the inner transfer, over-crediting the ledger
/// (deposit 200 + inner 100 → credit 400 for 300 real tokens) and breaking per-bucket solvency. The
/// guard makes any re-entry into a guarded custody function revert, so only genuine, non-nested
/// transfers are ever measured. It is shared across every token-moving entrypoint (one mutex per
/// contract), so cross-function re-entry — e.g. a payout transfer re-entering `depositBankroll` — is
/// blocked too.
///
/// The unlocked sentinel is any value != _ENTERED. A freshly deployed contract initialises `_status`
/// to _NOT_ENTERED in the constructor; an EIP-1167 clone (which runs no constructor) leaves it 0,
/// which is also != _ENTERED, so the guard is correctly "unlocked" on a clone's first call and only
/// costs a warm 0→2→0 SSTORE cycle thereafter.
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status = _NOT_ENTERED;

    error Reentrancy();

    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Pluggable, stricter-only validator-inclusion policy for an operator table. The game
/// enforces the hard floor (>=3 distinct allowlisted validators) BEFORE calling this, so a policy can
/// only ADD constraints, never weaken them. MUST be view: it may read state but cannot move funds.
interface IValidatorPolicy {
    /// @return ok true iff `subset` satisfies the operator's rule for `tableId`. `proposer` is the party
    /// assembling the round (the player in a 1-player game; the opener/game in a future N-party game).
    function validate(address operator, bytes32 tableId, address proposer, address[] calldata subset)
        external
        view
        returns (bool ok);
}

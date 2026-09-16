// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Pluggable fee-routing seam. A fee-producing contract transfers the fee tokens to the policy
/// and then calls `route`, which sends them to their destination (burn / buyback / recipient). `kind`
/// distinguishes call sites so one policy can price each differently; `feeBps` is read by percentage-cut
/// call sites (mint-sale/marketplace) BEFORE transferring — the forfeit call site skips it and routes
/// the full amount. A policy MUST NOT forward to any address named in `context` as a round participant.
interface IFeePolicy {
    function feeBps(bytes32 kind, address token, address payer) external view returns (uint16 bps);
    function route(bytes32 kind, address token, uint256 amount, bytes calldata context) external;
}

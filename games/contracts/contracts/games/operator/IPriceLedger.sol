// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice The burn-routed price-release hook the BonusChips1155 fires after every `_burn`. The MintSale
/// (S2c) implements it: a burned charge releases exactly one stamped price `P`, routed by `(burner,
/// beneficiary)` — pool burn refunds the holder, a game burn with a beneficiary (chop) refunds the
/// player, a game burn with no beneficiary (settled win/loss) vests `P - f` to the operator and accrues
/// the fee `f`.
///
/// HOOK-SAFETY RULE (load-bearing): the implementer MUST treat this as SSTORE-only, make no external
/// call, and never revert on any reachable burn input (an unknown series is a no-op). A reverting hook
/// would freeze settles and expiry.
interface IPriceLedger {
    function onBurn(address burner, address from, uint256 id, uint256 amount, address beneficiary) external;
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice The ledger hooks the boosted game (S2b) calls on the BackingPool, one per escrow-bet
/// terminal. Every hook is `msg.sender == game` only — the game holds its own reentrancy mutex across
/// the whole boosted round, so these are pure internal-ledger mutations with no token movement of
/// their own (the paired bet-B lock/settle/refund the game performs on GameEscrow does the actual
/// escrow accounting; the hook mirrors it in the pool's earmark/hold/credit ledger).
///
/// Maps to the accounting doc transitions:
/// - `consume`       → T2 (open):  earmark -= w; hold[roundId] = w - d.
/// - `onSettleWin`   → T3:         hold -> credit[op] += r (residual only; d was paid to the player).
/// - `onSettleLoss`  → T4:         hold -> credit[op] += w (operator owns d after a settled loss).
/// - `onPlainRefund` → T5:         hold -> earmark += w (the returned d+r re-backs the returned charge).
/// - `onChopRefund`  → T6:         hold -> credit[op] += w (charge is burned, not returned).
interface IBackingPool {
    function consume(bytes32 roundId, uint256 seriesId, uint256 d) external;
    function onSettleWin(bytes32 roundId) external;
    function onSettleLoss(bytes32 roundId) external;
    function onPlainRefund(bytes32 roundId) external;
    function onChopRefund(bytes32 roundId) external;
}

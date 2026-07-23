// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// The N-seat rules seam: HoldemTableN is game-agnostic and consults one of these per table.
/// Mirror of IGameRules but `whoseTurn` returns a uint256 bitmask (bit i set => seat i owes
/// the next protocol action) so the channel can name a misbehaving seat at seat-level
/// granularity — the carry-forward from the Task 2/3 deal-layer ShareAttributionFault{slot,seat}.
/// gameState/move byte encodings are owned by the implementing game (canonical abi tuples
/// mirrored in the game's TS package; parity-tested).
interface IGameRulesN {
    function gameId() external view returns (uint16);
    /// keccak over the game's canonical encoding; must equal ChannelStateN.gameStateHash.
    function hashGameState(bytes calldata gameState) external view returns (bytes32);
    /// Bitmask of seats that owe the next protocol action: bit i => seat i, 0 => none.
    function whoseTurn(bytes calldata gameState) external view returns (uint256 mask);
    /// May a state with this phase settle cooperatively?
    function isFinal(uint8 phase) external view returns (bool);
    /// Apply a demanded move to a contested game state; MUST revert if illegal.
    /// Returns the new canonical game-state encoding.
    function applyMove(bytes calldata gameState, bytes calldata move) external view returns (bytes memory);
}

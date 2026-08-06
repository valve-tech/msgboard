// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// The rules seam: ZkTable is game-agnostic and consults one of these per table.
/// gameState/move byte encodings are owned by the implementing game (canonical
/// abi tuples mirrored in the game's TS package; parity-tested).
interface IGameRules {
    function gameId() external view returns (uint16);
    /// keccak over the game's canonical encoding; must equal ChannelState.gameStateHash.
    function hashGameState(bytes calldata gameState) external view returns (bytes32);
    /// Bitmask of seats that owe the next protocol action: bit0 = A, bit1 = B, 0 = none.
    function whoseTurn(bytes calldata gameState) external view returns (uint8);
    /// (decided, winner): decided=true only when the game state carries a final,
    /// non-tie result; winner is seat 1 (A) or 2 (B). MUST be total (non-reverting)
    /// on any co-signed canonical encoding, like whoseTurn.
    function result(bytes calldata gameState) external view returns (bool decided, uint8 winner);
    /// May a state with this phase settle cooperatively?
    function isFinal(uint8 phase) external view returns (bool);
    /// Apply a demanded move to a contested game state; MUST revert if illegal.
    /// Returns the new canonical game-state encoding.
    function applyMove(bytes calldata gameState, bytes calldata move) external view returns (bytes memory);
    /// Address of the Groth16 snark-reveal verifier used for share disputes.
    function revealVerifier() external view returns (address);
    /// Is this game state a showdown eligible for on-chain card-reveal settlement, and if so
    /// which two deck slots hold the contested cards? MUST be total (non-reverting) on any
    /// co-signed canonical encoding, like whoseTurn/result. slotA/slotB are meaningless when
    /// eligible=false.
    function showdownSlots(bytes calldata gameState) external view returns (bool eligible, uint32 slotA, uint32 slotB);
    /// Given the two showdown cards decoded from the revealed deck slots, who wins the pot?
    /// 1 = seat A, 2 = seat B, 0 = tie. Only ever called after showdownSlots reported eligible.
    function showdownResult(bytes calldata gameState, uint8 cardA, uint8 cardB) external view returns (uint8 winner);
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SidePot} from "./ChannelStateN.sol";

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

    /// On-chain showdown adjudication seam (HoldemTableN C2 dispute path). A non-reverting
    /// membership + structural check: does `gameState` (already hash-pinned to a co-signed
    /// ChannelStateN via hashGameState) carry the SAME balances/pot/sidePots as the channel
    /// state, and sit in a showdown-eligible phase? Implementations MUST return
    /// `eligible = false` on any mismatch rather than reverting, so the caller can branch.
    /// `nSeats` is the game's seat count (from gameState) regardless of `eligible`.
    /// `liveMask`: bit i set => seat i is still live (non-folded) as of `gameState`.
    /// `stub`: true when exactly one seat is live — the game's own uncontested-hand path has
    /// already swept the pot(s) to that seat, so `settleShowdown`'s holes/board are irrelevant.
    function showdownEligible(bytes calldata gameState, uint256[] calldata balances, uint256 pot, SidePot[] calldata sidePots)
        external
        view
        returns (bool eligible, uint8 nSeats, uint256 liveMask, bool stub);

    /// Run the game's real showdown adjudication and return the settled money vector — the
    /// piece the game's own applyMove(showdown-move) computes internally but a caller that
    /// merely calls applyMove for its side effects would otherwise discard. MUST revert if
    /// `gameState` is not in a showdown-eligible phase.
    /// `extraFoldMask`: bit i set => mask seat i's hole cards out of hand ranking (an
    /// answer-aware forced-fold for a seat that failed to reveal its cards in time).
    /// Implementations MUST NOT read the hole cards of an already-folded or masked-out seat,
    /// so callers MAY pass zeros for them.
    function settleShowdown(bytes calldata gameState, uint8[2][] calldata holes, uint8[5] calldata board, uint256 extraFoldMask)
        external
        view
        returns (uint256[] memory balances, uint256 rakeAccrued);
}

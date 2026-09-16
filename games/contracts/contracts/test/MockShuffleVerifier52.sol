// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice TEST-ONLY stand-in for the real ShuffleVerifier52: lets ZkTableDecoyUnit.t.sol exercise
/// `challengeDeck`'s BOOKKEEPING (bond conservation, one-shot, dispatch, `_clearDispute` wiping)
/// with self-consistent-but-arbitrary deck/proof bytes, without needing the real Zypher WASM
/// prover (that end-to-end crypto path is covered separately, with REAL proofs, by
/// ZkTableDecoyChallenge.t.sol's ffi suite). `calls` counts invocations in submission order so a
/// test can script "step index N fails" via `setFailAt`.
contract MockShuffleVerifier52 {
    error MockShuffleFail();

    uint256 public calls;
    mapping(uint256 => bool) public failAt;

    /// Marks the `idx`-th call to `verify52` (0-indexed, in submission order) to revert instead
    /// of succeeding — models a step whose proof fails real verification.
    function setFailAt(uint256 idx) external {
        failAt[idx] = true;
    }

    function verify52(bytes calldata, uint256[] calldata, uint256[] calldata) external returns (bool) {
        uint256 idx = calls;
        calls = idx + 1;
        if (failAt[idx]) revert MockShuffleFail();
        return true;
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IShuffleVerifier52 {
    function verify52(bytes calldata proof, uint256[] calldata pi, uint256[] calldata pkc) external returns (bool);
}

interface IRevealVerifier {
    function verifyRevealWithSnark(uint256[6] calldata pi, uint256[8] calldata zkproof) external view returns (bool);
}

/// On-chain gas probe for the zk verifier paths.
///
/// Measures EXECUTION gas (the gasleft() delta straddling the verifier call) rather than the
/// full transaction gasUsed. Execution gas excludes the 21k tx intrinsic and the per-byte
/// calldata cost of the (multi-KB) proof, so it matches the spike's bench figures:
///   - verify52              spike: 1,569,952
///   - verifyRevealWithSnark spike:   225,157
/// The ZkGas test deploys this, calls the probe, and asserts the returned number against the
/// spike-derived ceiling. Both probe functions return the measured gas so the test reads it
/// directly from the call result.
contract GasProbe {
    /// Calls verify52 and returns the execution gas consumed by that call.
    /// Reverts if the proof is rejected so a failed verification can never be measured as "cheap".
    function probeVerify52(
        address verifier,
        bytes calldata proof,
        uint256[] calldata pi,
        uint256[] calldata pkc
    ) external returns (uint256 gasUsed, bool ok) {
        uint256 before = gasleft();
        ok = IShuffleVerifier52(verifier).verify52(proof, pi, pkc);
        gasUsed = before - gasleft();
        require(ok, "verify52 returned false");
    }

    /// Calls verifyRevealWithSnark (view) and returns the execution gas consumed by that call.
    function probeVerifyReveal(
        address verifier,
        uint256[6] calldata pi,
        uint256[8] calldata zkproof
    ) external returns (uint256 gasUsed, bool ok) {
        uint256 before = gasleft();
        ok = IRevealVerifier(verifier).verifyRevealWithSnark(pi, zkproof);
        gasUsed = before - gasleft();
        require(ok, "verifyRevealWithSnark returned false");
    }
}

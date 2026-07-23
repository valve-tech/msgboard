// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Stand-in for the vendored RevealVerifier in dispute-path unit tests.
contract MockRevealVerifier {
    bool public ok = true;
    function setOk(bool v) external { ok = v; }
    function verifyRevealWithSnark(uint256[6] calldata, uint256[8] calldata) external view returns (bool) {
        return ok;
    }
}

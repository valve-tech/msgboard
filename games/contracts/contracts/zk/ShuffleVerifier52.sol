// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ShuffleVerifier} from "../vendor/uzkge/shuffle/ShuffleVerifier.sol";
import {VerifierKey_52} from "../vendor/uzkge/shuffle/VerifierKey_52.sol";

/// @notice Calldata-shaped 52-card shuffle verifier: decks come in as calldata
/// (no storage round-trip like uzkge's demo ShuffleService — that pattern costs
/// 2.09M to verify + 4.76M to stage; this one measured 1,569,952 gas in the spike).
/// pi = flatten(before deck, 208 words) ++ flatten(after deck, 208 words);
/// pkc = the 24-word refresh_joint_key output cached with the table's channel state.
contract ShuffleVerifier52 is ShuffleVerifier {
    error InvalidShuffleProof();

    constructor(address vk1, address vk2) ShuffleVerifier(vk1, vk2) {}

    function verify52(bytes calldata proof, uint256[] calldata pi, uint256[] calldata pkc)
        external
        returns (bool)
    {
        _verifyKey = VerifierKey_52.load;
        try this.verifyShuffle(proof, pi, pkc) returns (bool ok) {
            if (ok) return true;
            revert InvalidShuffleProof();
        } catch {
            // PlonkVerifier reverts bare on invalid proofs (never returns false);
            // re-throw a named selector so dispute tooling can match on it.
            revert InvalidShuffleProof();
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {DeckShuffleStep} from "../../contracts/zk/DeckChallengeLib.sol";

/// Proves the on-chain keccak(abi.encode(...)) for jointKeyCommit and shuffleRoot is
/// BYTE-IDENTICAL to the off-chain TS builder (games/zk-core/src/deckBinding.ts), pinned
/// against the exact fixture hashes the TS side produced. A mismatch here means every honest
/// on-chain decoy challenge would silently revert BadTranscript and downgrade to a timeout
/// split — this is the one parity that cannot be allowed to drift.
contract DeckBindingParityTest is Test {
    // From deckBinding.ts fixture: jointKeyCommit(aggX=1, aggY=2, pkc=[3..26])
    bytes32 constant TS_JOINT_KEY_COMMIT =
        0x4d055a87f1e16beec6692ef6253775ce5c5f3d92463cdb38b056c11f56c520d5;
    // From deckBinding.ts fixture: shuffleRoot over the 2 steps below
    bytes32 constant TS_SHUFFLE_ROOT =
        0x678cdad02d5b00f93b0eb6f3b73618f9c3ce0a01140771413550850fc1a23e7a;

    function test_jointKeyCommit_matchesTsEncoding() public pure {
        uint256[24] memory pkc;
        for (uint256 i = 0; i < 24; i++) {
            pkc[i] = i + 3; // 3..26
        }
        bytes32 onChain = keccak256(abi.encode(uint256(1), uint256(2), pkc));
        assertEq(onChain, TS_JOINT_KEY_COMMIT, "jointKeyCommit Solidity<->TS encoding drift");
    }

    function test_shuffleRoot_matchesTsEncoding() public pure {
        bytes32 h1 = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 h2 = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        bytes32 h3 = bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333));
        bytes32 h4 = bytes32(uint256(0x4444444444444444444444444444444444444444444444444444444444444444));
        bytes32 h5 = bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555));

        DeckShuffleStep[] memory steps = new DeckShuffleStep[](2);
        steps[0] = DeckShuffleStep({authorSeat: 1, beforeHash: h1, afterHash: h2, proofHash: h3});
        steps[1] = DeckShuffleStep({authorSeat: 2, beforeHash: h2, afterHash: h4, proofHash: h5});

        bytes32 onChain = keccak256(abi.encode(steps));
        assertEq(onChain, TS_SHUFFLE_ROOT, "shuffleRoot Solidity<->TS encoding drift");
    }
}

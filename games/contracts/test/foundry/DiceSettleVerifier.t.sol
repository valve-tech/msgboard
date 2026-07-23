// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HonkVerifier} from "../../contracts/zk/generated/DiceSettleHonkVerifier.sol";

/// Toolchain probe: deploy the generated UltraHonk verifier and feed it the REAL
/// proof fixture produced by examples/games/zk-settle/scripts/genOnchainVerifier.ts.
/// This isolates "does the generated verifier accept a real proof on-chain" from the
/// HouseChannel settlement plumbing. If this is green, mode-2 can rely on it.
contract DiceSettleVerifierTest is Test {
    HonkVerifier internal verifier;

    function setUp() public {
        verifier = new HonkVerifier();
    }

    function _loadFixture() internal view returns (bytes memory proof, bytes32[] memory publicInputs) {
        string memory json = vm.readFile("test/foundry/fixtures/diceSettleOnchainProof.json");
        proof = vm.parseJsonBytes(json, ".proof");
        publicInputs = vm.parseJsonBytes32Array(json, ".publicInputs");
    }

    function test_realProofVerifies() public view {
        (bytes memory proof, bytes32[] memory publicInputs) = _loadFixture();
        bool ok = verifier.verify(proof, publicInputs);
        assertTrue(ok, "generated verifier rejected a valid proof");
    }

    function test_tamperedPublicInputReverts() public {
        (bytes memory proof, bytes32[] memory publicInputs) = _loadFixture();
        // flip the payoutPlayer public input (last element) — proof no longer matches.
        publicInputs[publicInputs.length - 1] = bytes32(uint256(publicInputs[publicInputs.length - 1]) + 1);
        // bb verifier reverts (Sumcheck/Shplemini failure) on a bad public input.
        vm.expectRevert();
        verifier.verify(proof, publicInputs);
    }

    function test_tamperedProofReverts() public {
        (bytes memory proof, bytes32[] memory publicInputs) = _loadFixture();
        proof[proof.length - 1] = bytes1(uint8(proof[proof.length - 1]) ^ 0xff);
        vm.expectRevert();
        verifier.verify(proof, publicInputs);
    }
}

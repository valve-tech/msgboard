// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.25;

// NOTE ON PROOF PROVENANCE (GPL): the fixture this test consumes
// (test/fixtures/zypher-shuffle52-gen.json) is produced by
// examples/games/zk-core/scripts/gen-shuffle-proof.mts, which uses the GPLv3-derived
// @zypher-game/secret-engine WASM prover — PoC only, pending license review. The vendored
// on-chain verifier (ShuffleVerifier52 / uzkge PlonkVerifier) is unchanged and carries no
// new license exposure; only the off-chain proof GENERATION is GPL-derived.

import {Test} from "forge-std/Test.sol";
import {ShuffleVerifier52} from "../../contracts/zk/ShuffleVerifier52.sol";
import {VerifierKeyExtra1_52} from "../../contracts/vendor/uzkge/shuffle/VerifierKeyExtra1_52.sol";
import {VerifierKeyExtra2_52} from "../../contracts/vendor/uzkge/shuffle/VerifierKeyExtra2_52.sol";

// P6.2 — POSITIVE on-chain verification of a FRESHLY-GENERATED Zypher uzkge shuffle proof
// against the vendored ShuffleVerifier52. The sibling ShuffleVerifier52.t.sol only exercises
// FAILURE paths (random/tampered proofs revert); this proves the happy path: a real Baby-JubJub
// shuffle proof, generated off-chain by the zypher secret-engine WASM prover and pre-verified
// there by verify_shuffled_cards, also verifies on-chain via verify52 == true. This closes the
// end-to-end loop (prover -> vendored verifier) and confirms the v0.3.0 proving key is consistent
// with the vendored VerifierKey_52.
//
// Regenerate the fixture from examples/games/zk-core with:
//   pnpm exec tsx scripts/gen-shuffle-proof.mts
contract ShuffleVerifier52PositiveTest is Test {
    ShuffleVerifier52 internal verifier;

    uint256 internal constant PI_LEN = 416;
    uint256 internal constant PKC_LEN = 24;

    string internal json;
    uint256[] internal pi;
    uint256[] internal pkc;
    bytes internal proof;

    function setUp() public {
        VerifierKeyExtra1_52 vk1 = new VerifierKeyExtra1_52();
        VerifierKeyExtra2_52 vk2 = new VerifierKeyExtra2_52();
        verifier = new ShuffleVerifier52(address(vk1), address(vk2));

        json = vm.readFile("test/fixtures/zypher-shuffle52-gen.json");
        pi = vm.parseJsonUintArray(json, ".pi");
        pkc = vm.parseJsonUintArray(json, ".pkc");
        proof = vm.parseJsonBytes(json, ".proof");

        require(pi.length == PI_LEN, "fixture pi length changed");
        require(pkc.length == PKC_LEN, "fixture pkc length changed");
        require(proof.length == 1632, "fixture proof length changed");
    }

    /// External boundary so verify52's revert-on-failure can be caught by selector.
    function callVerify(bytes calldata p, uint256[] calldata _pi, uint256[] calldata _pkc)
        external
        returns (bool)
    {
        return verifier.verify52(p, _pi, _pkc);
    }

    /// The freshly-generated proof MUST verify true on-chain.
    function test_freshProofVerifiesOnChain() external {
        bool ok = this.callVerify(proof, pi, pkc);
        assertTrue(ok, "freshly-generated shuffle proof must verify on-chain (verify52 == true)");
    }

    /// Flipping a single byte of the otherwise-valid proof must surface InvalidShuffleProof —
    /// guards that the positive result above is meaningful (not an always-pass).
    function test_tamperedProofRejected() external {
        bytes memory bad = proof;
        bad[bad.length - 1] = bad[bad.length - 1] ^ bytes1(0xff);
        try this.callVerify(bad, pi, pkc) returns (bool ok) {
            assertFalse(ok, "tampered proof must not verify");
        } catch (bytes memory err) {
            assertEq(bytes4(err), ShuffleVerifier52.InvalidShuffleProof.selector, "expect InvalidShuffleProof");
        }
    }

    /// Corrupting a single public-input word must also be rejected (binds proof <-> pi).
    function test_tamperedPublicInputRejected() external {
        uint256[] memory badPi = pi;
        badPi[0] = addmod(badPi[0], 1, type(uint256).max);
        try this.callVerify(proof, badPi, pkc) returns (bool ok) {
            assertFalse(ok, "proof must not verify against mutated public inputs");
        } catch (bytes memory err) {
            assertEq(bytes4(err), ShuffleVerifier52.InvalidShuffleProof.selector, "expect InvalidShuffleProof");
        }
    }
}

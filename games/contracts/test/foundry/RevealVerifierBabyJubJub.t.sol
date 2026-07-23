// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.25;

// NOTE ON PROOF PROVENANCE (GPL): the reveal proof this test consumes
// (test/fixtures/zypher-shuffle52-gen.json -> .reveal) is produced by
// examples/games/zk-core/scripts/gen-shuffle-proof.mts using the GPLv3-derived
// @zypher-game/secret-engine WASM prover — PoC only, pending license review. The vendored
// on-chain RevealVerifier is unchanged; only off-chain proof GENERATION is GPL-derived.

import {Test} from "forge-std/Test.sol";
import {RevealVerifier, MaskedCard} from "../../contracts/vendor/uzkge/shuffle/RevealVerifier.sol";
import {EdOnBN254} from "../../contracts/vendor/uzkge/libraries/EdOnBN254.sol";

// P6.4 — convergence PoC. Now that the deck is Baby-JubJub (EdOnBN254), a single-party
// reveal/decryption SHARE is a Chaum-Pedersen DLEQ that the VENDORED EdOnBN254
// RevealVerifier.verifyReveal checks directly. This is the curve-correct replacement the Gate-1
// note anticipated for the secp256k1 RevealShareDLEQ once the deck moved off secp256k1.
//
// This test proves the vendored verifier accepts a FRESHLY-generated zypher reveal_card proof
// on-chain (mirroring P6.2 for the shuffle). The full HoldemTableN.respondWithShare re-home onto
// this verifier (plus binding the table/slot ctx, which zypher's reveal proof does not carry) is
// the remaining integration work and is intentionally NOT done here — see the spec P6.4.
contract RevealVerifierBabyJubJubTest is Test {
    RevealVerifier internal reveal;
    string internal json;

    EdOnBN254.Point internal pk;
    MaskedCard internal masked;
    EdOnBN254.Point internal token;
    bytes internal proof;

    function setUp() public {
        reveal = new RevealVerifier();
        json = vm.readFile("test/fixtures/zypher-shuffle52-gen.json");

        uint256[] memory pkArr = vm.parseJsonUintArray(json, ".reveal.pk");
        uint256[] memory mArr = vm.parseJsonUintArray(json, ".reveal.masked");
        uint256[] memory tArr = vm.parseJsonUintArray(json, ".reveal.token");
        proof = vm.parseJsonBytes(json, ".reveal.proof");

        require(pkArr.length == 2 && mArr.length == 4 && tArr.length == 2, "fixture reveal shape changed");
        require(proof.length == 160, "reveal proof must be 160 bytes (a||b||r)");

        pk = EdOnBN254.Point(pkArr[0], pkArr[1]);
        masked = MaskedCard(mArr[0], mArr[1], mArr[2], mArr[3]); // e2X, e2Y, e1X, e1Y
        token = EdOnBN254.Point(tArr[0], tArr[1]);
    }

    /// The freshly-generated reveal DLEQ proof MUST verify on-chain against the vendored
    /// EdOnBN254 verifier — proving it is curve-correct for our Baby-JubJub deck.
    function test_freshRevealVerifiesOnChain() external view {
        bool ok = reveal.verifyReveal(pk, masked, token, proof);
        assertTrue(ok, "freshly-generated Baby-JubJub reveal proof must verify (verifyReveal == true)");
    }

    /// Flipping a byte of the DLEQ response `r` must break verification (returns false).
    function test_tamperedRevealRejected() external view {
        bytes memory bad = proof;
        bad[bad.length - 1] = bad[bad.length - 1] ^ bytes1(0x01);
        bool ok = reveal.verifyReveal(pk, masked, token, bad);
        assertFalse(ok, "tampered reveal proof must not verify");
    }

    /// A reveal token from a different point must be rejected (binds proof <-> reveal).
    function test_wrongRevealTokenRejected() external view {
        EdOnBN254.Point memory wrong = EdOnBN254.Point(token.x, addmod(token.y, 1, EdOnBN254.R));
        bool ok = reveal.verifyReveal(pk, masked, wrong, proof);
        assertFalse(ok, "proof must not verify against a mutated reveal token");
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {ShuffleVerifier52} from "../../contracts/zk/ShuffleVerifier52.sol";
import {VerifierKeyExtra1_52} from "../../contracts/vendor/uzkge/shuffle/VerifierKeyExtra1_52.sol";
import {VerifierKeyExtra2_52} from "../../contracts/vendor/uzkge/shuffle/VerifierKeyExtra2_52.sol";
import {RevealVerifier} from "../../contracts/vendor/uzkge/shuffle/RevealVerifier.sol";

/// @notice Negative-fuzz suite for the 52-card shuffle verifier + the vendored
/// reveal-snark verifier. The hardhat suite (test/ZkVerifiers.test.ts) already
/// pins the happy paths (verify52 accepts a valid proof, single-byte tamper is
/// rejected, verifyRevealWithSnark accepts a valid pair); this suite proves the
/// FAILURE paths via property-based fuzzing — invisible to those tests.
///
/// Core property of verify52: EVERY non-valid input path must surface the named
/// `ShuffleVerifier52.InvalidShuffleProof` selector — never a bare revert, never
/// a raw Panic (array-OOB / decode), never `false`, never `true`.
contract ShuffleVerifier52FuzzTest is Test {
    ShuffleVerifier52 internal verifier;

    // Contract NatSpec: pi = before-deck (208 words) ++ after-deck (208 words) = 416;
    // pkc = 24-word refresh_joint_key cache.
    uint256 internal constant PI_LEN = 416;
    uint256 internal constant PKC_LEN = 24;

    // BN254 scalar field modulus — keeps fuzzed words inside the field so we never
    // trip an early field-range require before reaching the plonk core.
    uint256 internal constant FR =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function setUp() public {
        VerifierKeyExtra1_52 vk1 = new VerifierKeyExtra1_52();
        VerifierKeyExtra2_52 vk2 = new VerifierKeyExtra2_52();
        verifier = new ShuffleVerifier52(address(vk1), address(vk2));
    }

    /// External boundary so a `verify52` revert can be caught by selector. `verify52`
    /// is `external`, so it must be invoked through a message call (this.callVerify)
    /// to produce a catchable returndata frame.
    function callVerify(bytes calldata proof, uint256[] calldata pi, uint256[] calldata pkc)
        external
        returns (bool)
    {
        return verifier.verify52(proof, pi, pkc);
    }

    /// Assert that a verify52 call over the given args NEVER reports success:
    /// either it returns `false` (assertFalse), or it reverts with EXACTLY the
    /// named `InvalidShuffleProof` selector. Any other revert/panic/`true` fails.
    function _assertNeverVerifies(bytes memory proof, uint256[] memory pi, uint256[] memory pkc)
        internal
    {
        try this.callVerify(proof, pi, pkc) returns (bool ok) {
            // Contract is written to revert (not return false) on failure, but if a
            // future change ever returns, it must NEVER be a spurious `true`.
            assertFalse(ok, "random/invalid input must never verify true");
        } catch (bytes memory err) {
            assertEq(err.length, 4, "must be a 4-byte named selector, not a bare/Panic revert");
            assertEq(
                bytes4(err),
                ShuffleVerifier52.InvalidShuffleProof.selector,
                "every failure path must surface InvalidShuffleProof"
            );
        }
    }

    function _fieldFill(uint256 len, uint256 seed) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            // Deterministic but seed-varied field elements; bound into [0, FR).
            arr[i] = bound(uint256(keccak256(abi.encode(seed, i))), 0, FR - 1);
        }
    }

    /// Random bytes essentially never form a valid plonk proof, so the only sound
    /// outcome is the named revert. The plonk verifier is heavy, so cap runs — 128
    /// is ample to establish the "never true / always named selector" property.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_randomProofNeverVerifies(bytes calldata proof, uint256 piFill, uint256 pkcFill)
        external
    {
        uint256[] memory pi = _fieldFill(PI_LEN, piFill);
        uint256[] memory pkc = _fieldFill(PKC_LEN, pkcFill);
        _assertNeverVerifies(proof, pi, pkc);
    }

    /// Wrong-length pi/pkc must ALSO surface InvalidShuffleProof — the try/catch
    /// re-throw has to absorb array-OOB / decode Panics so no raw Panic escapes.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_wrongLengthInputsRejected(uint16 piLen, uint16 pkcLen, bytes calldata proof)
        external
    {
        // Bound to small ranges that are (almost surely) the WRONG length.
        uint256 pLen = bound(uint256(piLen), 0, 64);
        uint256 kLen = bound(uint256(pkcLen), 0, 64);
        uint256[] memory pi = _fieldFill(pLen, uint256(piLen));
        uint256[] memory pkc = _fieldFill(kLen, uint256(pkcLen));
        _assertNeverVerifies(proof, pi, pkc);
    }

    /// Empty proof with correctly-shaped pi/pkc → InvalidShuffleProof.
    function test_emptyProofRejected() external {
        uint256[] memory pi = _fieldFill(PI_LEN, 1);
        uint256[] memory pkc = _fieldFill(PKC_LEN, 2);
        _assertNeverVerifies("", pi, pkc);
    }

    // ------------------------------------------------------------------
    // RevealVerifier — direct verifier-level reject of a tampered snark.
    // The hardhat suite only exercises the ZkTable-layer BadProof; this pins
    // the underlying verifyRevealWithSnark(false) on a mutated proof.
    // ------------------------------------------------------------------

    function _loadRevealFixture()
        internal
        view
        returns (uint256[6] memory pi, uint256[8] memory zkproof)
    {
        string memory json = vm.readFile("test/fixtures/zypher-reveal-snark.json");
        uint256[] memory piArr = vm.parseJsonUintArray(json, ".pi");
        uint256[] memory zpArr = vm.parseJsonUintArray(json, ".zkproof");
        require(piArr.length == 6 && zpArr.length == 8, "fixture shape changed");
        for (uint256 i = 0; i < 6; i++) pi[i] = piArr[i];
        for (uint256 i = 0; i < 8; i++) zkproof[i] = zpArr[i];
    }

    function testFuzz_revealSnarkRejectsTamper(uint256 idx, uint256 delta) external {
        RevealVerifier reveal = new RevealVerifier();
        (uint256[6] memory pi, uint256[8] memory zkproof) = _loadRevealFixture();

        // Sanity: the untampered pair must verify (mirrors the hardhat happy path,
        // but here it guards that our tamper test is meaningful).
        assertTrue(reveal.verifyRevealWithSnark(pi, zkproof), "fixture must verify untampered");

        uint256 i = bound(idx, 0, 7);
        uint256 d = bound(delta, 1, FR - 1); // nonzero mutation within the field
        zkproof[i] = addmod(zkproof[i], d, FR);

        // verifyRevealWithSnark returns false (does NOT revert) on a bad Groth16 proof.
        assertFalse(
            reveal.verifyRevealWithSnark(pi, zkproof),
            "tampered reveal snark must be rejected (false)"
        );
    }
}

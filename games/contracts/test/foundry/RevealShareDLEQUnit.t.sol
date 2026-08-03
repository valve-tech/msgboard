// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RevealShareDLEQ} from "../../contracts/zk/lib/RevealShareDLEQ.sol";
import {EllipticCurve} from "../../contracts/zk/lib/EllipticCurve.sol";

/// @notice Negative/edge-case coverage for RevealShareDLEQ.verify + the EllipticCurve library
/// it sits on. RevealShareDLEQ.t.sol proves cross-implementation parity against a REAL
/// off-chain proof (the honest path + a handful of tamper checks); this file's job is
/// different: drive every guard clause and EC-arithmetic edge in both contracts to its
/// `false`/revert outcome so a malformed or forged proof can never be mistaken for a valid
/// one, and so the underlying curve math is exercised well beyond what a single honest
/// witness happens to touch.
///
/// Everything here is built with plain scalar multiples of the generator (`k·G` for small
/// known `k`), NOT the off-chain prover — no ffi needed, so this runs in the default profile.
contract RevealShareDLEQUnitTest is Test {
    using RevealShareDLEQ for RevealShareDLEQ.Statement;

    // Same context string as RevealShareDLEQ.t.sol (tableId=7, slot=4) — only used as an
    // opaque domain-separation string here, its content doesn't matter for these vectors.
    string internal constant CTX =
        "holdem/0x0000000000000000000000000000000000000000000000000000000000000007/slot/4";

    // A fully self-consistent, honestly-generated statement built from small known scalars
    // (pk = G·1, c1 = G·2, d = c1·1 = G·2, t1 = G·w, t2 = c1·w, z = w + e·sk), so every
    // "tamper one field" test below starts from something that verifies `true` and flips
    // exactly one thing to `false`.
    uint256 internal constant SK = 1;
    uint256 internal constant W = 9;

    function _honestStmt() internal pure returns (RevealShareDLEQ.Statement memory s) {
        (s.pkX, s.pkY) = EllipticCurve.ecMul(SK, EllipticCurve.GX, EllipticCurve.GY);
        (s.c1X, s.c1Y) = EllipticCurve.ecMul(2, EllipticCurve.GX, EllipticCurve.GY);
        (s.c2X, s.c2Y) = EllipticCurve.ecMul(3, EllipticCurve.GX, EllipticCurve.GY);
        // d = c1·sk
        (s.dX, s.dY) = EllipticCurve.ecMul(SK, s.c1X, s.c1Y);
        (s.t1X, s.t1Y) = EllipticCurve.ecMul(W, EllipticCurve.GX, EllipticCurve.GY);
        (s.t2X, s.t2Y) = EllipticCurve.ecMul(W, s.c1X, s.c1Y);
        uint256 e = s.challenge(CTX);
        s.z = addmod(W, mulmod(e, SK, EllipticCurve.NN), EllipticCurve.NN);
    }

    /// Sanity: the hand-built statement above is honest and verifies, so every negative test
    /// below is a genuine one-field flip away from a passing proof (not a proof that was
    /// already broken for some unrelated reason).
    function test_handBuiltStatementVerifies() public pure {
        assertTrue(_honestStmt().verify(CTX), "hand-built honest statement verifies");
    }

    // ---------------------------------------------------------------------------------
    // identity / zero-point inputs — (0,0) is the library's infinity sentinel and must
    // never be accepted as any of the six statement points.
    // ---------------------------------------------------------------------------------

    function test_rejectsZeroPk() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.pkX = 0; s.pkY = 0;
        assertFalse(s.verify(CTX), "zero pk rejected");
    }

    function test_rejectsZeroC1() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.c1X = 0; s.c1Y = 0;
        assertFalse(s.verify(CTX), "zero c1 rejected");
    }

    function test_rejectsZeroC2() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.c2X = 0; s.c2Y = 0;
        assertFalse(s.verify(CTX), "zero c2 rejected");
    }

    function test_rejectsZeroD() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.dX = 0; s.dY = 0;
        assertFalse(s.verify(CTX), "zero d rejected");
    }

    function test_rejectsZeroT1() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.t1X = 0; s.t1Y = 0;
        assertFalse(s.verify(CTX), "zero t1 rejected");
    }

    function test_rejectsZeroT2() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.t2X = 0; s.t2Y = 0;
        assertFalse(s.verify(CTX), "zero t2 rejected");
    }

    // ---------------------------------------------------------------------------------
    // point-not-on-curve inputs — each of the six isOnCurve guards, hit independently by
    // corrupting the Y coordinate of one point at a time so it no longer satisfies
    // y^2 = x^3 + 7 (but is not the (0,0) sentinel either).
    // ---------------------------------------------------------------------------------

    function test_rejectsOffCurvePk() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.pkY ^= 1;
        assertFalse(s.verify(CTX), "off-curve pk rejected");
    }

    function test_rejectsOffCurveC1() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.c1Y ^= 1;
        assertFalse(s.verify(CTX), "off-curve c1 rejected");
    }

    function test_rejectsOffCurveC2() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.c2Y ^= 1;
        assertFalse(s.verify(CTX), "off-curve c2 rejected");
    }

    function test_rejectsOffCurveD() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.dY ^= 1;
        assertFalse(s.verify(CTX), "off-curve d rejected");
    }

    function test_rejectsOffCurveT1() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.t1Y ^= 1;
        assertFalse(s.verify(CTX), "off-curve t1 rejected");
    }

    function test_rejectsOffCurveT2() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.t2Y ^= 1;
        assertFalse(s.verify(CTX), "off-curve t2 rejected");
    }

    // ---------------------------------------------------------------------------------
    // out-of-field coordinates — isOnCurve's range guard (`x >= PP || y >= PP`) is a
    // distinct branch from the curve-equation check above; hit both sides of the OR.
    // ---------------------------------------------------------------------------------

    function test_rejectsCoordinateXAtFieldPrime() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.pkX = EllipticCurve.PP; // x >= PP
        assertFalse(s.verify(CTX), "x==PP rejected");
    }

    function test_rejectsCoordinateYAtFieldPrime() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.pkY = EllipticCurve.PP; // y >= PP
        assertFalse(s.verify(CTX), "y==PP rejected");
    }

    // ---------------------------------------------------------------------------------
    // wrong-response scalar z — the `z >= NN` guard, plus a garden-variety forged z that
    // stays in range but no longer satisfies eq (1).
    // ---------------------------------------------------------------------------------

    function test_rejectsZEqualToGroupOrder() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.z = EllipticCurve.NN; // z >= NN, out of range
        assertFalse(s.verify(CTX), "z==NN rejected");
    }

    function test_rejectsZAboveGroupOrder() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.z = EllipticCurve.NN + 12345;
        assertFalse(s.verify(CTX), "z>NN rejected");
    }

    function test_rejectsInRangeButWrongZ() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        s.z = addmod(s.z, 1, EllipticCurve.NN); // still < NN, but no longer w + e*sk
        assertFalse(s.verify(CTX), "wrong in-range z rejected");
    }

    // ---------------------------------------------------------------------------------
    // wrong challenge — swapping in another valid on-curve point for a field that feeds
    // the Fiat-Shamir hash changes `e`, which must invalidate the proof even though every
    // point involved is individually well-formed.
    // ---------------------------------------------------------------------------------

    function test_rejectsWrongPkOnCurve() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        (s.pkX, s.pkY) = EllipticCurve.ecMul(7, EllipticCurve.GX, EllipticCurve.GY);
        assertFalse(s.verify(CTX), "swapped-in valid pk rejected");
    }

    function test_rejectsWrongC1OnCurve() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        (s.c1X, s.c1Y) = EllipticCurve.ecMul(13, EllipticCurve.GX, EllipticCurve.GY);
        assertFalse(s.verify(CTX), "swapped-in valid c1 rejected");
    }

    /// c2 never appears in eq (1)/(2) directly — it's challenge-bound only — but tampering
    /// it must still break verification, proving there's no "unauthenticated" field.
    function test_rejectsWrongC2OnCurve_challengeBoundOnly() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        (s.c2X, s.c2Y) = EllipticCurve.ecMul(5, EllipticCurve.GX, EllipticCurve.GY);
        assertFalse(s.verify(CTX), "swapped-in valid c2 rejected");
    }

    function test_rejectsWrongDOnCurve() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        (s.dX, s.dY) = EllipticCurve.ecMul(17, EllipticCurve.GX, EllipticCurve.GY);
        assertFalse(s.verify(CTX), "swapped-in valid d rejected");
    }

    function test_rejectsWrongT1OnCurve() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        (s.t1X, s.t1Y) = EllipticCurve.ecMul(19, EllipticCurve.GX, EllipticCurve.GY);
        assertFalse(s.verify(CTX), "swapped-in valid t1 rejected");
    }

    function test_rejectsWrongT2OnCurve() public pure {
        RevealShareDLEQ.Statement memory s = _honestStmt();
        (s.t2X, s.t2Y) = EllipticCurve.ecMul(23, EllipticCurve.GX, EllipticCurve.GY);
        assertFalse(s.verify(CTX), "swapped-in valid t2 rejected");
    }

    /// Constructs a statement where eq (1) holds by algebraic design (pk = G·1, t1 = G·1,
    /// so z = 1+e satisfies G·z == t1 + pk·e for ANY e) while eq (2) is left to an arbitrary
    /// c1/d/t2 unrelated to that z/e — overwhelmingly certain to fail. This is the only way
    /// to reach the final `return (lx == rx && ly == ry)` line's `false` outcome: because
    /// every point is hashed into `e`, eq (1) and eq (2) cannot be independently satisfied by
    /// a real proof, so this is a hand-crafted (non-prover) statement exercising the branch a
    /// real forger could never produce, not a soundness gap.
    function test_eq1HoldsEq2Fails_hitsFinalReturnFalseBranch() public pure {
        RevealShareDLEQ.Statement memory s;
        s.pkX = EllipticCurve.GX; s.pkY = EllipticCurve.GY; // "sk" = 1
        (s.c1X, s.c1Y) = EllipticCurve.ecMul(2, EllipticCurve.GX, EllipticCurve.GY);
        (s.c2X, s.c2Y) = EllipticCurve.ecMul(3, EllipticCurve.GX, EllipticCurve.GY);
        (s.dX, s.dY) = EllipticCurve.ecMul(4, EllipticCurve.GX, EllipticCurve.GY);
        s.t1X = EllipticCurve.GX; s.t1Y = EllipticCurve.GY; // "w" = 1
        (s.t2X, s.t2Y) = EllipticCurve.ecMul(5, EllipticCurve.GX, EllipticCurve.GY);

        uint256 e = s.challenge(CTX);
        // z = w + e*sk = 1 + e*1, so G*z == t1 + pk*e == G*(1+e) by construction: eq (1) holds.
        s.z = addmod(1, e, EllipticCurve.NN);

        assertFalse(s.verify(CTX), "eq(1) holding alone must not pass verify");
    }

    // ---------------------------------------------------------------------------------
    // EllipticCurve.sol — direct coverage of isOnCurve/ecMul/ecAdd/invMod edges that the
    // DLEQ-level tests above don't reach (verify()'s on-curve gate means a raw y=0 point,
    // for instance, never reaches ecMul through RevealShareDLEQ at all).
    // ---------------------------------------------------------------------------------

    function test_isOnCurve_zeroIsNotOnCurve() public pure {
        assertFalse(EllipticCurve.isOnCurve(0, 0), "(0,0) sentinel is not on-curve");
    }

    function test_isOnCurve_generatorIsOnCurve() public pure {
        assertTrue(EllipticCurve.isOnCurve(EllipticCurve.GX, EllipticCurve.GY), "G is on-curve");
    }

    function test_isOnCurve_xAtFieldPrimeRejected() public pure {
        assertFalse(EllipticCurve.isOnCurve(EllipticCurve.PP, 1), "x>=PP rejected");
    }

    function test_isOnCurve_yAtFieldPrimeRejected() public pure {
        assertFalse(EllipticCurve.isOnCurve(1, EllipticCurve.PP), "y>=PP rejected");
    }

    function test_isOnCurve_genericOffCurvePointRejected() public pure {
        assertFalse(EllipticCurve.isOnCurve(1, 1), "(1,1) does not satisfy y^2=x^3+7");
    }

    function test_ecMul_zeroScalarIsInfinity() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecMul(0, EllipticCurve.GX, EllipticCurve.GY);
        assertEq(x, 0, "0*G .x"); assertEq(y, 0, "0*G .y");
    }

    function test_ecMul_infinityInputIsInfinity() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecMul(5, 0, 0);
        assertEq(x, 0, "k*inf .x"); assertEq(y, 0, "k*inf .y");
    }

    function test_ecMul_scalarOneReturnsSamePoint() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecMul(1, EllipticCurve.GX, EllipticCurve.GY);
        assertEq(x, EllipticCurve.GX, "1*G .x"); assertEq(y, EllipticCurve.GY, "1*G .y");
    }

    function test_ecMul_scalarEqualsGroupOrderWraps() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecMul(EllipticCurve.NN, EllipticCurve.GX, EllipticCurve.GY);
        assertEq(x, 0, "NN*G .x"); assertEq(y, 0, "NN*G .y"); // NN mod NN == 0
    }

    function test_ecMul_scalarAboveGroupOrderWraps() public pure {
        (uint256 x, uint256 y) =
            EllipticCurve.ecMul(EllipticCurve.NN + 1, EllipticCurve.GX, EllipticCurve.GY);
        assertEq(x, EllipticCurve.GX, "(NN+1)*G .x"); // (NN+1) mod NN == 1
        assertEq(y, EllipticCurve.GY, "(NN+1)*G .y");
    }

    /// ecMul does not itself validate on-curve-ness (that's the caller's job via isOnCurve);
    /// fed a degenerate y=0 "point", the Jacobian doubler's `Y1 == 0` infinity short-circuit
    /// (unreachable via any genuine on-curve secp256k1 point, since the group has prime order
    /// and thus no non-identity 2-torsion) fires on the very first doubling and the whole
    /// computation collapses to infinity without reverting.
    function test_ecMul_degenerateYZeroInputCollapsesToInfinity() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecMul(2, EllipticCurve.GX, 0);
        assertEq(x, 0, "degenerate .x"); assertEq(y, 0, "degenerate .y");
    }

    /// k=3 against a y=0 degenerate "point": Y=0 forces `_jDouble`'s `Y1 == 0` infinity
    /// short-circuit on the very first doubling. With k's bit 0 AND bit 1 both set, the
    /// accumulator first picks up the still-valid (Z=1) base on iteration 0, before it
    /// decays; then on iteration 1 it adds the now Jacobian-infinity (Z=0) base to that
    /// nonzero-Z accumulator. That is the one path through `_jAdd`'s
    /// `if (Z2 == 0) return (X1, Y1, Z1);` — distinct from the `Z1 == 0` branch above,
    /// and one RevealShareDLEQ's on-curve gate can never reach through `ecAdd`/`verify`:
    /// a genuinely on-curve point is never Jacobian-infinity mid-computation, since
    /// secp256k1 has prime order and thus no non-identity 2-torsion point to trigger it.
    function test_ecMul_degenerateYZeroInput_k3_hitsJacobianZ2ZeroBranch() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecMul(3, EllipticCurve.GX, 0);
        assertEq(x, EllipticCurve.GX, "degenerate k=3 .x");
        assertEq(y, 0, "degenerate k=3 .y");
    }

    function test_ecAdd_leftIdentity() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecAdd(0, 0, EllipticCurve.GX, EllipticCurve.GY);
        assertEq(x, EllipticCurve.GX, "0+G .x"); assertEq(y, EllipticCurve.GY, "0+G .y");
    }

    function test_ecAdd_rightIdentity() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecAdd(EllipticCurve.GX, EllipticCurve.GY, 0, 0);
        assertEq(x, EllipticCurve.GX, "G+0 .x"); assertEq(y, EllipticCurve.GY, "G+0 .y");
    }

    /// The general (non-double, non-inverse) Jacobian addition formula: two distinct,
    /// unrelated points, checked against ecMul's independent double-and-add computation.
    function test_ecAdd_distinctPointsMatchesScalarMul() public pure {
        (uint256 gx2, uint256 gy2) = EllipticCurve.ecMul(2, EllipticCurve.GX, EllipticCurve.GY);
        (uint256 ax, uint256 ay) = EllipticCurve.ecAdd(EllipticCurve.GX, EllipticCurve.GY, gx2, gy2);
        (uint256 mx, uint256 my) = EllipticCurve.ecMul(3, EllipticCurve.GX, EllipticCurve.GY);
        assertEq(ax, mx, "G+2G .x == 3G .x"); assertEq(ay, my, "G+2G .y == 3G .y");
    }

    /// P + (-P) == infinity: same X (U1 == U2) but differing Y (S1 != S2) — the
    /// point-cancellation branch of the Jacobian addition formula.
    function test_ecAdd_pointPlusNegationIsInfinity() public pure {
        (uint256 x, uint256 y) = EllipticCurve.ecAdd(
            EllipticCurve.GX, EllipticCurve.GY,
            EllipticCurve.GX, EllipticCurve.PP - EllipticCurve.GY
        );
        assertEq(x, 0, "G + (-G) .x"); assertEq(y, 0, "G + (-G) .y");
    }

    function test_invMod_roundTrip() public pure {
        uint256 inv2 = EllipticCurve.invMod(2, EllipticCurve.PP);
        assertEq(mulmod(2, inv2, EllipticCurve.PP), 1, "2 * inv(2) == 1 mod PP");
    }

    function test_invMod_identity() public pure {
        assertEq(EllipticCurve.invMod(1, EllipticCurve.PP), 1, "inv(1) == 1");
    }

    // invMod's `require(x != 0 && x != p && p != 0, "invMod:in")` guards are unreachable
    // from any of RevealShareDLEQ's real call paths (Z is never literally 0/p there), so
    // they're exercised directly here via an external wrapper (needed for vm.expectRevert,
    // which asserts on the NEXT call — invMod is an inlined internal library call, not one).
    function invModCall(uint256 x, uint256 p) external pure returns (uint256) {
        return EllipticCurve.invMod(x, p);
    }

    function test_invMod_revertsOnZeroX() public {
        vm.expectRevert(bytes("invMod:in"));
        this.invModCall(0, EllipticCurve.PP);
    }

    function test_invMod_revertsOnXEqualsP() public {
        vm.expectRevert(bytes("invMod:in"));
        this.invModCall(EllipticCurve.PP, EllipticCurve.PP);
    }

    function test_invMod_revertsOnZeroP() public {
        vm.expectRevert(bytes("invMod:in"));
        this.invModCall(5, 0);
    }
}

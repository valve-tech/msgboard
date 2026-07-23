// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title secp256k1 elliptic-curve arithmetic (Jacobian) for on-chain DLEQ verification.
/// @notice Minimal, self-contained point arithmetic over secp256k1 (a=0, b=7) — the SAME
/// curve the off-chain `zk-cards-core` deck crypto uses (noble-curves secp256k1). This
/// is what makes a contested decryption-share answerable on-chain WITHOUT re-homing the deck
/// onto Baby JubJub: the vendored uzkge ChaumPedersenDL verifier is EdOnBN254 (wrong curve
/// for our secp256k1 shares), so the share-dispute path needs curve-matched point ops.
///
/// Math adapted from the well-known Witnet `elliptic-curve-solidity` library (MIT). The point
/// at infinity is represented as the affine pair (0, 0). Scalar mult is constant-shape
/// double-and-add over the 256 bits of the (mod-n reduced) scalar. This is the COLD dispute
/// path — correctness over gas — but Jacobian coordinates keep it to a single field inversion
/// per scalar-mult (vs. one per step in affine), so a full DLEQ verify stays ~1–2M gas, well
/// under the ~15.6M the spec rejected for the vendored EdOnBN254 CP-DL path.
library EllipticCurve {
    // secp256k1 field prime p
    uint256 internal constant PP = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f;
    // secp256k1 group order n
    uint256 internal constant NN = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    // generator G
    uint256 internal constant GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 internal constant GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;
    // curve b (a is 0)
    uint256 internal constant BB = 7;

    /// @dev Modular inverse of `x` mod `p` via the binary extended Euclid (pure, no precompile).
    function invMod(uint256 x, uint256 p) internal pure returns (uint256) {
        require(x != 0 && x != p && p != 0, "invMod:in");
        uint256 q;
        uint256 newT = 1;
        uint256 r = p;
        uint256 t;
        while (x != 0) {
            t = r / x;
            (q, newT) = (newT, addmod(q, (p - mulmod(t, newT, p)), p));
            (r, x) = (x, r - t * x);
        }
        return q;
    }

    /// @dev y^2 == x^3 + 7 (mod p), with both coordinates in the field. (0,0) is NOT on-curve
    /// (it is our infinity sentinel) — callers reject it for required points.
    function isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x == 0 && y == 0) return false;
        if (x >= PP || y >= PP) return false;
        uint256 lhs = mulmod(y, y, PP);
        uint256 rhs = addmod(mulmod(mulmod(x, x, PP), x, PP), BB, PP);
        return lhs == rhs;
    }

    function _isInf(uint256 x, uint256 y) private pure returns (bool) {
        return x == 0 && y == 0;
    }

    /// @dev Jacobian → affine.
    function _toAffine(uint256 X, uint256 Y, uint256 Z) private pure returns (uint256 x, uint256 y) {
        if (Z == 0) return (0, 0);
        uint256 zInv = invMod(Z, PP);
        uint256 zInv2 = mulmod(zInv, zInv, PP);
        x = mulmod(X, zInv2, PP);
        y = mulmod(mulmod(Y, zInv2, PP), zInv, PP);
    }

    /// @dev Jacobian point doubling (a = 0).
    function _jDouble(uint256 X1, uint256 Y1, uint256 Z1)
        private
        pure
        returns (uint256 X3, uint256 Y3, uint256 Z3)
    {
        if (Y1 == 0) return (0, 0, 0);
        uint256 A = mulmod(X1, X1, PP);
        uint256 B = mulmod(Y1, Y1, PP);
        uint256 C = mulmod(B, B, PP);
        // D = 2*((X1+B)^2 - A - C)
        uint256 s = addmod(X1, B, PP);
        uint256 D = mulmod(s, s, PP);
        D = addmod(D, PP - A, PP);
        D = addmod(D, PP - C, PP);
        D = mulmod(2, D, PP);
        // E = 3*A ; F = E^2
        uint256 E = mulmod(3, A, PP);
        uint256 F = mulmod(E, E, PP);
        // X3 = F - 2D
        X3 = addmod(F, PP - mulmod(2, D, PP), PP);
        // Y3 = E*(D - X3) - 8C
        Y3 = mulmod(E, addmod(D, PP - X3, PP), PP);
        Y3 = addmod(Y3, PP - mulmod(8, C, PP), PP);
        // Z3 = 2*Y1*Z1
        Z3 = mulmod(mulmod(2, Y1, PP), Z1, PP);
    }

    /// @dev Jacobian point addition.
    function _jAdd(
        uint256 X1, uint256 Y1, uint256 Z1,
        uint256 X2, uint256 Y2, uint256 Z2
    ) private pure returns (uint256 X3, uint256 Y3, uint256 Z3) {
        if (Z1 == 0) return (X2, Y2, Z2);
        if (Z2 == 0) return (X1, Y1, Z1);
        uint256 Z1Z1 = mulmod(Z1, Z1, PP);
        uint256 Z2Z2 = mulmod(Z2, Z2, PP);
        uint256 U1 = mulmod(X1, Z2Z2, PP);
        uint256 U2 = mulmod(X2, Z1Z1, PP);
        uint256 S1 = mulmod(mulmod(Y1, Z2, PP), Z2Z2, PP);
        uint256 S2 = mulmod(mulmod(Y2, Z1, PP), Z1Z1, PP);
        if (U1 == U2) {
            if (S1 != S2) return (0, 0, 0); // P + (-P) = infinity
            return _jDouble(X1, Y1, Z1); // P == Q
        }
        uint256 H = addmod(U2, PP - U1, PP);
        uint256 I = mulmod(mulmod(2, H, PP), mulmod(2, H, PP), PP);
        uint256 J = mulmod(H, I, PP);
        uint256 r = mulmod(2, addmod(S2, PP - S1, PP), PP);
        uint256 V = mulmod(U1, I, PP);
        // X3 = r^2 - J - 2V
        X3 = addmod(mulmod(r, r, PP), PP - J, PP);
        X3 = addmod(X3, PP - mulmod(2, V, PP), PP);
        // Y3 = r*(V - X3) - 2*S1*J
        Y3 = mulmod(r, addmod(V, PP - X3, PP), PP);
        Y3 = addmod(Y3, PP - mulmod(mulmod(2, S1, PP), J, PP), PP);
        // Z3 = ((Z1+Z2)^2 - Z1Z1 - Z2Z2) * H
        uint256 zz = addmod(Z1, Z2, PP);
        zz = mulmod(zz, zz, PP);
        zz = addmod(zz, PP - Z1Z1, PP);
        zz = addmod(zz, PP - Z2Z2, PP);
        Z3 = mulmod(zz, H, PP);
    }

    /// @notice Affine point addition. Infinity is (0,0).
    function ecAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal
        pure
        returns (uint256 x3, uint256 y3)
    {
        if (_isInf(x1, y1)) return (x2, y2);
        if (_isInf(x2, y2)) return (x1, y1);
        (uint256 X3, uint256 Y3, uint256 Z3) = _jAdd(x1, y1, 1, x2, y2, 1);
        return _toAffine(X3, Y3, Z3);
    }

    /// @notice Affine scalar multiplication k·(x,y). k is reduced mod n; k==0 or infinity → (0,0).
    function ecMul(uint256 k, uint256 x, uint256 y) internal pure returns (uint256, uint256) {
        k %= NN;
        if (k == 0 || _isInf(x, y)) return (0, 0);
        if (k == 1) return (x, y);
        uint256 X = 0;
        uint256 Y = 0;
        uint256 Z = 0; // accumulator = infinity
        uint256 bx = x;
        uint256 by = y;
        uint256 bz = 1;
        while (k != 0) {
            if (k & 1 == 1) {
                (X, Y, Z) = _jAdd(X, Y, Z, bx, by, bz);
            }
            (bx, by, bz) = _jDouble(bx, by, bz);
            k >>= 1;
        }
        return _toAffine(X, Y, Z);
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EllipticCurve} from "./EllipticCurve.sol";

/// @title On-chain verifier for a decryption-share's Chaum–Pedersen DLEQ proof (secp256k1).
/// @notice EXACT on-chain mirror of `examples/games/zk-core/src/chaumPedersen.ts`
/// (`proveShare`/`verifyShare`). A correct decryption share is precisely the DLEQ statement:
///
///   the share  d = c1·sk   AND   the responder's public key  pk = G·sk   (SAME secret sk)
///
/// i.e. `log_G(pk) == log_{c1}(d)`. The off-chain prover emits `{t1, t2, z}` with
///   t1 = G·w,  t2 = c1·w,  z = w + e·sk,  e = H(pk‖c1‖c2‖d‖t1‖t2‖ctx) mod n
/// and the verifier checks the two DLEQ equations
///   G·z  == t1 + pk·e        (1)
///   c1·z == t2 + d·e         (2)
///
/// The Fiat–Shamir challenge `e` is recomputed here byte-for-byte against the TS encoding
/// (33-byte COMPRESSED points, ASCII domain tag, keccak of the ctx string) so a proof can be
/// neither replayed across slots/tables nor forged by choosing `e`. The ctx is reconstructed
/// on-chain from (tableId, slot) by the caller, binding the proof to THIS contested slot.
library RevealShareDLEQ {
    /// The full DLEQ statement + proof, as affine secp256k1 coordinates and the scalar z.
    struct Statement {
        uint256 pkX;  uint256 pkY;   // responder deck pubkey  pk = G·sk
        uint256 c1X;  uint256 c1Y;   // contested card ElGamal c1
        uint256 c2X;  uint256 c2Y;   // contested card ElGamal c2 (challenge-bound only)
        uint256 dX;   uint256 dY;    // claimed share  d = c1·sk
        uint256 t1X;  uint256 t1Y;   // proof nonce commitment G·w
        uint256 t2X;  uint256 t2Y;   // proof nonce commitment c1·w
        uint256 z;                   // proof response  w + e·sk
    }

    // ASCII domain tag — `stringToHex('zk-cards/chaum-pedersen/v1')` in chaumPedersen.ts.
    bytes internal constant TAG = "zk-cards/chaum-pedersen/v1";

    /// @dev 33-byte compressed SEC1 encoding: 0x02|0x03 (y parity) ‖ 32-byte big-endian x.
    function _compress(uint256 x, uint256 y) private pure returns (bytes memory) {
        return abi.encodePacked(bytes1(uint8(2 + (y & 1))), bytes32(x));
    }

    /// @notice Recompute the Fiat–Shamir challenge `e = keccak(...) mod n` exactly as
    /// `chaumPedersen.ts#challenge`. `ctx` is the already-built replay-binding string.
    function challenge(Statement memory s, string memory ctx) internal pure returns (uint256) {
        bytes32 h = keccak256(
            abi.encodePacked(
                TAG,
                _compress(s.pkX, s.pkY),
                _compress(s.c1X, s.c1Y),
                _compress(s.c2X, s.c2Y),
                _compress(s.dX, s.dY),
                _compress(s.t1X, s.t1Y),
                _compress(s.t2X, s.t2Y),
                keccak256(bytes(ctx))
            )
        );
        return uint256(h) % EllipticCurve.NN;
    }

    /// @notice Verify the share DLEQ. Returns false (never reverts) on a malformed/forged
    /// proof so the caller can branch (resolve vs. revert). All six points must be on-curve
    /// and non-infinity; the two DLEQ equations must hold for the recomputed challenge.
    function verify(Statement memory s, string memory ctx) internal pure returns (bool) {
        // reject off-curve / infinity inputs (invalid-curve & identity edge cases)
        if (!EllipticCurve.isOnCurve(s.pkX, s.pkY)) return false;
        if (!EllipticCurve.isOnCurve(s.c1X, s.c1Y)) return false;
        if (!EllipticCurve.isOnCurve(s.c2X, s.c2Y)) return false;
        if (!EllipticCurve.isOnCurve(s.dX, s.dY)) return false;
        if (!EllipticCurve.isOnCurve(s.t1X, s.t1Y)) return false;
        if (!EllipticCurve.isOnCurve(s.t2X, s.t2Y)) return false;
        if (s.z >= EllipticCurve.NN) return false;

        uint256 e = challenge(s, ctx);

        // eq (1): G·z == t1 + pk·e
        (uint256 lx, uint256 ly) = EllipticCurve.ecMul(s.z, EllipticCurve.GX, EllipticCurve.GY);
        (uint256 ex, uint256 ey) = EllipticCurve.ecMul(e, s.pkX, s.pkY);
        (uint256 rx, uint256 ry) = EllipticCurve.ecAdd(s.t1X, s.t1Y, ex, ey);
        if (lx != rx || ly != ry) return false;

        // eq (2): c1·z == t2 + d·e
        (lx, ly) = EllipticCurve.ecMul(s.z, s.c1X, s.c1Y);
        (ex, ey) = EllipticCurve.ecMul(e, s.dX, s.dY);
        (rx, ry) = EllipticCurve.ecAdd(s.t2X, s.t2Y, ex, ey);
        return (lx == rx && ly == ry);
    }
}

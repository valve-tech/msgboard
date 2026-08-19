// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EllipticCurve} from "elliptic-curve-solidity/EllipticCurve.sol";

/// @title MsgPow — Solidity verification of the MsgBoard proof of work (msgpow).
/// @notice Mirrors msgboard/core. There is ONE message version — version 1. Two ALGORITHMS verify
/// it: the revised (canonical) scheme and the legacy (pre-revision) scheme. You select a scheme by
/// which function you call, NOT by the message version field. Both schemes carry version 1.
///
/// The revised scheme is canonical; call `verify`. The legacy scheme is a fallback the live 943
/// board still runs; call `verifyLegacy`.
///
/// Revised (canonical, `verify`):
///   payloadHash = sha256(category(32) || data)
///   scalarHash  = sha256(version(1) || blockHash(32) || payloadHash(32)
///                        || workMultiplier(8B BE) || workDivisor(8B BE) || nonce(8B BE))
///   scalar      = uint256(scalarHash). REJECT if scalar == 0 || scalar >= n (do NOT reduce).
///   (qx, qy)    = scalar * G
///   compressed  = (0x02 | (qy & 1))(1) || qx(32)   // SEC1 compressed point (33 bytes)
///   workHash    = sha256(compressed)
///   valid iff uint256(workHash) < floor(2^256 / difficulty)
///
/// Legacy (pre-revision fallback, `verifyLegacy`):
///   digest    = low 128 bits of sha256(workMultiplier(8B BE) || workDivisor(8B BE))
///   k         = (nonce * digest + uint256(blockHash)) mod n
///   X         = (k * G).x, encoded as a FIXED 32-byte big-endian value
///   workHash  = sha256(X(32) || category(32) || data)
///   valid iff uint256(workHash) % difficulty == 0
///   The x-coordinate MUST be a full 32 bytes. core's bn.js `toArray()` once dropped leading
///   zero bytes, so an x below 2^248 (about 1 nonce in 256) encoded to 31 bytes and the node
///   rejected it. `bytes32(uint256)` is zero-padded, so this encoding is always 32 bytes.
library MsgPow {
    // secp256k1 parameters
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;
    uint256 internal constant AA = 0;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant NN = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    struct Message {
        uint8 version;
        uint256 nonce;
        bytes32 blockHash;
        bytes32 category;
        bytes data;
        uint64 workMultiplier;
        uint64 workDivisor;
    }

    // ── Revised (canonical) ──────────────────────────────────────────────────────

    /// @dev Revised step 1: sha256(category(32) || data). Commits the message body.
    function payloadHash(Message memory m) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(m.category, m.data));
    }

    /// @dev Revised step 2: sha256 of the fixed-width transcript. nonce is the low 8 bytes,
    /// big-endian, matching core.numberToBytes(nonce, { size: 8 }).
    function scalarHash(Message memory m) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                m.version, // 1 byte
                m.blockHash, // 32 bytes
                payloadHash(m), // 32 bytes
                m.workMultiplier, // 8 bytes BE
                m.workDivisor, // 8 bytes BE
                uint64(m.nonce) // 8 bytes BE
            )
        );
    }

    /// @dev Revised work hash. Returns ok=false when the scalar is out of range [1, n-1] or the
    /// point is at infinity — the node REJECTS these rather than reducing.
    function workHash(Message memory m) internal pure returns (bool ok, bytes32 wh) {
        uint256 scalar = uint256(scalarHash(m));
        if (scalar == 0 || scalar >= NN) return (false, bytes32(0));
        (uint256 qx, uint256 qy) = EllipticCurve.ecMul(scalar, GX, GY, AA, PP);
        if (qx == 0 && qy == 0) return (false, bytes32(0)); // point at infinity
        // SEC1 compressed point: prefix is 0x02 for an even y, 0x03 for an odd y.
        // casting to 'uint8' is safe: `qy & 1` is 0 or 1, so it always fits in a byte.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes1 prefix = bytes1(0x02 | uint8(qy & 1));
        wh = sha256(abi.encodePacked(prefix, bytes32(qx)));
        ok = true;
    }

    /// @notice The revised acceptance target: a work hash is valid iff it is below floor(2^256 / d).
    /// @dev Computed without overflow. 2^256 = type(uint256).max + 1, so
    ///   floor(2^256 / d) = max/d + ((max % d + 1) >= d ? 1 : 0).
    /// Only meaningful for d >= 2. For d == 1 the true target is 2^256, which does not fit in a
    /// uint256; `verify` handles that case directly (every hash passes), so this reverts.
    function powTarget(uint256 d) internal pure returns (uint256) {
        require(d >= 2, "MsgPow: target overflow");
        uint256 max = type(uint256).max;
        uint256 q = max / d;
        if (max % d + 1 >= d) q += 1;
        return q;
    }

    /// @notice Canonical (revised) verification. valid iff the work hash is below floor(2^256 / difficulty).
    function verify(Message memory m, uint256 difficulty) internal pure returns (bool) {
        require(difficulty != 0, "MsgPow: zero difficulty");
        (bool ok, bytes32 wh) = workHash(m);
        if (!ok) return false;
        // difficulty == 1 → target == 2^256, so every 256-bit hash is below it.
        if (difficulty == 1) return true;
        return uint256(wh) < powTarget(difficulty);
    }

    // ── Legacy (pre-revision fallback) ───────────────────────────────────────────

    /// @dev low 128 bits of sha256(workMultiplier(8B BE) || workDivisor(8B BE)).
    function digest(uint64 workMultiplier, uint64 workDivisor) internal pure returns (uint256) {
        bytes32 h = sha256(abi.encodePacked(workMultiplier, workDivisor));
        return uint256(h) & type(uint128).max;
    }

    /// @dev k = (nonce*digest + blockHash) mod n, matching elliptic's reduction.
    function challengeX(Message memory m) internal pure returns (uint256 qx) {
        uint256 d = digest(m.workMultiplier, m.workDivisor);
        uint256 k = addmod(mulmod(m.nonce, d, NN), uint256(m.blockHash) % NN, NN);
        (qx,) = EllipticCurve.ecMul(k, GX, GY, AA, PP);
    }

    /// @dev Legacy work hash. The x-coordinate is a FIXED 32-byte big-endian value —
    /// `bytes32(uint256)` zero-pads, so it is always 32 bytes, matching core.getChallengeLegacy.
    function workHashLegacy(Message memory m) internal pure returns (bytes32) {
        bytes memory pre = abi.encodePacked(bytes32(challengeX(m)), m.category, m.data);
        return sha256(pre);
    }

    /// @notice Legacy (fallback) verification. valid iff uint256(workHashLegacy) % difficulty == 0.
    function verifyLegacy(Message memory m, uint256 difficulty) internal pure returns (bool) {
        require(difficulty != 0, "MsgPow: zero difficulty");
        return uint256(workHashLegacy(m)) % difficulty == 0;
    }
}

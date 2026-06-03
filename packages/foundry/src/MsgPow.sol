// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EllipticCurve} from "elliptic-curve-solidity/EllipticCurve.sol";

/// @title MsgPow — Solidity verification of the MsgBoard proof of work (msgpow).
/// @notice Mirrors @msgboard/core's checkWork:
///   digest    = low 128 bits of sha256(workMultiplier(8B BE) || workDivisor(8B BE))
///   k         = (nonce * digest + uint256(blockHash)) mod n
///   X         = (k * G).x, encoded as minimal big-endian bytes
///   workHash  = sha256(X || category || data)
///   valid iff uint256(workHash) % difficulty == 0
library MsgPow {
    // secp256k1 parameters
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;
    uint256 internal constant AA = 0;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant NN = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    struct Message {
        uint256 nonce;
        bytes32 blockHash;
        bytes32 category;
        bytes data;
        uint64 workMultiplier;
        uint64 workDivisor;
    }

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

    /// @dev minimal big-endian bytes (strip leading zero bytes) — matches BN.toArray().
    function minimalBytes(uint256 x) internal pure returns (bytes memory out) {
        if (x == 0) return new bytes(0);
        uint256 n = 0;
        uint256 t = x;
        while (t != 0) {
            n++;
            t >>= 8;
        }
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[n - 1 - i] = bytes1(uint8(x >> (8 * i)));
        }
    }

    function workHash(Message memory m) internal pure returns (bytes32) {
        bytes memory pre = abi.encodePacked(minimalBytes(challengeX(m)), m.category, m.data);
        return sha256(pre);
    }

    function verify(Message memory m, uint256 difficulty) internal pure returns (bool) {
        require(difficulty != 0, "MsgPow: zero difficulty");
        return uint256(workHash(m)) % difficulty == 0;
    }
}

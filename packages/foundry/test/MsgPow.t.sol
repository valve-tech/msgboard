// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgPow} from "../src/MsgPow.sol";

/// Golden-vector tests for MsgPow. The digests and work hashes below come from the node's Go golden
/// vector, so they prove this Solidity library is bit-identical to the node — not just self-consistent.
/// category = "chatter" (padded to 32 bytes), data = "golden vector".
contract MsgPowTest is Test {
    bytes32 constant CATEGORY = 0x6368617474657200000000000000000000000000000000000000000000000000;
    bytes32 constant BLOCK = 0x3a2ca760216c5cb648c32aab73cbc1cdfdbcf02f77a4cd190995e3c46f3932b5;
    bytes constant DATA = hex"676f6c64656e20766563746f72"; // "golden vector", 13 bytes

    function _vec(uint256 nonce, uint64 wm, uint64 wd) internal pure returns (MsgPow.Message memory m) {
        m.version = 1;
        m.nonce = nonce;
        m.blockHash = BLOCK;
        m.category = CATEGORY;
        m.data = DATA;
        m.workMultiplier = wm;
        m.workDivisor = wd;
    }

    /// Vector A: nonce 1, wm 10000, wd 1000000 → D 169072. Pins the transcript and work hash, and must
    /// NOT meet its difficulty.
    function test_golden_vector_A() public pure {
        MsgPow.Message memory m = _vec(1, 10000, 1000000);
        assertEq(
            MsgPow.payloadHash(m),
            0xb66106e111b0e6cd08a49c7a37afa3259541bee8e465bef5e55f6cd7223d789a,
            "payloadHash must match the node golden vector"
        );
        assertEq(
            MsgPow.scalarHash(m),
            0x3caed3ea9a5caa6e1e069d0126e4dc6698190aa3eec8ebcdab227d3e5b0fd18d,
            "scalarHash must match the node golden vector"
        );
        (bool ok, bytes32 wh) = MsgPow.workHash(m);
        assertTrue(ok, "scalar must be in range");
        assertEq(
            wh,
            0x5ba003ccdb08503a19326a201834198a49e062d2f3f0e9506ff086eddb011dee,
            "workHash must match the node golden vector"
        );
        assertFalse(MsgPow.verify(m, 169072), "vector A must not meet its difficulty");
    }

    /// Vector B: nonce 57602, wm 1, wd 1000 → D 16907. Verifies; the two neighbours do not.
    function test_golden_vector_B() public pure {
        MsgPow.Message memory m = _vec(57602, 1, 1000);
        assertEq(
            MsgPow.scalarHash(m),
            0xbcff3c0ddc5d02b05e282566461d4f30f35ce90b3bfd36cde0c694dcb54a5e7d,
            "scalarHash must match the node golden vector"
        );
        (bool ok, bytes32 wh) = MsgPow.workHash(m);
        assertTrue(ok, "scalar must be in range");
        assertEq(
            wh,
            0x00037212834e250723dc736508d445a0dbc01398040a980807641b4be2d1e361,
            "workHash must match the node golden vector"
        );
        assertTrue(MsgPow.verify(m, 16907), "vector B must verify");
        assertFalse(MsgPow.verify(_vec(57601, 1, 1000), 16907), "57601 must not verify");
        assertFalse(MsgPow.verify(_vec(57603, 1, 1000), 16907), "57603 must not verify");
    }

    function test_rejects_tampered_nonce() public pure {
        MsgPow.Message memory m = _vec(57602, 1, 1000);
        m.nonce += 1;
        assertFalse(MsgPow.verify(m, 16907), "tampered nonce must not verify");
    }

    /// powTarget matches core: 2^256 / 256 == 2^248.
    function test_powTarget() public pure {
        assertEq(MsgPow.powTarget(256), 2 ** 248, "powTarget(256) == 2^248");
    }
}

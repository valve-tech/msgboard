// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {
    SessionState,
    SessionStateLib,
    SessionClose,
    SessionCloseLib
} from "../../contracts/games/SessionState.sol";
import {SessionStateHarness} from "../../contracts/test/SessionStateHarness.sol";

/// Exercises the CALLDATA overloads of SessionStateLib.structHash / SessionCloseLib.structHash
/// directly. HouseChannel calls these calldata variants (never the memory ones) in
/// open()/_checkCoSigned()/_checkCloseCoSigned() — see contracts/games/HouseChannel.sol lines
/// 183, 438, 450. SessionStateHarness only wraps the MEMORY path (stateDigest/closeDigest), so
/// without this wrapper the calldata overloads would have zero coverage.
contract CalldataHashCaller {
    using SessionStateLib for SessionState;
    using SessionCloseLib for SessionClose;

    function stateStructHash(SessionState calldata s) external pure returns (bytes32) {
        return s.structHash();
    }

    function closeStructHash(SessionClose calldata c) external pure returns (bytes32) {
        return c.structHash();
    }
}

/// COVERAGE ONLY — no contract changes. Unit-tests contracts/games/SessionState.sol (the
/// SessionState/SessionClose structs + SessionStateLib/SessionCloseLib/SessionStateEIP712
/// library code embedded in the LIVE HouseChannel) beyond the 2 digest-parity tests in
/// SessionStateDigest.t.sol. Covers: structHash (calldata) <-> structHashMem (memory) parity
/// for BOTH struct types, TYPEHASH values, stateDigest/closeDigest determinism + full per-field
/// sensitivity (including tableId, absent from the original suite), the two EIP-712 types never
/// colliding, wrong-domain rejection (verifyingContract + chainId binding), and end-to-end
/// EIP-712 signature verify/recover using solady's ECDSA — exactly how HouseChannel consumes
/// these digests — including the known high-s signature-malleability property.
contract SessionStateUnitTest is Test {
    // secp256k1 curve order — used to construct the high-s malleable counterpart of a signature.
    uint256 private constant _SECP256K1_N =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    SessionStateHarness internal h;
    SessionStateHarness internal h2; // second deployment: distinct verifyingContract address
    CalldataHashCaller internal cc;

    function setUp() public {
        h = new SessionStateHarness();
        h2 = new SessionStateHarness();
        cc = new CalldataHashCaller();
    }

    // ---------------------------------------------------------------------
    // fixtures
    // ---------------------------------------------------------------------

    function _state() internal pure returns (SessionState memory s) {
        s.tableId = keccak256("table");
        s.nonce = 7;
        s.balancePlayer = 1500;
        s.balanceHouse = 500;
        s.settlementMode = 1;
        s.gameId = 2;
        s.gameStateHash = keccak256("gs");
        s.rngCommit = keccak256("commit");
    }

    function _close() internal pure returns (SessionClose memory c) {
        c.tableId = keccak256("table");
        c.nonce = 7;
        c.balancePlayer = 1500;
        c.balanceHouse = 500;
        c.gameId = 2;
    }

    // ---------------------------------------------------------------------
    // structHash: calldata <-> memory parity (both struct types)
    // ---------------------------------------------------------------------

    function test_stateStructHash_calldataMatchesMemory() public view {
        SessionState memory s = _state();
        bytes32 memHash = SessionStateLib.structHashMem(s);
        bytes32 cdHash = cc.stateStructHash(s);
        assertEq(memHash, cdHash);
    }

    function test_closeStructHash_calldataMatchesMemory() public view {
        SessionClose memory c = _close();
        bytes32 memHash = SessionCloseLib.structHashMem(c);
        bytes32 cdHash = cc.closeStructHash(c);
        assertEq(memHash, cdHash);
    }

    // ---------------------------------------------------------------------
    // TYPEHASH sanity — the on-chain constant must match the off-chain EIP-712 type string
    // exactly (field order is consensus per the header comments in SessionState.sol).
    // ---------------------------------------------------------------------

    function test_stateTypehash_matchesSpec() public pure {
        assertEq(
            SessionStateLib.TYPEHASH,
            keccak256(
                "SessionState(bytes32 tableId,uint64 nonce,uint256 balancePlayer,uint256 balanceHouse,uint8 settlementMode,uint8 gameId,bytes32 gameStateHash,bytes32 rngCommit)"
            )
        );
    }

    function test_closeTypehash_matchesSpec() public pure {
        assertEq(
            SessionCloseLib.TYPEHASH,
            keccak256(
                "SessionClose(bytes32 tableId,uint64 nonce,uint256 balancePlayer,uint256 balanceHouse,uint8 gameId)"
            )
        );
    }

    // ---------------------------------------------------------------------
    // stateDigest: determinism + full per-field sensitivity (adds tableId, not covered by the
    // original SessionStateDigest.t.sol suite)
    // ---------------------------------------------------------------------

    function test_stateDigest_deterministic() public view {
        assertEq(h.stateDigest(_state()), h.stateDigest(_state()));
    }

    function test_stateDigest_sensitiveToEveryField() public view {
        bytes32 d = h.stateDigest(_state());
        SessionState memory s;

        s = _state();
        s.tableId = keccak256("other-table");
        assertTrue(h.stateDigest(s) != d);
        s = _state();
        s.nonce = 8;
        assertTrue(h.stateDigest(s) != d);
        s = _state();
        s.balancePlayer = 1499;
        assertTrue(h.stateDigest(s) != d);
        s = _state();
        s.balanceHouse = 501;
        assertTrue(h.stateDigest(s) != d);
        s = _state();
        s.settlementMode = 0;
        assertTrue(h.stateDigest(s) != d);
        s = _state();
        s.gameId = 1;
        assertTrue(h.stateDigest(s) != d);
        s = _state();
        s.gameStateHash = keccak256("gs2");
        assertTrue(h.stateDigest(s) != d);
        s = _state();
        s.rngCommit = keccak256("commit2");
        assertTrue(h.stateDigest(s) != d);
    }

    // ---------------------------------------------------------------------
    // closeDigest: determinism + full per-field sensitivity (SessionClose has no dedicated
    // digest test anywhere else in the suite)
    // ---------------------------------------------------------------------

    function test_closeDigest_deterministic() public view {
        assertEq(h.closeDigest(_close()), h.closeDigest(_close()));
    }

    function test_closeDigest_sensitiveToEveryField() public view {
        bytes32 d = h.closeDigest(_close());
        SessionClose memory c;

        c = _close();
        c.tableId = keccak256("other-table");
        assertTrue(h.closeDigest(c) != d);
        c = _close();
        c.nonce = 8;
        assertTrue(h.closeDigest(c) != d);
        c = _close();
        c.balancePlayer = 1499;
        assertTrue(h.closeDigest(c) != d);
        c = _close();
        c.balanceHouse = 501;
        assertTrue(h.closeDigest(c) != d);
        c = _close();
        c.gameId = 1;
        assertTrue(h.closeDigest(c) != d);
    }

    // ---------------------------------------------------------------------
    // The two EIP-712 types must never collide — this is the exact security invariant the
    // header comments in SessionState.sol describe: a running-play co-sign (SessionState) must
    // never be replayable as a mutual-close authorization (SessionClose), even for a struct
    // carrying identical tableId/nonce/balances/gameId values.
    // ---------------------------------------------------------------------

    function test_stateDigestAndCloseDigest_neverCollide() public view {
        SessionState memory s = _state();
        SessionClose memory c = _close(); // same tableId/nonce/balances/gameId as s
        assertTrue(h.stateDigest(s) != h.closeDigest(c));
    }

    // ---------------------------------------------------------------------
    // wrong-domain rejection: verifyingContract + chainId binding
    // ---------------------------------------------------------------------

    function test_stateDigest_differsAcrossVerifyingContracts() public view {
        SessionState memory s = _state();
        assertTrue(h.stateDigest(s) != h2.stateDigest(s));
    }

    function test_closeDigest_differsAcrossVerifyingContracts() public view {
        SessionClose memory c = _close();
        assertTrue(h.closeDigest(c) != h2.closeDigest(c));
    }

    function test_stateDigest_differsAcrossChainId() public {
        SessionState memory s = _state();
        bytes32 d1 = h.stateDigest(s);
        vm.chainId(block.chainid + 1);
        bytes32 d2 = h.stateDigest(s);
        assertTrue(d1 != d2);
    }

    function test_closeDigest_differsAcrossChainId() public {
        SessionClose memory c = _close();
        bytes32 d1 = h.closeDigest(c);
        vm.chainId(block.chainid + 1);
        bytes32 d2 = h.closeDigest(c);
        assertTrue(d1 != d2);
    }

    // ---------------------------------------------------------------------
    // EIP-712 signature verify/recover: the digest this library produces recovers the true
    // signer via solady's ECDSA, exactly as HouseChannel._checkCoSigned / _checkCloseCoSigned /
    // open() do (contracts/games/HouseChannel.sol lines 183, 439-440, 451-452).
    // ---------------------------------------------------------------------

    function test_stateDigest_recoversSigner() public {
        (address signer, uint256 pk) = makeAddrAndKey("player");
        bytes32 digest = h.stateDigest(_state());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        assertEq(ECDSA.recover(digest, v, r, s), signer);
    }

    function test_closeDigest_recoversSigner() public {
        (address signer, uint256 pk) = makeAddrAndKey("house");
        bytes32 digest = h.closeDigest(_close());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        assertEq(ECDSA.recover(digest, v, r, s), signer);
    }

    /// A signature from a DIFFERENT key never recovers to the expected signer over the same
    /// digest — the negative counterpart of the two tests above.
    function test_stateDigest_wrongSignerNeverMatches() public {
        (address player,) = makeAddrAndKey("player");
        (, uint256 imposterPk) = makeAddrAndKey("imposter");
        bytes32 digest = h.stateDigest(_state());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(imposterPk, digest);
        assertTrue(ECDSA.recover(digest, v, r, s) != player);
    }

    /// A signature produced over harness `h`'s domain does not recover to the signer when
    /// checked against harness `h2`'s digest for the IDENTICAL struct — i.e. a co-sign collected
    /// for one HouseChannel deployment cannot be replayed against a different deployment.
    function test_signatureOverOneDomain_isUselessAgainstAnotherDomain() public {
        (address signer, uint256 pk) = makeAddrAndKey("player");
        SessionState memory s = _state();
        bytes32 digestA = h.stateDigest(s);
        bytes32 digestB = h2.stateDigest(s);
        (uint8 v, bytes32 r, bytes32 sSig) = vm.sign(pk, digestA);
        assertTrue(ECDSA.recover(digestB, v, r, sSig) != signer);
    }

    // ---------------------------------------------------------------------
    // Signature malleability. NOTE ON SCOPE: SessionState.sol itself performs no signature
    // recovery (HouseChannel does, via solady's ECDSA — out of scope for this file per the
    // "no contract changes" constraint). solady's ECDSA explicitly does NOT restrict `s` to the
    // curve's lower half-order (see its own doc comment: "the recovery operations do NOT check
    // if a signature is non-malleable"). So flipping (s -> N - s, v -> v^1) is NOT rejected —
    // it produces an ALTERNATE valid encoding of the SAME signature that recovers to the SAME
    // signer. This is not a forgery vector (an attacker who only observes a signature still
    // cannot produce a signature that recovers to a DIFFERENT signer); HouseChannel's actual
    // replay protection is nonce monotonicity (StaleNonce) plus the disjoint SessionState /
    // SessionClose EIP-712 types proven above, not signature canonicalization. This test
    // documents that property against this library's real digests rather than asserting a
    // "rejection" that does not exist in the current design.
    // ---------------------------------------------------------------------

    function test_highS_malleableSignature_stillRecoversSameSigner() public {
        (address signer, uint256 pk) = makeAddrAndKey("player");
        bytes32 digest = h.stateDigest(_state());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest); // vm.sign always returns low-s

        uint256 sHigh = _SECP256K1_N - uint256(s);
        uint8 vFlipped = v == 27 ? 28 : 27;

        assertEq(ECDSA.recover(digest, v, r, s), signer);
        assertEq(ECDSA.recover(digest, vFlipped, r, bytes32(sHigh)), signer);
    }
}

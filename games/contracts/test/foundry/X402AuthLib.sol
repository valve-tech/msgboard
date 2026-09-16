// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @notice Shared EIP-3009 `ReceiveWithAuthorization` digest + signing helpers for the ZkTable
/// x402 test suites (unit, invariant, showdown, fork). Deliberately a bare library with NO
/// dependency on ZkTable/FlipBookX/Test — it must stay compilable standing alone under every
/// foundry profile (default/zk/zkverify/zkm2/ffi/eas), including the non-viaIR `zk`/`zkverify`
/// profiles, without dragging ZkTable's viaIR-only compilation graph into them. Calls the `vm`
/// cheatcode directly via forge-std's well-known VM address rather than inheriting
/// forge-std/Test, so any test contract can use it regardless of its own inheritance chain.
library X402AuthLib {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// The EIP-712 digest a wrapper token's `receiveWithAuthorization` recovers against, given
    /// that token's own `DOMAIN_SEPARATOR()`. `validAfter` is always 0 (ZkTable never sets it).
    function receiveDigest(bytes32 domainSeparator, address from, address to, uint256 value, uint64 validBefore, bytes32 nonce)
        internal
        pure
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, uint256(0), validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// Signs `digest` with `pk` and packs it into the 65-byte (r,s,v) form ZkTable._pull routes
    /// through the universal EOA overload.
    function sign65(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}

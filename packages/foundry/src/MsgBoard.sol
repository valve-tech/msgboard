// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";

/// @title MsgBoard — Foundry cheatcode helper to talk to a msgboard node.
/// @notice Uses vm.rpc against a named endpoint (configure [rpc_endpoints] msgboard).
/// Typed object-readers (status/content/getMessage structs) are intentionally omitted
/// pending confirmation of vm.rpc's object-result encoding; use raw() for those today.
library MsgBoard {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Submit an RLP-encoded message; returns the message hash.
    /// @param endpoint the rpc alias or URL of a msgboard-serving node
    /// @param rlp the RLP-encoded message
    function submit(string memory endpoint, bytes memory rlp) internal returns (bytes32 hash) {
        string memory params = string.concat('["', _toHexString(rlp), '"]');
        bytes memory result = vm.rpc(endpoint, "msgboard_addMessage", params);
        // addMessage returns a 32-byte hash; vm.rpc decodes the hex result to raw bytes
        require(result.length == 32, "MsgBoard: unexpected addMessage result");
        // length checked above; conversion takes the 32 bytes left-aligned
        // forge-lint: disable-next-line(unsafe-typecast)
        hash = bytes32(result);
    }

    /// @notice Raw JSON-RPC passthrough for any msgboard_* method.
    /// @return the raw bytes result as decoded by vm.rpc
    function raw(string memory endpoint, string memory method, string memory params)
        internal
        returns (bytes memory)
    {
        return vm.rpc(endpoint, method, params);
    }

    function _toHexString(bytes memory b) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(2 + b.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < b.length; i++) {
            out[2 + i * 2] = alphabet[uint8(b[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }
}

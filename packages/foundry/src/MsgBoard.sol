// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";

/// @title MsgBoard — Foundry cheatcode helper to talk to a msgboard node.
/// @notice Uses vm.rpc against a named endpoint (configure [rpc_endpoints] msgboard).
///
/// vm.rpc decodes scalar results cleanly (a hash -> bytes32, a quantity -> uint), but
/// object results (msgboard_status / content / getMessage) come back as an opaque ABI
/// blob — not the JSON text — so typed struct-readers can't simply lean on vm.rpc. Until
/// that path is built, use raw() for object methods and parse out-of-band. See README.
library MsgBoard {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Submit an RLP-encoded message; returns the message hash.
    /// @param endpoint the rpc alias or URL of a msgboard-serving node
    /// @param rlp the RLP-encoded message (the node validates its proof of work)
    function submit(string memory endpoint, bytes memory rlp) internal returns (bytes32 hash) {
        string memory params = string.concat('["', vm.toString(rlp), '"]');
        bytes memory result = vm.rpc(endpoint, "msgboard_addMessage", params);
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
}

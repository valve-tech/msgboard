// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {MsgBoard} from "../src/MsgBoard.sol";

/// @title PostMessage — example: post a real message to a msgboard node from Foundry.
/// @notice Grinds a valid proof-of-work message off-chain via the core SDK (over FFI), then
/// submits it with the MsgBoard cheatcode helper. Producing a valid message requires proof of
/// work tied to a recent block, which is far too expensive to do in Solidity.
//
// Requirements: forge --ffi, node on PATH, and a built @msgboard/core
//   (npm run build --workspace @msgboard/core   — from the repo root).
// Proof of work takes MINUTES at production difficulty.
//
// Run:
//   MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 \
//     forge script script/PostMessage.s.sol --ffi -vvv
contract PostMessage is Script {
    function run() external {
        string memory rpc = vm.envString("MSGBOARD_RPC");
        string memory data = vm.envOr("MSG_DATA", string("hello from foundry"));

        // FFI: grind a valid message off-chain; the script prints its RLP (hex), which
        // vm.ffi decodes back to bytes.
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "script/grind-message.cjs";
        cmd[2] = rpc;
        cmd[3] = data;
        bytes memory rlp = vm.ffi(cmd);

        bytes32 hash = MsgBoard.submit("msgboard", rlp);
        console2.log("posted message; hash:");
        console2.logBytes32(hash);
    }
}

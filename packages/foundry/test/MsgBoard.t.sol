// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgBoard} from "../src/MsgBoard.sol";

/// Integration test: only runs when MSGBOARD_RPC points at a msgboard-serving node.
/// Without it, the test returns early (passes) so CI without an endpoint stays green.
contract MsgBoardTest is Test {
    function test_raw_status_when_endpoint_set() public {
        string memory rpc = vm.envOr("MSGBOARD_RPC", string(""));
        if (bytes(rpc).length == 0) {
            emit log("MSGBOARD_RPC unset - skipping integration test");
            return;
        }
        bytes memory result = MsgBoard.raw("msgboard", "msgboard_status", "[]");
        assertGt(result.length, 0, "status should return data");
    }
}

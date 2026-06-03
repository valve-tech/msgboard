// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MsgBoard} from "../../src/MsgBoard.sol";

/// Integration tests: hit a LIVE msgboard node. Gated on MSGBOARD_RPC so the default
/// `forge test` (and CI without an endpoint) skips them. Run them with:
///   MSGBOARD_RPC=https://one.valve.city/rpc/vk_demo/evm/943 \
///     forge test --match-path "test/integration/*" -vv
contract MsgBoardIntegrationTest is Test {
    string internal constant ENDPOINT = "msgboard"; // resolves to ${MSGBOARD_RPC}

    modifier requiresEndpoint() {
        if (bytes(vm.envOr("MSGBOARD_RPC", string(""))).length == 0) {
            emit log("MSGBOARD_RPC unset - skipping integration test");
            return;
        }
        _;
    }

    function test_status_returns_aligned_data() public requiresEndpoint {
        bytes memory r = MsgBoard.raw(ENDPOINT, "msgboard_status", "[]");
        assertGt(r.length, 0, "status should return data");
        assertEq(r.length % 32, 0, "vm.rpc result should be ABI-word aligned");
    }

    function test_categories_returns_data() public requiresEndpoint {
        bytes memory r = MsgBoard.raw(ENDPOINT, "msgboard_categories", "[]");
        assertGt(r.length, 0, "categories should return data");
    }
}

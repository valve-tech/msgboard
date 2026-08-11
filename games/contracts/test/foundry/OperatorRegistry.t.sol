// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";

contract OperatorRegistryTest is Test {
    OperatorRegistry internal reg;
    address internal op = address(0x0B);
    address internal game = address(0x6A);
    address internal token = address(0x70);

    function setUp() public { reg = new OperatorRegistry(); }

    function test_register_setsOperatorId() public {
        vm.prank(op);
        assertEq(reg.register(), op);
        assertTrue(reg.registered(op));
    }

    function test_setRakeBps_boundedByMax() public {
        vm.prank(op); reg.register();
        vm.prank(op); reg.setRakeBps(game, 300);
        assertEq(reg.rakeBps(op, game), 300);
        vm.prank(op);
        vm.expectRevert(OperatorRegistry.RakeTooHigh.selector);
        reg.setRakeBps(game, 501);
    }

    function test_rakeRecipient_defaultsToOperator() public {
        vm.prank(op); reg.register();
        assertEq(reg.rakeRecipientOf(op, token), op);
        vm.prank(op); reg.setRakeRecipient(token, address(0xFEE));
        assertEq(reg.rakeRecipientOf(op, token), address(0xFEE));
    }

    function test_config_requiresRegistration() public {
        vm.prank(op);
        vm.expectRevert(OperatorRegistry.NotRegistered.selector);
        reg.setRakeBps(game, 100);
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {DefaultValidatorPolicy} from "../../contracts/games/operator/DefaultValidatorPolicy.sol";

// stand-in for the game: only operatorOf is used by the policy
contract GameStub {
    mapping(bytes32 => address) public op;
    function set(bytes32 t, address o) external { op[t] = o; }
    function operatorOf(bytes32 t) external view returns (address) { return op[t]; }
}

contract DefaultValidatorPolicyTest is Test {
    DefaultValidatorPolicy pol;
    GameStub game;
    address operator = address(0x0B);
    bytes32 tid = keccak256("t1");
    address v1 = address(0x301); address v2 = address(0x302); address v3 = address(0x303); address v4 = address(0x304);

    function setUp() public {
        pol = new DefaultValidatorPolicy();
        game = new GameStub();
        game.set(tid, operator);
    }
    function _subset(address a, address b, address c) internal pure returns (address[] memory s) {
        s = new address[](3); s[0]=a; s[1]=b; s[2]=c;
    }

    function test_setConfig_onlyOperator() public {
        address[] memory wl = new address[](0);
        vm.prank(address(0xBAD));
        vm.expectRevert(DefaultValidatorPolicy.NotOperator.selector);
        pol.setConfig(address(game), tid, 3, false, wl);
        vm.prank(operator);
        pol.setConfig(address(game), tid, 3, false, wl); // OK
    }

    function test_requireOperator() public {
        address[] memory wl = new address[](0);
        vm.prank(operator); pol.setConfig(address(game), tid, 3, true, wl);
        // validate keys config by msg.sender (the calling game), so call it AS the game.
        vm.startPrank(address(game));
        // operator not present → reject
        assertFalse(pol.validate(operator, tid, address(0), _subset(v1, v2, v3)));
        // operator present → accept
        assertTrue(pol.validate(operator, tid, address(0), _subset(operator, v1, v2)));
        vm.stopPrank();
    }

    function test_whitelist() public {
        address[] memory wl = new address[](3);
        wl[0]=v1; wl[1]=v2; wl[2]=v3;
        vm.prank(operator); pol.setConfig(address(game), tid, 3, false, wl);
        vm.startPrank(address(game)); // validate keys config by msg.sender (the calling game)
        assertTrue(pol.validate(operator, tid, address(0), _subset(v1, v2, v3)));
        assertFalse(pol.validate(operator, tid, address(0), _subset(v1, v2, v4))); // v4 not whitelisted
        vm.stopPrank();
    }

    function test_minCount() public {
        address[] memory wl = new address[](0);
        vm.prank(operator); pol.setConfig(address(game), tid, 4, false, wl);
        vm.prank(address(game)); // validate keys config by msg.sender (the calling game)
        assertFalse(pol.validate(operator, tid, address(0), _subset(v1, v2, v3))); // only 3 < 4
    }
}

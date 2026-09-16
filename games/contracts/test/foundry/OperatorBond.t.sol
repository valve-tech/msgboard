// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorBond} from "../../contracts/games/operator/OperatorBond.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

contract OperatorBondTest is Test {
    OperatorBond internal bond;
    ERC20 internal tok;
    address internal op = address(0x0B);
    address internal player = address(0x9E7);

    function setUp() public {
        bond = new OperatorBond(address(new OperatorRegistry()));
        tok = new ERC20(false);
        tok.mint(address(this), 100 ether);
        tok.approve(address(bond), type(uint256).max);
    }

    function test_post_and_withdraw() public {
        bond.postBond(op, address(tok), 50 ether);
        uint256 total = bond.bondOf(op, address(tok));
        assertEq(total, 50 ether);
        vm.prank(op);
        bond.withdrawBond(address(tok), 20 ether);
        total = bond.bondOf(op, address(tok));
        assertEq(total, 30 ether);
        assertEq(tok.balanceOf(op), 20 ether);
    }

    function test_slashToPlayer_paysPlayer_reducesTotal() public {
        bond.postBond(op, address(tok), 50 ether);
        vm.prank(op);
        bond.authorizeGame(address(this), true);
        bond.slashToPlayer(op, address(tok), player, 15 ether); // this contract is the "game"
        uint256 total = bond.bondOf(op, address(tok));
        assertEq(total, 35 ether);
        assertEq(tok.balanceOf(player), 15 ether);
    }

    function test_slash_cappedAtFreeBond() public {
        bond.postBond(op, address(tok), 10 ether);
        vm.prank(op);
        bond.authorizeGame(address(this), true);
        vm.expectRevert(OperatorBond.InsufficientBond.selector);
        bond.slashToPlayer(op, address(tok), player, 11 ether);
    }

    function test_slash_revertsWhenGameNotAuthorized() public {
        bond.postBond(op, address(tok), 50 ether);
        vm.expectRevert(OperatorBond.Unauthorized.selector);
        bond.slashToPlayer(op, address(tok), player, 15 ether);
        uint256 total = bond.bondOf(op, address(tok));
        assertEq(total, 50 ether);
        assertEq(tok.balanceOf(player), 0);
    }

    function test_authorizeGame_isOperatorScoped() public {
        address opB = address(0x0C);
        bond.postBond(opB, address(tok), 50 ether);
        vm.prank(op);
        bond.authorizeGame(address(this), true); // op authorizes this contract, NOT opB
        vm.expectRevert(OperatorBond.Unauthorized.selector);
        bond.slashToPlayer(opB, address(tok), player, 15 ether);
    }
}

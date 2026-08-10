// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorVault} from "../../contracts/games/operator/OperatorVault.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

contract OperatorVaultTest is Test {
    OperatorVault internal vault;
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;
    address internal op = address(0x0B);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        vm.prank(op); reg.register();
        vault = new OperatorVault();
        vault.initialize(op, address(esc));
        tok.mint(address(vault), 500 ether); // pre-fund the vault
    }

    function test_fund_depositsToEscrowUnderOwnerBucket() public {
        vm.prank(op);
        vault.fund(address(tok), 300 ether);
        assertEq(esc.bankrollOf(op, address(tok)), 300 ether);
        assertEq(tok.balanceOf(address(vault)), 200 ether);
    }

    function test_initialize_isOneShot() public {
        vm.expectRevert(OperatorVault.AlreadyInit.selector);
        vault.initialize(op, address(esc));
    }

    function test_fund_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(OperatorVault.NotOwner.selector);
        vault.fund(address(tok), 1 ether);
    }
}

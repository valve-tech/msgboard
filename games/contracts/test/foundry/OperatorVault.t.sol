// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/src/utils/LibClone.sol";
import {OperatorVault} from "../../contracts/games/operator/OperatorVault.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

contract OperatorVaultTest is Test {
    OperatorVault internal impl;
    OperatorVault internal vault; // a clone
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;
    address internal op = address(0x0B);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        vm.prank(op); reg.register();
        // The bare implementation is inert-locked (owner set in its constructor); real vaults are
        // clones that run initialize() in place of a constructor.
        impl = new OperatorVault();
        vault = OperatorVault(LibClone.clone(address(impl)));
        vault.initialize(op, address(esc));
        tok.mint(address(vault), 500 ether); // pre-fund the vault
    }

    /// The implementation (master copy) can never be initialized — its owner is set in the constructor,
    /// so a would-be hijacker calling initialize() on the bare impl is rejected.
    function test_implementation_isLocked() public {
        vm.expectRevert(OperatorVault.AlreadyInit.selector);
        impl.initialize(address(0xBAD), address(esc));
        assertEq(impl.owner(), address(impl));
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

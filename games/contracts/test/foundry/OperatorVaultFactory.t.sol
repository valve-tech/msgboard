// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OperatorVaultFactory} from "../../contracts/games/operator/OperatorVaultFactory.sol";
import {OperatorVault} from "../../contracts/games/operator/OperatorVault.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

/// @notice I1 regression: OperatorVault.initialize is front-runnable when clone + init are two
/// separate transactions. OperatorVaultFactory closes that window by doing both atomically in one
/// call — these tests prove the clone is a correctly-initialized, working vault and that the
/// front-run window (re-initializing after the fact) is closed.
contract OperatorVaultFactoryTest is Test {
    OperatorVault internal impl;
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    OperatorVaultFactory internal factory;
    ERC20 internal tok;

    address internal op = address(0x0B);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        impl = new OperatorVault();
        factory = new OperatorVaultFactory(address(impl), address(esc));
        tok = new ERC20(false);
        vm.prank(op); reg.register();
    }

    function test_createVault_atomicCloneAndInit() public {
        address vaultAddr = factory.createVault(op);
        OperatorVault vault = OperatorVault(vaultAddr);
        assertEq(vault.owner(), op);
        assertEq(vault.escrow(), address(esc));
    }

    function test_createVault_cloneCannotBeReinitialized() public {
        address vaultAddr = factory.createVault(op);
        vm.expectRevert(OperatorVault.AlreadyInit.selector);
        OperatorVault(vaultAddr).initialize(address(0xBAD), address(esc));
    }

    /// End-to-end: fund the clone, have the (real) owner call `fund`, and confirm the operator's
    /// escrow bankroll is credited — proving the atomically-initialized clone is a fully working vault,
    /// not just a passively-correct owner/escrow pair.
    function test_createVault_endToEnd_fundCreditsEscrowBankroll() public {
        address vaultAddr = factory.createVault(op);
        OperatorVault vault = OperatorVault(vaultAddr);

        tok.mint(vaultAddr, 500 ether);

        // The escrow requires an operator authorization to lock exposure (C1), but funding the
        // bankroll itself is permissionless — no authorization needed to deposit.
        vm.prank(op);
        vault.fund(address(tok), 300 ether);

        assertEq(esc.bankrollOf(op, address(tok)), 300 ether);
        assertEq(tok.balanceOf(vaultAddr), 200 ether);
    }

    /// Each call to `createVault` produces a distinct, independently-owned clone.
    function test_createVault_distinctClonesPerCall() public {
        address v1 = factory.createVault(op);
        address v2 = factory.createVault(address(0xC0FFEE));
        assertTrue(v1 != v2);
        assertEq(OperatorVault(v1).owner(), op);
        assertEq(OperatorVault(v2).owner(), address(0xC0FFEE));
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {EscrowHandler} from "../../contracts/test/EscrowHandler.sol";

/// @notice The load-bearing substrate invariants:
///   (I1) SOLVENCY: for every (operator, token), bankroll + locked + rake <= token.balanceOf(escrow)
///        summed across that token's buckets — the escrow can always pay what it owes.
///   (I2) ISOLATION: a hostile/fee-on-transfer token in one bucket never reduces another bucket's
///        recorded balance below what its own token backs.
contract GameEscrowInvariantTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tokA;
    ERC20 internal tokB;
    EscrowHandler internal handler;

    address internal opX = address(0xA1);
    address internal opY = address(0xA2);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tokA = new ERC20(false);
        tokB = new ERC20(false);
        vm.prank(opX); reg.register();
        vm.prank(opY); reg.register();
        handler = new EscrowHandler(esc, reg, tokA, tokB, opX, opY);
        targetContract(address(handler));
    }

    /// I1 — per (operator, token) the escrow physically holds at least what the ledger claims.
    function invariant_solvencyPerBucket() public view {
        assertLe(
            esc.bankrollOf(opX, address(tokA)) + esc.lockedOf(opX, address(tokA)),
            tokA.balanceOf(address(esc))
        );
        assertLe(
            esc.bankrollOf(opY, address(tokB)) + esc.lockedOf(opY, address(tokB)),
            tokB.balanceOf(address(esc))
        );
    }

    /// I2 — the sum of all tokA ledger claims never exceeds the escrow's tokA balance, regardless of
    /// what happens in tokB buckets (cross-token isolation).
    function invariant_tokenIsolation() public view {
        uint256 claimsA =
            esc.bankrollOf(opX, address(tokA)) + esc.lockedOf(opX, address(tokA)) +
            esc.bankrollOf(opY, address(tokA)) + esc.lockedOf(opY, address(tokA));
        assertLe(claimsA, tokA.balanceOf(address(esc)));
    }
}

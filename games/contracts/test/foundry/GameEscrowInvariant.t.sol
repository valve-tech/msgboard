// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {EscrowHandler} from "./EscrowHandler.sol";

/// @notice The load-bearing substrate invariants:
///   (I1) SOLVENCY: for every (operator, token), bankroll + locked + rake <= token.balanceOf(escrow)
///        summed across that token's buckets — the escrow can always pay what it owes.
///   (I2) ISOLATION: a hostile/fee-on-transfer token in one bucket never reduces another bucket's
///        recorded balance below what its own token backs.
///   (C1) AUTHORIZATION: no unauthorized game ever moves an operator's funds via lockExposure. Bare
///        solvency/isolation are BLIND to this — a rogue caller stealing bankroll via lockExposure +
///        settleWin still leaves every bucket individually solvent (it's a legitimate-looking bet from
///        the ledger's point of view), so this needs its own dedicated invariant fed by a handler path
///        that actually attempts the drain (see EscrowHandler.rogueLock).
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
    /// bankroll + locked + rake together are the FULL claim on this bucket — rake is real money
    /// (later drained via withdrawRake), so leaving it out of the solvency statement would let a
    /// phantom-rake accounting bug slip through undetected.
    function invariant_solvencyPerBucket() public view {
        assertLe(
            esc.bankrollOf(opX, address(tokA)) + esc.lockedOf(opX, address(tokA)) + esc.rakeOf(opX, address(tokA)),
            tokA.balanceOf(address(esc))
        );
        assertLe(
            esc.bankrollOf(opY, address(tokB)) + esc.lockedOf(opY, address(tokB)) + esc.rakeOf(opY, address(tokB)),
            tokB.balanceOf(address(esc))
        );
    }

    /// I2 — the sum of all tokA ledger claims (bankroll+locked+rake, across BOTH operators) never
    /// exceeds the escrow's tokA balance, regardless of what happens in tokB buckets (cross-token
    /// isolation).
    function invariant_tokenIsolation() public view {
        uint256 claimsA =
            esc.bankrollOf(opX, address(tokA)) + esc.lockedOf(opX, address(tokA)) + esc.rakeOf(opX, address(tokA)) +
            esc.bankrollOf(opY, address(tokA)) + esc.lockedOf(opY, address(tokA)) + esc.rakeOf(opY, address(tokA));
        assertLe(claimsA, tokA.balanceOf(address(esc)));
    }

    /// I2b — mirror of invariant_tokenIsolation for tokB, closing the (opX, tokB) blind spot that
    /// neither I1 (which only checks opX/tokA and opY/tokB) nor the tokA-only isolation check above
    /// would otherwise cover.
    function invariant_tokenIsolationB() public view {
        uint256 claimsB =
            esc.bankrollOf(opX, address(tokB)) + esc.lockedOf(opX, address(tokB)) + esc.rakeOf(opX, address(tokB)) +
            esc.bankrollOf(opY, address(tokB)) + esc.lockedOf(opY, address(tokB)) + esc.rakeOf(opY, address(tokB));
        assertLe(claimsB, tokB.balanceOf(address(esc)));
    }

    /// C1 — the handler's `rogueLock` action drives an unauthorized identity (never opted-in by
    /// either operator) at `lockExposure` every run. This must never succeed: if it ever does, the
    /// ghost flag latches true and this invariant fails, proving the authorization gate is load-bearing
    /// (not merely incidentally-never-hit by the fuzzer).
    function invariant_noUnauthorizedBankrollMovement() public view {
        assertFalse(handler.rogueDrainSucceeded());
    }
}

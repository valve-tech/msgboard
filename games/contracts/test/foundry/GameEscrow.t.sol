// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EscrowLib} from "../../contracts/games/operator/EscrowLib.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";

contract EscrowLibTest is Test {
    using EscrowLib for EscrowLib.Ledger;
    EscrowLib.Ledger internal l;

    function test_lock_debitsExposure_growsLocked() public {
        l.creditBankroll(100);
        l.lock(30, 50); // exposure 30, payout 50 (player stake 20 sits in `locked` too)
        assertEq(l.bankroll, 70);
        assertEq(l.locked, 50);
    }

    function test_lock_revertsWhenBankrollBelowExposure() public {
        l.creditBankroll(10);
        vm.expectRevert(EscrowLib.InsufficientBankroll.selector);
        this.lockExternal(30, 50);
    }

    // Internal library calls on storage get fully inlined by the via_ir pipeline (no CALL opcode),
    // so vm.expectRevert — which requires the revert at a strictly lower call depth — can't observe
    // it directly. Routing through an external call gives it a real frame to catch.
    function lockExternal(uint256 exposure, uint256 payout) external {
        l.lock(exposure, payout);
    }

    function test_settleLoss_returnsExposurePlusStakeMinusRake() public {
        l.creditBankroll(100);
        l.lock(30, 50);      // bankroll 70, locked 50
        l.settleLoss(50, 4); // rake 4
        assertEq(l.locked, 0);
        assertEq(l.rake, 4);
        assertEq(l.bankroll, 70 + 46); // exposure(30) + stake(20) - rake(4) = 46
    }

    function test_settleWin_onlyReleasesLocked() public {
        l.creditBankroll(100);
        l.lock(30, 50);
        l.settleWin(50); // payout leaves escrow to the player externally
        assertEq(l.locked, 0);
        assertEq(l.bankroll, 70); // exposure already left at lock; not returned on a win
    }

    function test_refundExposure_returnsOnlyExposure() public {
        l.creditBankroll(100);
        l.lock(30, 50);
        l.refundExposure(50, 30); // stake returns to player externally
        assertEq(l.locked, 0);
        assertEq(l.bankroll, 100 - 30 + 30); // net: exposure back, stake NOT credited (goes to player)
    }
}

contract GameEscrowDepositTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;      // plain (no burn)
    ERC20 internal feeTok;   // fee-on-transfer (burns 1%)
    address internal op = address(0x0B);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        feeTok = new ERC20(true);
        vm.prank(op); reg.register();
    }

    function test_deposit_creditsFullAmount_forPlainToken() public {
        tok.mint(address(this), 100 ether);
        tok.approve(address(esc), type(uint256).max);
        esc.depositBankroll(op, address(tok), 100 ether);
        assertEq(esc.bankrollOf(op, address(tok)), 100 ether);
        assertEq(tok.balanceOf(address(esc)), 100 ether);
    }

    function test_deposit_creditsMeasuredDelta_forFeeOnTransfer() public {
        feeTok.mint(address(this), 100 ether);
        feeTok.approve(address(esc), type(uint256).max);
        esc.depositBankroll(op, address(feeTok), 100 ether);
        // 1% burned in transfer → escrow received 99 ether → ledger credits 99, not 100
        assertEq(feeTok.balanceOf(address(esc)), 99 ether);
        assertEq(esc.bankrollOf(op, address(feeTok)), 99 ether);
    }

    function test_withdraw_onlyOperatorsOwnBucket() public {
        tok.mint(address(this), 100 ether);
        tok.approve(address(esc), type(uint256).max);
        esc.depositBankroll(op, address(tok), 100 ether);
        vm.prank(op);
        esc.withdrawBankroll(address(tok), 40 ether);
        assertEq(esc.bankrollOf(op, address(tok)), 60 ether);
        assertEq(tok.balanceOf(op), 40 ether);
    }
}

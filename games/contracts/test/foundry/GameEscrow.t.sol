// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EscrowLib} from "../../contracts/games/operator/EscrowLib.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {OperatorRegistry} from "../../contracts/games/operator/OperatorRegistry.sol";
import {ERC20} from "../../contracts/test/ERC20.sol";
import {ReenteringToken} from "../../contracts/test/ReenteringToken.sol";

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

contract GameEscrowLockTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;
    address internal op = address(0x0B);
    address internal player = address(0x9E7);
    address internal game;

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        vm.prank(op); reg.register();
        game = address(this); // this test acts as the game
        tok.mint(op, 1000 ether);
        vm.prank(op); tok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.depositBankroll(op, address(tok), 1000 ether);
        tok.mint(player, 100 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
    }

    function test_lock_pullsStake_debitsExposure_holdsPayout() public {
        bytes32 betId = keccak256("b1");
        esc.lockExposure(betId, op, address(tok), player, 10 ether, 19 ether); // exposure 9
        assertEq(esc.bankrollOf(op, address(tok)), 991 ether); // 1000 - 9
        assertEq(esc.lockedOf(op, address(tok)), 19 ether);
        // escrow physically holds bankroll(991) + locked(19) = 1010 = 1000 deposit + 10 stake
        assertEq(tok.balanceOf(address(esc)), 1010 ether);
    }

    function test_lock_revertsWhenBankrollBelowExposure() public {
        bytes32 betId = keccak256("b2");
        vm.expectRevert(EscrowLib.InsufficientBankroll.selector);
        esc.lockExposure(betId, op, address(tok), player, 10 ether, 2000 ether); // exposure 1990 > 1000
    }

    function test_lock_rejectsDuplicateBetId() public {
        bytes32 betId = keccak256("b3");
        esc.lockExposure(betId, op, address(tok), player, 10 ether, 19 ether);
        vm.expectRevert(GameEscrow.BetExists.selector);
        esc.lockExposure(betId, op, address(tok), player, 10 ether, 19 ether);
    }

    /// CEI regression: a hostile token re-entering lockExposure with the SAME betId mid-`transferFrom`
    /// (the stake pull) must hit BetExists, not double-lock exposure / double-pull the stake. This
    /// only holds because the Bet is recorded (open=true) BEFORE the external _pullVerified call.
    function test_lock_sameBetIdReentrancy_cannotDoubleLock() public {
        ReenteringToken rtok = new ReenteringToken();
        rtok.mint(op, 1000 ether);
        vm.prank(op); rtok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.depositBankroll(op, address(rtok), 1000 ether);
        rtok.mint(player, 100 ether);
        vm.prank(player); rtok.approve(address(esc), type(uint256).max);

        bytes32 betId = keccak256("reentry");
        uint256 stake = 10 ether;
        uint256 payout = 19 ether; // exposure 9 ether

        // Arm the token to re-enter lockExposure with the SAME betId/args during its transferFrom
        // (i.e. during the stake pull triggered inside the FIRST, legitimate lockExposure call).
        rtok.arm(
            address(esc),
            abi.encodeWithSelector(GameEscrow.lockExposure.selector, betId, op, address(rtok), player, stake, payout)
        );

        esc.lockExposure(betId, op, address(rtok), player, stake, payout);

        // The reentrant inner call fired exactly once and reverted (BetExists).
        assertEq(rtok.reentryCalls(), 1);
        assertTrue(rtok.lastReentryReverted());

        // Exactly ONE lock happened: exposure debited once, payout locked once.
        assertEq(esc.bankrollOf(op, address(rtok)), 991 ether); // 1000 - 9, not 1000 - 18
        assertEq(esc.lockedOf(op, address(rtok)), 19 ether);    // not 38
        assertEq(rtok.balanceOf(address(esc)), 1010 ether);     // 1000 deposit + 10 stake, pulled once

        (,,,, uint256 recordedPayout, uint256 recordedStake, bool open) = esc.bets(betId);
        assertTrue(open);
        assertEq(recordedPayout, payout);
        assertEq(recordedStake, stake);
    }
}

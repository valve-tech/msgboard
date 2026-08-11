// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EscrowLib} from "../../contracts/games/operator/EscrowLib.sol";
import {GameEscrow} from "../../contracts/games/operator/GameEscrow.sol";
import {ReentrancyGuard} from "../../contracts/games/operator/ReentrancyGuard.sol";
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
        vm.prank(op); esc.authorizeGame(game, true);
        vm.prank(player); esc.setPlayerGame(game, true);
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

    /// C1 regression: an UNAUTHORIZED caller must never be able to lock (and thereby drain) an
    /// operator's bankroll by simply naming that operator in the call. The victim's bankroll must be
    /// completely unchanged after the reverted attempt.
    function test_lock_revertsForUnauthorizedGame() public {
        address attacker = address(0xBAD);
        uint256 bankrollBefore = esc.bankrollOf(op, address(tok));
        bytes32 betId = keccak256("attack");
        vm.prank(attacker);
        vm.expectRevert(GameEscrow.UnauthorizedGame.selector);
        esc.lockExposure(betId, op, address(tok), attacker, 1, bankrollBefore + 1);
        assertEq(esc.bankrollOf(op, address(tok)), bankrollBefore); // untouched
        assertFalse(esc.betOf(attacker, betId).open); // never recorded
    }

    /// HIGH regression (shared-escrow approval drain): a game the OPERATOR authorized still cannot pull
    /// a player's standing escrow allowance unless the PLAYER opted that game in. A victim who merely
    /// approved the shared escrow for the token — but never consented to this game — must be untouchable.
    function test_lock_revertsWhenPlayerDidNotConsent() public {
        address victim = address(0xBEEF);
        tok.mint(victim, 100 ether);
        vm.prank(victim); tok.approve(address(esc), type(uint256).max); // approved the shared escrow...
        // ...but never called setPlayerGame(game): the drain vehicle is blocked here.
        bytes32 betId = keccak256("no-consent");
        vm.expectRevert(GameEscrow.PlayerNotConsented.selector);
        esc.lockExposure(betId, op, address(tok), victim, 10 ether, 19 ether);
        assertEq(tok.balanceOf(victim), 100 ether); // not a wei moved
    }

    /// C1 regression: revoking a previously-authorized game must block it immediately — the operator
    /// keeps sovereign control of who may draw on its bankroll at all times.
    function test_lock_authorizeGame_toggleOff_blocksPreviouslyAuthorized() public {
        // `game` (address(this)) is authorized in setUp and can lock successfully...
        bytes32 betId1 = keccak256("before-revoke");
        esc.lockExposure(betId1, op, address(tok), player, 10 ether, 19 ether);

        // ...until the operator revokes it.
        vm.prank(op); esc.authorizeGame(game, false);

        uint256 bankrollBefore = esc.bankrollOf(op, address(tok));
        bytes32 betId2 = keccak256("after-revoke");
        vm.expectRevert(GameEscrow.UnauthorizedGame.selector);
        esc.lockExposure(betId2, op, address(tok), player, 10 ether, 19 ether);
        assertEq(esc.bankrollOf(op, address(tok)), bankrollBefore); // unchanged by the blocked attempt
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

        GameEscrow.Bet memory b = esc.betOf(address(this), betId);
        assertTrue(b.open);
        assertEq(b.payout, payout);
        assertEq(b.stake, stake);
    }
}

contract GameEscrowSettleTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ERC20 internal tok;
    address internal op = address(0x0B);
    address internal player = address(0x9E7);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        tok = new ERC20(false);
        vm.prank(op); reg.register();
        vm.prank(op); reg.setRakeBps(address(this), 200); // 2% rake, this contract is the game
        tok.mint(op, 1000 ether);
        vm.prank(op); tok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.depositBankroll(op, address(tok), 1000 ether);
        tok.mint(player, 100 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.authorizeGame(address(this), true); // this contract acts as the game
        vm.prank(player); esc.setPlayerGame(address(this), true);
    }

    function _lock(bytes32 id) internal {
        esc.lockExposure(id, op, address(tok), player, 10 ether, 19 ether); // exposure 9
    }

    function test_settleWin_paysPlayerFullPayout() public {
        bytes32 id = keccak256("w");
        _lock(id);
        esc.settleWin(id);
        assertEq(tok.balanceOf(player), 90 ether + 19 ether); // had 100, staked 10, won 19
        assertEq(esc.lockedOf(op, address(tok)), 0);
        assertEq(esc.bankrollOf(op, address(tok)), 991 ether); // exposure gone
    }

    function test_settleLoss_accruesRake_returnsRemainderToBankroll() public {
        bytes32 id = keccak256("l");
        _lock(id);
        esc.settleLoss(id);
        // rake = 2% of stake(10) = 0.2; bankroll = 991 + (19 - 0.2) = 1009.8
        assertEq(esc.bankrollOf(op, address(tok)), 1009.8 ether);
        assertEq(esc.lockedOf(op, address(tok)), 0);
        vm.prank(op);
        esc.withdrawRake(address(tok));
        assertEq(tok.balanceOf(op), 0.2 ether); // rake swept to operator (default recipient)
    }

    function test_refund_returnsStakeToPlayer_exposureToBankroll() public {
        bytes32 id = keccak256("r");
        _lock(id);
        esc.refund(id);
        assertEq(tok.balanceOf(player), 100 ether); // stake fully back
        assertEq(esc.bankrollOf(op, address(tok)), 1000 ether); // exposure restored
        assertEq(esc.lockedOf(op, address(tok)), 0);
    }

    /// Only the recording game may settle: bets are namespaced by (game, betId), so a different caller
    /// finds no open bet under its own namespace — UnknownBet, structurally.
    function test_settle_onlyRecordedGame() public {
        bytes32 id = keccak256("g");
        _lock(id);
        vm.prank(address(0xBAD));
        vm.expectRevert(GameEscrow.UnknownBet.selector);
        esc.settleWin(id);
    }
}

/// @notice CEI proof against a hostile ESCROW TOKEN on the payout paths (settleWin/refund). Unlike
/// the Task-4 lock-side reentrancy test (which arms `transferFrom` — the stake PULL), payouts move
/// via `SafeTransferLib.safeTransfer`, i.e. the token's plain `transfer` (the PUSH leg). We arm
/// `ReenteringToken.transfer` to re-enter the same settle/refund call on the SAME betId mid-payout;
/// since `open` is flipped to `false` (and the ledger mutated) BEFORE the transfer, the reentrant
/// call must hit `UnknownBet`, proving no double payout is reachable without a reentrancy guard.
contract GameEscrowReentrancyTest is Test {
    GameEscrow internal esc;
    OperatorRegistry internal reg;
    ReenteringToken internal rtok;
    address internal op = address(0x0B);
    address internal player = address(0x9E7);

    function setUp() public {
        reg = new OperatorRegistry();
        esc = new GameEscrow(address(reg));
        rtok = new ReenteringToken();
        vm.prank(op); reg.register();
        rtok.mint(op, 1000 ether);
        vm.prank(op); rtok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.depositBankroll(op, address(rtok), 1000 ether);
        rtok.mint(player, 100 ether);
        vm.prank(player); rtok.approve(address(esc), type(uint256).max);
        vm.prank(op); esc.authorizeGame(address(rtok), true); // game of record is the token itself
        vm.prank(player); esc.setPlayerGame(address(rtok), true);
    }

    /// CEI proof: settleWin flips the bet closed and zeroes the ledger's `locked` BEFORE the payout
    /// `safeTransfer` (a plain ERC-20 `transfer`, the push leg). Arm the token to re-enter settleWin
    /// on the SAME betId mid-transfer; the reentrant call must hit UnknownBet (bet already closed),
    /// so no double payout is possible.
    ///
    /// De-confounding note: the recorded game must be `address(rtok)` itself. When the token
    /// re-enters during its own `transfer`, the call to GameEscrow originates from the token
    /// contract's code, so `msg.sender == address(rtok)`. If the recorded `bets[betId].game` were
    /// this test contract instead, `_openBet`'s `b.game != msg.sender` check would ALSO reject the
    /// reentry (as `NotBetGame`) regardless of whether `open` had been flipped — masking the CEI
    /// property under test entirely (a broken settleWin that transfers before flipping `open` would
    /// still make this test pass). Pranking both the lock and the settle as `address(rtok)` makes the
    /// `NotBetGame` gate always satisfied, so `UnknownBet` is the ONLY thing that can stop the
    /// reentry — which is exactly the CEI property being proven.
    function test_settleWin_isReentrancySafe() public {
        bytes32 betId = keccak256("re-settle");
        uint256 stake = 10 ether;
        uint256 payout = 19 ether;
        vm.prank(address(rtok));
        esc.lockExposure(betId, op, address(rtok), player, stake, payout); // game = address(rtok)

        // Arm re-entry to fire during the payout `transfer` call, targeting the SAME betId —
        // settleWin has already flipped `open = false` by the time this fires.
        rtok.arm(address(esc), abi.encodeWithSelector(GameEscrow.settleWin.selector, betId));

        vm.prank(address(rtok));
        esc.settleWin(betId);

        // The reentrant settleWin fired exactly once and reverted with the SPECIFIC selector
        // UnknownBet — not NotBetGame, not an unrelated revert — proving the `open` flag (flipped
        // before the transfer) is what stopped it.
        assertEq(rtok.reentryCalls(), 1);
        assertTrue(rtok.lastReentryReverted());
        assertEq(bytes4(rtok.lastReentryReturnData()), ReentrancyGuard.Reentrancy.selector); // guard is the primary defense; CEI (open flipped) is the second line

        // Exactly ONE payout left the escrow: locked is drained once, player receives one payout.
        assertEq(esc.lockedOf(op, address(rtok)), 0);
        assertEq(rtok.balanceOf(player), 100 ether - stake + payout);
        bool open = esc.betOf(address(rtok), betId).open;
        assertFalse(open);
    }

    /// Same CEI proof on the refund path: `refund` flips the bet closed and restores exposure to the
    /// operator's bankroll BEFORE the stake `transfer` back to the player. Arm re-entry into `refund`
    /// on the SAME betId; it must hit UnknownBet too, so the stake can't be returned twice. Same
    /// de-confounding as settleWin: game = address(rtok) so `NotBetGame` can never fire, isolating
    /// `open` as the only guard.
    function test_refund_isReentrancySafe() public {
        bytes32 betId = keccak256("re-refund");
        uint256 stake = 10 ether;
        uint256 payout = 19 ether;
        vm.prank(address(rtok));
        esc.lockExposure(betId, op, address(rtok), player, stake, payout);

        rtok.arm(address(esc), abi.encodeWithSelector(GameEscrow.refund.selector, betId));

        vm.prank(address(rtok));
        esc.refund(betId);

        assertEq(rtok.reentryCalls(), 1);
        assertTrue(rtok.lastReentryReverted());
        assertEq(bytes4(rtok.lastReentryReturnData()), ReentrancyGuard.Reentrancy.selector); // guard is the primary defense; CEI (open flipped) is the second line

        assertEq(esc.lockedOf(op, address(rtok)), 0);
        assertEq(rtok.balanceOf(player), 100 ether); // stake returned exactly once
        bool open = esc.betOf(address(rtok), betId).open;
        assertFalse(open);
    }

    // Re-entry target: a nested deposit into the same (operator, token) bucket.
    function reenterDeposit() external {
        esc.depositBankroll(op, address(rtok), 100 ether);
    }

    /// CRITICAL regression (PoC-confirmed pre-fix): the balance-delta credit must not be inflatable by
    /// a nested reentrant deposit. Without the guard, the OUTER deposit's balanceOf delta spans the
    /// INNER transfer, crediting 300 for 200 real tokens — inflating the ledger past the escrow's real
    /// balance and letting the bucket drain co-tenants of that token. The guard makes the reentrant
    /// deposit revert, so only the genuine outer transfer is ever measured.
    function test_nestedDeposit_cannotDoubleCount() public {
        rtok.mint(address(this), 1000 ether);
        rtok.approve(address(esc), type(uint256).max);
        uint256 bankBefore = esc.bankrollOf(op, address(rtok));
        uint256 escBefore = rtok.balanceOf(address(esc));

        rtok.arm(address(this), abi.encodeWithSelector(this.reenterDeposit.selector));
        esc.depositBankroll(op, address(rtok), 200 ether);

        // the nested deposit fired once and was rejected by the guard
        assertEq(rtok.reentryCalls(), 1);
        assertTrue(rtok.lastReentryReverted());
        assertEq(bytes4(rtok.lastReentryReturnData()), ReentrancyGuard.Reentrancy.selector);
        // exactly the outer 200 credited AND escrowed — the ledger never exceeds the real balance
        assertEq(esc.bankrollOf(op, address(rtok)) - bankBefore, 200 ether);
        assertEq(rtok.balanceOf(address(esc)) - escBefore, 200 ether);
    }
}

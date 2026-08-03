// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {HouseBankroll} from "../../contracts/games/HouseBankroll.sol";
import {HousePoolBase} from "../../contracts/games/HousePoolBase.sol";
import {SessionState} from "../../contracts/games/SessionState.sol";

/// Coverage-focused companion to HouseBankroll.t.sol (which owns the happy-path settle() tests:
/// win/loss, incremental re-settle, StaleNonce-after-settle, BadSig(finalSigHouse),
/// ConservationViolated, BadGenesis). This file closes out every OTHER external/public function
/// (deposit/withdraw/fundHouse/withdrawHouse/setHouseKey/onlyOwner branches) plus the remaining
/// settle() error branches: WrongTable, BadMode (both sub-checks), the "fresh table" StaleNonce
/// check, NotPlayer, the two other BadSig recover sites, InsufficientPool, and InsufficientDeposit
/// (the settle-path debit, distinct call site from withdraw()'s).
contract HouseBankrollUnitTest is Test {
    Chips internal chips;
    HouseBankroll internal bank;

    uint256 internal pkPlayer = 0xA11CE;
    uint256 internal pkHouse = 0xB0B;
    uint256 internal pkOther = 0xC0FFEE;
    address internal player; // session key
    address internal house;  // house session key
    address internal other;

    function setUp() public {
        chips = new Chips();
        bank = new HouseBankroll(address(chips));
        player = vm.addr(pkPlayer);
        house = vm.addr(pkHouse);
        other = vm.addr(pkOther);
        bank.setHouseKey(house);

        chips.mint(player, 10_000);
        chips.mint(address(this), 10_000);
        vm.startPrank(player);
        chips.approve(address(bank), type(uint256).max);
        bank.deposit(1_000);
        vm.stopPrank();
        chips.approve(address(bank), type(uint256).max);
        bank.fundHouse(1_000);
    }

    function _state(bytes32 tableId, uint64 nonce, uint256 bp, uint256 bh)
        internal
        pure
        returns (SessionState memory s)
    {
        s.tableId = tableId;
        s.nonce = nonce;
        s.balancePlayer = bp;
        s.balanceHouse = bh;
        s.settlementMode = 0;
        s.gameId = 1;
        s.gameStateHash = bytes32(0);
        s.rngCommit = keccak256("commit");
    }

    function _sign(uint256 pk, SessionState memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pk, bank.stateDigest(s));
        return abi.encodePacked(r, ss, v);
    }

    // ---------------------------------------------------------------
    // setHouseKey
    // ---------------------------------------------------------------

    function test_setHouseKeyRevertsNonOwner() public {
        vm.prank(player);
        vm.expectRevert(Ownable.Unauthorized.selector);
        bank.setHouseKey(other);
    }

    function test_setHouseKeySetsAndEmits() public {
        vm.expectEmit(true, false, false, false, address(bank));
        emit HouseBankroll.HouseKeySet(other);
        bank.setHouseKey(other);
        assertEq(bank.houseKey(), other);
    }

    // ---------------------------------------------------------------
    // deposit / withdraw
    // ---------------------------------------------------------------

    function test_depositIncreasesBalanceAndTransfers() public {
        uint256 bankBalBefore = chips.balanceOf(address(bank));
        vm.expectEmit(true, false, false, true, address(bank));
        emit HouseBankroll.Deposited(player, 500);
        vm.prank(player);
        bank.deposit(500);
        assertEq(bank.deposits(player), 1_500);
        assertEq(chips.balanceOf(address(bank)), bankBalBefore + 500);
    }

    function test_withdrawSuccess() public {
        uint256 playerBalBefore = chips.balanceOf(player);
        vm.expectEmit(true, false, false, true, address(bank));
        emit HouseBankroll.Withdrawn(player, 300);
        vm.prank(player);
        bank.withdraw(300);
        assertEq(bank.deposits(player), 700);
        assertEq(chips.balanceOf(player), playerBalBefore + 300);
    }

    function test_withdrawRevertsInsufficientDeposit() public {
        vm.prank(player);
        vm.expectRevert(HouseBankroll.InsufficientDeposit.selector);
        bank.withdraw(1_001);
    }

    // ---------------------------------------------------------------
    // fundHouse / withdrawHouse
    // ---------------------------------------------------------------

    function test_fundHouseRevertsNonOwner() public {
        vm.prank(player);
        vm.expectRevert(Ownable.Unauthorized.selector);
        bank.fundHouse(1);
    }

    function test_fundHouseIncreasesPoolAndEmits() public {
        uint256 poolBefore = bank.housePool();
        vm.expectEmit(false, false, false, true, address(bank));
        emit HousePoolBase.HouseFunded(400);
        bank.fundHouse(400);
        assertEq(bank.housePool(), poolBefore + 400);
    }

    function test_withdrawHouseRevertsNonOwner() public {
        vm.prank(player);
        vm.expectRevert(Ownable.Unauthorized.selector);
        bank.withdrawHouse(1);
    }

    function test_withdrawHouseRevertsInsufficientPool() public {
        vm.expectRevert(HousePoolBase.InsufficientPool.selector);
        bank.withdrawHouse(1_001);
    }

    function test_withdrawHouseSuccess() public {
        uint256 ownerBalBefore = chips.balanceOf(address(this));
        vm.expectEmit(false, false, false, true, address(bank));
        emit HousePoolBase.HouseWithdrawn(200);
        bank.withdrawHouse(200);
        assertEq(bank.housePool(), 800);
        assertEq(chips.balanceOf(address(this)), ownerBalBefore + 200);
    }

    // ---------------------------------------------------------------
    // settle() — remaining error branches
    // ---------------------------------------------------------------

    function test_settleRevertsWrongTable() public {
        SessionState memory o = _state(keccak256("tableA"), 0, 200, 200);
        SessionState memory f = _state(keccak256("tableB"), 5, 260, 140);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.WrongTable.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsBadModeOpenSettlementMode() public {
        bytes32 tid = keccak256("badmode-open");
        SessionState memory o = _state(tid, 0, 200, 200);
        o.settlementMode = 1; // escrowed, not optimistic
        SessionState memory f = _state(tid, 5, 260, 140);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.BadMode.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsBadModeFinalSettlementMode() public {
        bytes32 tid = keccak256("badmode-final");
        SessionState memory o = _state(tid, 0, 200, 200);
        SessionState memory f = _state(tid, 5, 260, 140);
        f.settlementMode = 2; // zk, not optimistic
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.BadMode.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsBadModeGameIdMismatch() public {
        bytes32 tid = keccak256("badmode-gameid");
        SessionState memory o = _state(tid, 0, 200, 200);
        SessionState memory f = _state(tid, 5, 260, 140);
        f.gameId = 2; // mismatched vs open.gameId == 1
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.BadMode.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsStaleNonceOnFreshTable() public {
        // finalState.nonce <= openState.nonce (both 0) must be caught BEFORE ever consulting
        // settledNonce[tableId] — a distinct branch from HouseBankroll.t.sol's
        // test_rejectsStaleNonce, which hits the second (post-settle) StaleNonce check.
        bytes32 tid = keccak256("fresh-stale");
        SessionState memory o = _state(tid, 0, 200, 200);
        SessionState memory f = _state(tid, 0, 200, 200);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.StaleNonce.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsNotPlayerWhenRecoveredIsHouseKey() public {
        // Sign the PLAYER slot with the house's own key so the recovered "player" == houseKey.
        bytes32 tid = keccak256("notplayer");
        SessionState memory o = _state(tid, 0, 200, 200);
        SessionState memory f = _state(tid, 5, 260, 140);
        bytes memory osP = _sign(pkHouse, o); // wrong signer on purpose
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.NotPlayer.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsBadSigFinalPlayer() public {
        // openSigPlayer correctly recovers `player`; finalSigPlayer recovers someone else.
        bytes32 tid = keccak256("badsig-finalplayer");
        SessionState memory o = _state(tid, 0, 200, 200);
        SessionState memory f = _state(tid, 5, 260, 140);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkOther, f); // wrong signer
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.BadSig.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsBadSigOpenHouse() public {
        // player+finalSigPlayer line up; openSigHouse does not recover to houseKey.
        bytes32 tid = keccak256("badsig-openhouse");
        SessionState memory o = _state(tid, 0, 200, 200);
        SessionState memory f = _state(tid, 5, 260, 140);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkPlayer, o); // wrong signer (should be pkHouse)
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.BadSig.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsInsufficientPoolOnWin() public {
        // housePool is 1_000 from setUp; craft a win of 1_100 to exceed it.
        bytes32 tid = keccak256("insuff-pool");
        SessionState memory o = _state(tid, 0, 500, 1_500);
        SessionState memory f = _state(tid, 5, 1_600, 400);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HousePoolBase.InsufficientPool.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleRevertsInsufficientDepositOnLoss() public {
        // deposits[player] is 1_000 from setUp; craft a loss of 1_300 to exceed it.
        bytes32 tid = keccak256("insuff-deposit");
        SessionState memory o = _state(tid, 0, 1_500, 500);
        SessionState memory f = _state(tid, 5, 200, 1_800);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.InsufficientDeposit.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_settleZeroDeltaWhenBalanceEqualsBaseline() public {
        // finalState.balancePlayer == baseline: takes the ">=" (win) branch with win == 0, a
        // no-op transfer that should still succeed and emit Settled(delta = 0).
        bytes32 tid = keccak256("zero-delta");
        SessionState memory o = _state(tid, 0, 200, 200);
        SessionState memory f = _state(tid, 5, 200, 200);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        uint256 depositsBefore = bank.deposits(player);
        uint256 poolBefore = bank.housePool();
        vm.expectEmit(true, true, false, true, address(bank));
        emit HouseBankroll.Settled(tid, player, 5, int256(0));
        bank.settle(o, f, osP, osH, fsP, fsH);
        assertEq(bank.deposits(player), depositsBefore);
        assertEq(bank.housePool(), poolBefore);
        assertEq(bank.settledNonce(tid), 5);
    }
}

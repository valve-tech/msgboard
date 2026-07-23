// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {HouseBankroll} from "../../contracts/games/HouseBankroll.sol";
import {SessionState} from "../../contracts/games/SessionState.sol";

contract HouseBankrollTest is Test {
    Chips internal chips;
    HouseBankroll internal bank;

    uint256 internal pkPlayer = 0xA11CE;
    uint256 internal pkHouse = 0xB0B;
    address internal player; // session key
    address internal house;  // house session key

    function setUp() public {
        chips = new Chips();
        bank = new HouseBankroll(address(chips));
        player = vm.addr(pkPlayer);
        house = vm.addr(pkHouse);
        bank.setHouseKey(house);

        chips.mint(player, 1_000);
        chips.mint(address(this), 1_000);
        vm.startPrank(player);
        chips.approve(address(bank), type(uint256).max);
        bank.deposit(1_000);
        vm.stopPrank();
        chips.approve(address(bank), type(uint256).max);
        bank.fundHouse(1_000);
    }

    function _state(uint64 nonce, uint256 bp, uint256 bh) internal pure returns (SessionState memory s) {
        s.tableId = keccak256("t1");
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

    function test_settlePaysPlayerNetWin() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 260, 140);
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), _sign(pkHouse, f));
        assertEq(bank.deposits(player), 1_060);
        assertEq(bank.housePool(), 940);
        assertEq(bank.settledNonce(keccak256("t1")), 5);
    }

    function test_settleDebitsPlayerNetLoss() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 150, 250);
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), _sign(pkHouse, f));
        assertEq(bank.deposits(player), 950);
        assertEq(bank.housePool(), 1_050);
    }

    function test_rejectsStaleNonce() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 260, 140);
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), _sign(pkHouse, f));
        SessionState memory f2 = _state(5, 100, 300);
        // Hoist signing: vm.expectRevert applies to the literal next call, so all vm.sign
        // cheatcode calls must complete before it.
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f2);
        bytes memory fsH = _sign(pkHouse, f2);
        vm.expectRevert(HouseBankroll.StaleNonce.selector);
        bank.settle(o, f2, osP, osH, fsP, fsH);
    }

    function test_rejectsSingleSigned() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 260, 140);
        bytes memory wrong = _sign(pkPlayer, f);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        vm.expectRevert(HouseBankroll.BadSig.selector);
        bank.settle(o, f, osP, osH, fsP, wrong);
    }

    function test_rejectsConservationViolation() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 260, 200);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.ConservationViolated.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_rejectsNonGenesisOpen() public {
        SessionState memory o = _state(1, 200, 200);
        SessionState memory f = _state(5, 260, 140);
        bytes memory osP = _sign(pkPlayer, o);
        bytes memory osH = _sign(pkHouse, o);
        bytes memory fsP = _sign(pkPlayer, f);
        bytes memory fsH = _sign(pkHouse, f);
        vm.expectRevert(HouseBankroll.BadGenesis.selector);
        bank.settle(o, f, osP, osH, fsP, fsH);
    }

    function test_incrementalSettleNoDoublePay() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f5 = _state(5, 260, 140); // +60 from genesis
        bank.settle(o, f5, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f5), _sign(pkHouse, f5));
        assertEq(bank.deposits(player), 1_060);
        assertEq(bank.housePool(), 940);
        // continue the SAME session to nonce 8 (300 total => +40 more, +100 total from genesis)
        SessionState memory f8 = _state(8, 300, 100);
        bank.settle(o, f8, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f8), _sign(pkHouse, f8));
        // incremental: only +40 more applied, NOT the full +100 again (would be 1_160 if buggy)
        assertEq(bank.deposits(player), 1_100);
        assertEq(bank.housePool(), 900);
        assertEq(bank.settledNonce(keccak256("t1")), 8);
    }
}

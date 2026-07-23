// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {HouseChannel, OpenTerms} from "../../contracts/games/HouseChannel.sol";
import {SessionState} from "../../contracts/games/SessionState.sol";

contract HouseChannelTest is Test {
    Chips internal chips;
    HouseChannel internal ch;

    uint256 internal pkPlayerKey = 0xA11CE;
    uint256 internal pkHouse = 0xB0B;
    // a deterministic non-key wallet address (distinct from playerKey/houseKey)
    address internal playerWallet = address(uint160(uint256(keccak256("player-wallet"))));
    address internal playerKey;
    address internal house;

    bytes32 internal constant TID = keccak256("ct1");
    uint64 internal constant CLOCK = 30;

    function setUp() public {
        chips = new Chips();
        ch = new HouseChannel(address(chips));
        playerKey = vm.addr(pkPlayerKey);
        house = vm.addr(pkHouse);
        ch.setHouseKey(house);

        chips.mint(playerWallet, 1_000);
        chips.mint(address(this), 10_000);
        chips.approve(address(ch), type(uint256).max);
        ch.fundHouse(10_000);
        vm.prank(playerWallet);
        chips.approve(address(ch), type(uint256).max);
    }

    function _terms() internal view returns (OpenTerms memory t) {
        t.tableId = TID;
        t.player = playerWallet;
        t.playerKey = playerKey;
        t.escrowPlayer = 200;
        t.escrowHouse = 200;
        t.gameId = 1;
        t.rngCommit = keccak256("commit");
        t.clockBlocks = CLOCK;
        t.expiry = uint64(block.timestamp + 1 hours);
        t.clientSeedCommit = keccak256("client-commit");
        t.paramsHash = keccak256(abi.encode(uint256(5000)));
    }

    function test_openPersistsCommits() public {
        OpenTerms memory t = _terms();
        bytes memory sig = _signHouseTerms(t);
        vm.prank(playerWallet);
        ch.open(t, sig);
        (bytes32 rng, bytes32 csc, bytes32 ph) = ch.tableCommits(TID);
        assertEq(rng, keccak256("commit"));
        assertEq(csc, keccak256("client-commit"));
        assertEq(ph, keccak256(abi.encode(uint256(5000))));
    }

    function _signHouseTerms(OpenTerms memory t) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkHouse, ch.openTermsDigest(t));
        return abi.encodePacked(r, s, v);
    }

    function _open() internal returns (OpenTerms memory t) {
        t = _terms();
        bytes memory sig = _signHouseTerms(t); // hoist: vm.prank affects only the very next call
        vm.prank(playerWallet);
        ch.open(t, sig);
    }

    function _state(uint64 nonce, uint256 bp, uint256 bh) internal pure returns (SessionState memory s) {
        s.tableId = TID;
        s.nonce = nonce;
        s.balancePlayer = bp;
        s.balanceHouse = bh;
        s.settlementMode = 1;
        s.gameId = 1;
        s.gameStateHash = bytes32(0);
        s.rngCommit = keccak256("commit");
    }

    function _coSign(SessionState memory s) internal view returns (bytes memory sp, bytes memory sh) {
        bytes32 d = ch.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 ss1) = vm.sign(pkPlayerKey, d);
        (uint8 v2, bytes32 r2, bytes32 ss2) = vm.sign(pkHouse, d);
        sp = abi.encodePacked(r1, ss1, v1);
        sh = abi.encodePacked(r2, ss2, v2);
    }

    event Opened(bytes32 indexed tableId, address indexed player, address playerKey, uint8 gameId, uint256 escrowPlayer, uint256 escrowHouse);

    // the indexer joins settlement rows by gameId, so Opened must carry it
    function test_openedEmitsGameId() public {
        OpenTerms memory t = _terms(); // gameId 1
        bytes memory sig = _signHouseTerms(t);
        vm.expectEmit(true, true, false, true, address(ch));
        emit Opened(t.tableId, playerWallet, t.playerKey, t.gameId, t.escrowPlayer, t.escrowHouse);
        vm.prank(playerWallet);
        ch.open(t, sig);
    }

    function test_openEscrowsAndReserves() public {
        _open();
        assertEq(chips.balanceOf(address(ch)), 10_200); // pool 10k + player escrow 200
        assertEq(ch.housePool(), 9_800);                // 10k - reserved 200
        assertEq(chips.balanceOf(playerWallet), 800);
    }

    function test_settlePaysFromEscrow() public {
        _open();
        SessionState memory f = _state(5, 260, 140); // player won 60 within the 400 escrow
        (bytes memory sp, bytes memory sh) = _coSign(f);
        ch.settle(f, sp, sh);
        assertEq(chips.balanceOf(playerWallet), 800 + 260);
        assertEq(ch.housePool(), 9_800 + 140);
    }

    function test_settleRejectsConservation() public {
        _open();
        SessionState memory f = _state(5, 260, 200); // 460 != 400
        (bytes memory sp, bytes memory sh) = _coSign(f);
        vm.expectRevert(HouseChannel.ConservationViolated.selector);
        ch.settle(f, sp, sh);
    }

    function test_openRejectsBadHouseSig() public {
        OpenTerms memory t = _terms();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkPlayerKey, ch.openTermsDigest(t)); // wrong signer
        bytes memory sig = abi.encodePacked(r, s, v); // hoist before prank+expectRevert
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.BadSig.selector);
        ch.open(t, sig);
    }

    function test_doubleSettleRejected() public {
        _open();
        SessionState memory f = _state(5, 260, 140);
        (bytes memory sp, bytes memory sh) = _coSign(f);
        ch.settle(f, sp, sh);
        vm.expectRevert(HouseChannel.BadStatus.selector); // table now Settled
        ch.settle(f, sp, sh);
    }

    function test_disputeTimeoutPaysPostedState() public {
        _open();
        SessionState memory s = _state(3, 240, 160);
        (bytes memory sp, bytes memory sh) = _coSign(s);
        vm.prank(playerWallet);
        ch.dispute(s, sp, sh);
        vm.roll(block.number + CLOCK + 1);
        ch.resolveTimeout(TID);
        assertEq(chips.balanceOf(playerWallet), 800 + 240);
        assertEq(ch.housePool(), 9_800 + 160);
    }

    function test_resolveTimeoutBeforeClockReverts() public {
        _open();
        SessionState memory s = _state(3, 240, 160);
        (bytes memory sp, bytes memory sh) = _coSign(s);
        vm.prank(playerWallet);
        ch.dispute(s, sp, sh);
        vm.expectRevert(HouseChannel.ClockNotExpired.selector);
        ch.resolveTimeout(TID);
    }

    function test_respondWithNewerStateOverrides() public {
        _open();
        SessionState memory stale = _state(3, 300, 100); // player-favorable, posted by player
        (bytes memory sp1, bytes memory sh1) = _coSign(stale);
        vm.prank(playerWallet);
        ch.dispute(stale, sp1, sh1);
        // house overrides with a strictly-newer co-signed state
        SessionState memory newer = _state(7, 150, 250);
        (bytes memory sp2, bytes memory sh2) = _coSign(newer);
        ch.respondWithState(newer, sp2, sh2);
        assertEq(chips.balanceOf(playerWallet), 800 + 150);
        assertEq(ch.housePool(), 9_800 + 250);
    }

    function test_respondWithOlderStateReverts() public {
        _open();
        SessionState memory s = _state(7, 150, 250);
        (bytes memory sp1, bytes memory sh1) = _coSign(s);
        vm.prank(playerWallet);
        ch.dispute(s, sp1, sh1);
        SessionState memory older = _state(3, 300, 100);
        (bytes memory sp2, bytes memory sh2) = _coSign(older);
        vm.expectRevert(HouseChannel.StaleNonce.selector);
        ch.respondWithState(older, sp2, sh2);
    }

    // ---- audit finding I: a both-signed state for the WRONG game must not settle this table ----
    function test_settleRejectsWrongGameId() public {
        _open(); // table is gameId 1
        SessionState memory f = _state(5, 260, 140);
        f.gameId = 2; // conservation still holds (400); only the game differs
        (bytes memory sp, bytes memory sh) = _coSign(f); // validly co-signed, wrong game
        vm.expectRevert(HouseChannel.WrongGame.selector);
        ch.settle(f, sp, sh);
    }

    // the same guard lives in _checkCoSigned, so it also protects the dispute path, not just settle
    function test_disputeRejectsWrongGameId() public {
        _open();
        SessionState memory s = _state(3, 240, 160);
        s.gameId = 2;
        (bytes memory sp, bytes memory sh) = _coSign(s);
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.WrongGame.selector);
        ch.dispute(s, sp, sh);
    }

    // ---- audit finding B: opened-but-never-co-signed table can always be refunded ----
    function test_disputeFromOpenRefundsOpeningSplit() public {
        _open(); // player escrowed 200, house reserved 200; NO state ever co-signed
        vm.prank(playerWallet);
        ch.disputeFromOpen(TID);
        vm.roll(block.number + CLOCK + 1);
        ch.resolveTimeout(TID);
        assertEq(chips.balanceOf(playerWallet), 1_000); // 800 left after open + 200 refunded
        assertEq(ch.housePool(), 10_000);               // 9_800 + 200 escrow returned to pool
    }

    function test_disputeFromOpenOverriddenByRealRound() public {
        _open();
        // Player tries to escape via the opening floor; the house defends with the real co-signed
        // round (a player loss) before the clock expires.
        vm.prank(playerWallet);
        ch.disputeFromOpen(TID);
        SessionState memory lost = _state(3, 50, 350); // real co-signed round: player down to 50
        (bytes memory sp, bytes memory sh) = _coSign(lost);
        ch.respondWithState(lost, sp, sh);
        assertEq(chips.balanceOf(playerWallet), 800 + 50);
        assertEq(ch.housePool(), 9_800 + 350);
    }

    function test_disputeFromOpenRejectsStranger() public {
        _open();
        vm.prank(address(0xDEAD));
        vm.expectRevert(HouseChannel.NotPlayer.selector);
        ch.disputeFromOpen(TID);
    }
}

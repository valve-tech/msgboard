// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {IGameRules} from "../../contracts/zk/IGameRules.sol";
import {MockGameRules} from "../../contracts/test/MockGameRules.sol";
import {MockRevealVerifier} from "../../contracts/test/MockRevealVerifier.sol";
import {HiLoWarRules} from "../../contracts/zk/HiLoWarRules.sol";
import {HiLo, HiLoCodec} from "./HiLoWarRules.t.sol";

/// A revealVerifier stand-in whose fallback unconditionally reverts, so
/// respondWithShare's `staticcall` sees `callOk == false`.
contract RevertingVerifier {
    fallback() external {
        revert("nope");
    }
}

/// A revealVerifier stand-in whose fallback succeeds but returns fewer than 32
/// bytes, so respondWithShare's `ret.length < 32` branch fires.
contract ShortReturnVerifier {
    fallback() external {
        assembly {
            return(0, 1)
        }
    }
}

/// @notice Deterministic unit coverage for every external/public function and every
/// custom error in ZkTable.sol, with particular emphasis on the dispute ladder
/// (openDispute / respondWithState / respondWithMove / respondWithShare /
/// resolveTimeout) that ZkTable.t.sol and ZkTableInvariant.t.sol only exercise on
/// their happy paths. Reuses the co-sign/setUp conventions from ZkTable.t.sol
/// (real `vm.sign` over the EIP-712 digest) and the MockGameRules/MockRevealVerifier
/// test doubles already vendored under contracts/test/.
contract ZkTableUnitTest is Test {
    ZkTable internal zk;
    MockGameRules internal rules;

    // Player wallets (send txs / own escrow).
    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    address internal a;
    address internal b;

    // A stranger with no seat at any table.
    address internal stranger = address(0xBEEF);

    // Dedicated channel *signing* keys, distinct from the player wallets, used by the
    // tests that must exercise the `who == t.keyA` / `who == t.keyB` half of the
    // `_seatOf` OR (as opposed to `who == t.playerA` / `who == t.playerB`).
    uint256 internal constant PK_KEYA = 0x5E55A;
    uint256 internal constant PK_KEYB = 0x5E55B;
    address internal keyA;
    address internal keyB;

    uint64 internal constant CLOCK = 30; // MIN_CLOCK_BLOCKS
    uint256[2] internal ZERO_DECK = [uint256(0), uint256(0)];

    event TableCreated(bytes32 indexed tableId, address indexed playerA, address rules, uint256 escrow, uint256 joinStake, uint64 clockBlocks);
    event TableJoined(bytes32 indexed tableId, address indexed playerB);
    event TableCancelled(bytes32 indexed tableId);
    event ToppedUp(bytes32 indexed tableId, uint8 seat, uint256 amount);
    event TableSettled(bytes32 indexed tableId, uint256 payoutA, uint256 payoutB);
    event DisputeOpened(bytes32 indexed tableId, uint8 disputant, uint8 demandKind, uint32 demandSlot, uint64 deadline);
    event SetupDisputeOpened(bytes32 indexed tableId, uint8 disputant, uint64 deadline);
    event DisputeAnsweredWithState(bytes32 indexed tableId, uint64 nonce);
    event DisputeAnsweredWithMove(bytes32 indexed tableId, bytes move, bytes32 newGameStateHash);
    event DisputeAnsweredWithShare(bytes32 indexed tableId, uint32 slot, uint256 revealX, uint256 revealY);
    event DisputeForfeited(bytes32 indexed tableId, uint8 winner, uint256 payoutA, uint256 payoutB);
    event SetupDisputeRefunded(bytes32 indexed tableId);
    event TopUpReclaimed(bytes32 indexed tableId, uint8 seat, uint256 amount);

    function setUp() public {
        zk = new ZkTable();
        rules = new MockGameRules();
        a = vm.addr(PK_A);
        b = vm.addr(PK_B);
        keyA = vm.addr(PK_KEYA);
        keyB = vm.addr(PK_KEYB);
        vm.deal(a, 1_000_000 ether);
        vm.deal(b, 1_000_000 ether);
        vm.deal(stranger, 1_000_000 ether);
        vm.deal(keyA, 1_000_000 ether);
        vm.deal(keyB, 1_000_000 ether);
    }

    // ── generic helpers ──────────────────────────────────────────────────────

    function _emptyState(bytes32 tableId) internal pure returns (ChannelState memory s) {
        s.tableId = tableId;
        s.nonce = 0;
        s.deckCommitment = bytes32(0);
        s.phase = 0;
        s.gameStateHash = bytes32(0);
    }

    /// Co-sign with the WALLET keys (default channelKey == address(0) tables).
    function _coSign(ChannelState memory s) internal view returns (bytes memory sigA, bytes memory sigB) {
        return _coSignWith(PK_A, PK_B, s);
    }

    function _coSignWith(uint256 pkA_, uint256 pkB_, ChannelState memory s) internal view returns (bytes memory sigA, bytes memory sigB) {
        bytes32 digest = zk.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pkA_, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(pkB_, digest);
        sigA = abi.encodePacked(r1, s1, v1);
        sigB = abi.encodePacked(r2, s2, v2);
    }

    // Narrow struct-getter readbacks. (Deliberately NOT one big tuple: destructuring
    // ZkTable's full 17-output getter — 16 scalars plus the nested ChannelState struct
    // — into a single function alongside other locals hits solc's Yul "stack too deep"
    // under this profile's viaIR + optimizer-runs:1000, so each helper below pulls out
    // only the couple of fields a given test needs.)
    function _status(bytes32 id) internal view returns (ChannelTableBase.Status status) {
        (, , , , , , , , , status, , , , , , , , , ) = zk.tables(id);
    }

    function _escrows(bytes32 id) internal view returns (uint256 escA, uint256 escB) {
        (, , , , escA, escB, , , , , , , , , , , , , ) = zk.tables(id);
    }

    function _keys(bytes32 id) internal view returns (address kA, address kB) {
        (, , kA, kB, , , , , , , , , , , , , , , ) = zk.tables(id);
    }

    function _disputeMeta(bytes32 id) internal view returns (uint8 disputant, uint8 demandKind, uint32 demandSlot) {
        (, , , , , , , , , , , , , disputant, demandKind, demandSlot, , , ) = zk.tables(id);
    }

    function _checkpointMeta(bytes32 id) internal view returns (uint64 checkpointNonce, bool hasCheckpoint) {
        (, , , , , , , , , , checkpointNonce, hasCheckpoint, , , , , , , ) = zk.tables(id);
    }

    /// A3: the recorded decided-ness/winner captured by openDispute, consumed by resolveTimeout.
    function _disputeResult(bytes32 id) internal view returns (bool decided, uint8 winner) {
        (, , , , , , , , , , , , , , , , decided, winner, ) = zk.tables(id);
    }

    function _totalEscrow(bytes32 id) internal view returns (uint256 total) {
        (uint256 escA, uint256 escB) = _escrows(id);
        total = escA + escB;
    }

    /// A trivially-conserving state for dispute-machine tests that don't care about
    /// the exact balance split: everything sits with B, pot 0.
    function _conservingState(bytes32 id) internal view returns (ChannelState memory s) {
        s = _emptyState(id);
        s.balanceB = _totalEscrow(id);
    }

    /// create(A) + join(B) using the default channelKey == address(0) (keyA/keyB ==
    /// the wallet addresses), co-signing with the wallet private keys.
    function _createJoin(uint256 escrowA, uint256 stake) internal returns (bytes32 tableId) {
        vm.prank(a);
        tableId = zk.create{value: escrowA}(IGameRules(address(rules)), stake, CLOCK, address(0), ZERO_DECK);
        vm.prank(b);
        zk.join{value: stake}(tableId, address(0), ZERO_DECK);
    }

    /// create(A) + join(B) using DEDICATED channel signing keys (keyA/keyB != the
    /// wallet addresses), so tests can drive `_seatOf`'s `who == t.keyA/keyB` arm and
    /// co-sign with the dedicated keys.
    function _createJoinWithChannelKeys(uint256 escrowA, uint256 stake) internal returns (bytes32 tableId) {
        vm.prank(a);
        tableId = zk.create{value: escrowA}(IGameRules(address(rules)), stake, CLOCK, keyA, ZERO_DECK);
        vm.prank(b);
        zk.join{value: stake}(tableId, keyB, ZERO_DECK);
    }

    function _deck208() internal pure returns (uint256[] memory deck) {
        deck = new uint256[](208);
        for (uint256 i = 0; i < 208; i++) deck[i] = i + 1;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // create()
    // ═══════════════════════════════════════════════════════════════════════

    function test_create_revertsWrongValue_zero() public {
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.WrongValue.selector);
        zk.create{value: 0}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
    }

    function test_create_revertsBadRules_noCode() public {
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadRules.selector);
        zk.create{value: 1 ether}(IGameRules(stranger), 1 ether, CLOCK, address(0), ZERO_DECK);
    }

    function test_create_defaultChannelKeyIsSender() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        (address kA, ) = _keys(id);
        assertEq(kA, a, "channelKey==0 => keyA==sender");
    }

    function test_create_customChannelKey() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, keyA, ZERO_DECK);
        (address kA, ) = _keys(id);
        assertEq(kA, keyA, "custom channelKey honored");
    }

    function test_create_emitsTableCreated() public {
        vm.expectEmit(false, true, false, true);
        emit TableCreated(bytes32(0), a, address(rules), 1 ether, 2 ether, CLOCK);
        vm.prank(a);
        zk.create{value: 1 ether}(IGameRules(address(rules)), 2 ether, CLOCK, address(0), ZERO_DECK);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // join()
    // ═══════════════════════════════════════════════════════════════════════

    function test_join_revertsBadStatus_notCreated() public {
        bytes32 id = _createJoin(1 ether, 1 ether); // already Live
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.join{value: 1 ether}(id, address(0), ZERO_DECK);
    }

    function test_join_revertsNotPlayer_selfJoin() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.join{value: 1 ether}(id, address(0), ZERO_DECK);
    }

    function test_join_revertsWrongValue() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.WrongValue.selector);
        zk.join{value: 0.5 ether}(id, address(0), ZERO_DECK);
    }

    function test_join_revertsNotPlayer_keyCollidesWithPlayerA() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.join{value: 1 ether}(id, a, ZERO_DECK); // channelKey == playerA
    }

    function test_join_revertsNotPlayer_keyCollidesWithKeyA() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, keyA, ZERO_DECK);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.join{value: 1 ether}(id, keyA, ZERO_DECK); // channelKey == t.keyA (!= playerA)
    }

    function test_join_defaultChannelKeyIsSender() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        (, address kB) = _keys(id);
        assertEq(kB, b, "channelKey==0 => keyB==sender");
    }

    function test_join_customChannelKeyAndEvent() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        vm.expectEmit(true, true, false, true);
        emit TableJoined(id, b);
        vm.prank(b);
        zk.join{value: 1 ether}(id, keyB, ZERO_DECK);
        (, address kB) = _keys(id);
        assertEq(kB, keyB, "custom channelKey honored");
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // cancel()
    // ═══════════════════════════════════════════════════════════════════════

    function test_cancel_success() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 3 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        uint256 before = a.balance;
        vm.expectEmit(true, false, false, true);
        emit TableCancelled(id);
        vm.prank(a);
        zk.cancel(id);
        assertEq(a.balance - before, 3 ether, "full escrow refunded");
        (uint256 escA, ) = _escrows(id);
        assertEq(escA, 0, "escrowA zeroed");
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Cancelled));
    }

    function test_cancel_revertsBadStatus_live() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.cancel(id);
    }

    function test_cancel_revertsNotPlayer() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancel(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // topUp()
    // ═══════════════════════════════════════════════════════════════════════

    function test_topUp_revertsBadStatus_notLive() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.topUp{value: 1 ether}(id);
    }

    function test_topUp_revertsWrongValue_zero() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.WrongValue.selector);
        zk.topUp{value: 0}(id);
    }

    function test_topUp_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.topUp{value: 1 ether}(id);
    }

    function test_topUp_seatA() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.expectEmit(true, false, false, true);
        emit ToppedUp(id, 1, 0.5 ether);
        vm.prank(a);
        zk.topUp{value: 0.5 ether}(id);
        (uint256 escA, ) = _escrows(id);
        assertEq(escA, 1.5 ether);
    }

    function test_topUp_seatB() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.expectEmit(true, false, false, true);
        emit ToppedUp(id, 2, 0.5 ether);
        vm.prank(b);
        zk.topUp{value: 0.5 ether}(id);
        (, uint256 escB) = _escrows(id);
        assertEq(escB, 1.5 ether);
    }

    function test_topUp_viaChannelKeyIdentity() public {
        // Hits the `who == t.keyA` arm of _seatOf (as opposed to `who == t.playerA`).
        bytes32 id = _createJoinWithChannelKeys(1 ether, 1 ether);
        vm.prank(keyA);
        zk.topUp{value: 1 ether}(id);
        (uint256 escA, ) = _escrows(id);
        assertEq(escA, 2 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // settle()
    // ═══════════════════════════════════════════════════════════════════════

    function test_settle_revertsBadStatus_created() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        ChannelState memory s = _emptyState(id);
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.settle(id, s, sigA, sigB);
    }

    function test_settle_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 2 ether;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.settle(id, s, sigA, sigB);
    }

    function test_settle_revertsWrongTable() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(keccak256("other-table"));
        s.nonce = 1;
        s.balanceA = 2 ether;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.WrongTable.selector);
        zk.settle(id, s, sigA, sigB);
    }

    function test_settle_revertsBadSig_sigA() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 2 ether;
        s.phase = 1;
        // sigA signed with the WRONG key; sigB correct.
        (bytes memory badSigA, bytes memory sigB) = _coSignWith(PK_B, PK_B, s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadSig.selector);
        zk.settle(id, s, badSigA, sigB);
    }

    function test_settle_revertsBadSig_sigB() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 2 ether;
        s.phase = 1;
        // sigA correct; sigB signed with the WRONG key.
        (bytes memory sigA, bytes memory badSigB) = _coSignWith(PK_A, PK_A, s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadSig.selector);
        zk.settle(id, s, sigA, badSigB);
    }

    function test_settle_revertsNotFinal() public {
        rules.setFinalAll(false);
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 2 ether;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.NotFinal.selector);
        zk.settle(id, s, sigA, sigB);
    }

    function test_settle_revertsPotNotZero() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 1 ether;
        s.pot = 1 ether; // conserving (1+1==2), but pot != 0
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.PotNotZero.selector);
        zk.settle(id, s, sigA, sigB);
    }

    /// Round-trips a table through a dispute cycle to establish a checkpoint, then
    /// asserts settle() rejects a stale nonce and accepts a fresher one.
    function test_settle_staleNonceThenSucceedsAboveCheckpoint() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");

        ChannelState memory dispute = _conservingState(id);
        dispute.nonce = 10;
        dispute.gameStateHash = keccak256(gameState);
        (bytes memory dSigA, bytes memory dSigB) = _coSign(dispute);
        vm.prank(a);
        zk.openDispute(id, dispute, dSigA, dSigB, gameState, 1, 0); // checkpointNonce=10

        ChannelState memory resp = _conservingState(id);
        resp.nonce = 20;
        (bytes memory rSigA, bytes memory rSigB) = _coSign(resp);
        vm.prank(b);
        zk.respondWithState(id, resp, rSigA, rSigB); // back to Live, checkpointNonce=20

        // stale: nonce <= 20
        ChannelState memory stale = _emptyState(id);
        stale.nonce = 15;
        stale.balanceA = 2 ether;
        stale.phase = 1;
        (bytes memory sSigA, bytes memory sSigB) = _coSign(stale);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.StaleNonce.selector);
        zk.settle(id, stale, sSigA, sSigB);

        // fresh: nonce > 20 succeeds.
        ChannelState memory fresh = _emptyState(id);
        fresh.nonce = 21;
        fresh.balanceA = 2 ether;
        fresh.phase = 1;
        (bytes memory fSigA, bytes memory fSigB) = _coSign(fresh);
        vm.prank(a);
        zk.settle(id, fresh, fSigA, fSigB);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Settled));
    }

    function test_settle_payoutAllToB() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 0;
        s.balanceB = 2 ether;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.expectEmit(true, false, false, true);
        emit TableSettled(id, 0, 2 ether);
        vm.prank(a);
        zk.settle(id, s, sigA, sigB);
        assertEq(a.balance, beforeA, "A gets nothing");
        assertEq(b.balance - beforeB, 2 ether, "B gets it all");
    }

    function test_settle_payoutAllToA() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 2 ether;
        s.balanceB = 0;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.prank(a);
        zk.settle(id, s, sigA, sigB);
        assertEq(a.balance - beforeA, 2 ether, "A gets it all");
        assertEq(b.balance, beforeB, "B gets nothing");
    }

    function test_settle_viaChannelKeyIdentity() public {
        // Hits the `who == t.keyB` arm of _seatOf via the msg.sender check in settle().
        bytes32 id = _createJoinWithChannelKeys(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 2 ether;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSignWith(PK_KEYA, PK_KEYB, s);
        vm.prank(keyB);
        zk.settle(id, s, sigA, sigB);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Settled));
    }

    function test_stateDigest_isDeterministic() public view {
        ChannelState memory s = _emptyState(keccak256("x"));
        s.nonce = 7;
        bytes32 d1 = zk.stateDigest(s);
        bytes32 d2 = zk.stateDigest(s);
        assertEq(d1, d2);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // disputeSetup()
    // ═══════════════════════════════════════════════════════════════════════

    function test_disputeSetup_revertsBadStatus_notLive() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.disputeSetup(id);
    }

    function test_disputeSetup_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.disputeSetup(id);
    }

    function test_disputeSetup_success_seatA() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.expectEmit(true, false, false, false);
        emit SetupDisputeOpened(id, 1, 0);
        vm.prank(a);
        zk.disputeSetup(id);
        (uint8 disputant, uint8 demandKind, ) = _disputeMeta(id);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Disputed));
        assertEq(disputant, 1);
        assertEq(demandKind, 0);
    }

    function test_disputeSetup_revertsBadDemand_afterCheckpointExists() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.nonce = 1;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0); // sets hasCheckpoint=true

        ChannelState memory resp = _conservingState(id);
        resp.nonce = 2;
        (bytes memory rSigA, bytes memory rSigB) = _coSign(resp);
        vm.prank(b);
        zk.respondWithState(id, resp, rSigA, rSigB); // back to Live, hasCheckpoint stays true

        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.disputeSetup(id);
    }

    /// The v1 "stall before state 0" edge case: setup dispute times out unanswered,
    /// both escrows refund in full (demandKind==0 branch of resolveTimeout).
    function test_disputeSetup_thenTimeout_refundsBoth() public {
        bytes32 id = _createJoin(1 ether, 3 ether); // total escrow = 4 ether
        vm.prank(a);
        zk.disputeSetup(id);

        vm.roll(block.number + CLOCK + 1);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.expectEmit(true, false, false, false);
        emit SetupDisputeRefunded(id);
        zk.resolveTimeout(id);
        assertEq(a.balance - beforeA, 1 ether, "A refunded its own escrow");
        assertEq(b.balance - beforeB, 3 ether, "B refunded its own escrow");
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Settled));
    }

    /// Setup dispute (demandKind==0): ANY co-signed state, even one whose nonce isn't
    /// "newer" than anything, proves liveness and clears it (the `demandKind != 0`
    /// short-circuit skips the staleness check entirely).
    function test_disputeSetup_thenRespondWithState_demandKindZeroSkipsStaleCheck() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(a);
        zk.disputeSetup(id); // hasCheckpoint is false; demandKind == 0

        ChannelState memory s = _conservingState(id);
        s.nonce = 0; // would be "stale" under a nonzero-demand check, but demandKind==0 skips it
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(b);
        zk.respondWithState(id, s, sigA, sigB);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // openDispute()
    // ═══════════════════════════════════════════════════════════════════════

    function test_openDispute_revertsBadStatus_notLive() public {
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        ChannelState memory s = _emptyState(id);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.openDispute(id, s, sigA, sigB, "", 1, 0);
    }

    function test_openDispute_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.openDispute(id, s, sigA, sigB, "", 1, 0);
    }

    function test_openDispute_revertsBadGameState() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256("committed");
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadGameState.selector);
        zk.openDispute(id, s, sigA, sigB, "different-preimage", 1, 0);
    }

    function test_openDispute_revertsBadDemand_invalidKind() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(id, s, sigA, sigB, gameState, 3, 0); // neither MOVE(1) nor SHARE(2)
    }

    function test_openDispute_revertsNotYourTurn() public {
        rules.setTurnMask(1); // only seat A owes
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        // A opens against counterparty B (bit 2), but turnMask==1 => B doesn't owe.
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.NotYourTurn.selector);
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0);
    }

    function test_openDispute_staleNonceBelowCheckpointThenSucceedsAtCheckpoint() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        bytes32 gsHash = keccak256(gameState);

        ChannelState memory first = _conservingState(id);
        first.nonce = 10;
        first.gameStateHash = gsHash;
        (bytes memory f1, bytes memory f2) = _coSign(first);
        vm.prank(a);
        zk.openDispute(id, first, f1, f2, gameState, 1, 0); // checkpointNonce=10

        ChannelState memory resp = _conservingState(id);
        resp.nonce = 20;
        (bytes memory r1, bytes memory r2) = _coSign(resp);
        vm.prank(b);
        zk.respondWithState(id, resp, r1, r2); // back to Live, checkpointNonce=20

        // stale: nonce(15) < checkpoint(20)
        ChannelState memory stale = _conservingState(id);
        stale.nonce = 15;
        stale.gameStateHash = gsHash;
        (bytes memory s1, bytes memory s2) = _coSign(stale);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.StaleNonce.selector);
        zk.openDispute(id, stale, s1, s2, gameState, 1, 0);

        // at checkpoint: nonce(20) is NOT < checkpoint(20) => succeeds.
        ChannelState memory atCp = _conservingState(id);
        atCp.nonce = 20;
        atCp.gameStateHash = gsHash;
        (bytes memory a1, bytes memory a2) = _coSign(atCp);
        vm.prank(a);
        zk.openDispute(id, atCp, a1, a2, gameState, 1, 0);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Disputed));
    }

    function test_openDispute_disputantSeatB() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.expectEmit(true, false, false, true);
        emit DisputeOpened(id, 2, 1, 0, uint64(block.number) + CLOCK);
        vm.prank(b);
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0);
        (uint8 disputant, , ) = _disputeMeta(id);
        assertEq(disputant, 2);
    }

    function test_openDispute_demandShare() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        s.deckCommitment = keccak256("deck"); // a SHARE dispute is over a committed deck
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, 2, 5);
        (, uint8 demandKind, uint32 demandSlot) = _disputeMeta(id);
        assertEq(demandKind, 2);
        assertEq(demandSlot, 5);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // respondWithState()
    // ═══════════════════════════════════════════════════════════════════════

    function _openMoveDispute(bytes32 id, uint64 nonce) internal returns (bytes memory gameState) {
        gameState = abi.encode("gs", nonce);
        ChannelState memory s = _conservingState(id);
        s.nonce = nonce;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0);
    }

    function test_respondWithState_revertsBadStatus_notDisputed() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.respondWithState(id, s, sigA, sigB);
    }

    function test_respondWithState_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openMoveDispute(id, 1);
        ChannelState memory s = _emptyState(id);
        s.nonce = 2;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.respondWithState(id, s, sigA, sigB);
    }

    function test_respondWithState_revertsStaleNonce() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openMoveDispute(id, 5);
        ChannelState memory s = _conservingState(id);
        s.nonce = 5; // not strictly newer than the contested nonce(5)
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.StaleNonce.selector);
        zk.respondWithState(id, s, sigA, sigB);
    }

    function test_respondWithState_succeedsAndEmits() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openMoveDispute(id, 5);
        ChannelState memory s = _conservingState(id);
        s.nonce = 6;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.expectEmit(true, false, false, true);
        emit DisputeAnsweredWithState(id, 6);
        vm.prank(b);
        zk.respondWithState(id, s, sigA, sigB);
        (uint64 checkpointNonce, bool hasCheckpoint) = _checkpointMeta(id);
        (uint8 disputant, uint8 demandKind, ) = _disputeMeta(id);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live));
        assertEq(checkpointNonce, 6);
        assertTrue(hasCheckpoint);
        assertEq(disputant, 0);
        assertEq(demandKind, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // respondWithMove()
    // ═══════════════════════════════════════════════════════════════════════

    function test_respondWithMove_revertsBadStatus_notDisputed() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.respondWithMove(id, "", "");
    }

    function test_respondWithMove_revertsNotDemanded() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        s.deckCommitment = keccak256("deck"); // a SHARE dispute is over a committed deck
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, 2, 0); // SHARE demand, not MOVE
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.NotDemanded.selector);
        zk.respondWithMove(id, gameState, "");
    }

    function test_respondWithMove_revertsNotYourDispute() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDispute(id, 1); // disputant == A
        vm.prank(a); // the disputant itself may not answer its own demand
        vm.expectRevert(ChannelTableBase.NotYourDispute.selector);
        zk.respondWithMove(id, gameState, "");
    }

    function test_respondWithMove_revertsBadGameState() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openMoveDispute(id, 1);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.BadGameState.selector);
        zk.respondWithMove(id, "wrong-preimage", "");
    }

    function test_respondWithMove_appliesMoveReverts() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDispute(id, 1);
        rules.setApply("", true); // applyMove reverts
        vm.prank(b);
        vm.expectRevert(bytes("mock: illegal"));
        zk.respondWithMove(id, gameState, "some-move");
    }

    function test_respondWithMove_succeeds() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDispute(id, 1);
        bytes memory nextState = abi.encode("gs2");
        rules.setApply(nextState, false);
        vm.expectEmit(true, false, false, true);
        emit DisputeAnsweredWithMove(id, "some-move", keccak256(nextState));
        vm.prank(b);
        zk.respondWithMove(id, gameState, "some-move");
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // respondWithShare()
    // ═══════════════════════════════════════════════════════════════════════

    /// Opens a SHARE dispute (disputant A) whose contested state's deckCommitment
    /// matches `_deck208()`, demanding `slot` from B.
    function _openShareDispute(bytes32 id, uint32 slot) internal returns (uint256[] memory deck) {
        deck = _deck208();
        bytes32 commitment = keccak256(abi.encodePacked(deck));
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        s.deckCommitment = commitment;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, 2, slot);
    }

    function test_respondWithShare_revertsBadStatus_notDisputed() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        uint256[] memory deck = _deck208();
        uint256[2] memory reveal;
        uint256[8] memory proof;
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.respondWithShare(id, deck, reveal, proof);
    }

    function test_respondWithShare_revertsNotDemanded() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openMoveDispute(id, 1); // MOVE demand, not SHARE
        uint256[] memory deck = _deck208();
        uint256[2] memory reveal;
        uint256[8] memory proof;
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.NotDemanded.selector);
        zk.respondWithShare(id, deck, reveal, proof);
    }

    function test_respondWithShare_revertsNotYourDispute() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openShareDispute(id, 0); // disputant == A
        uint256[] memory deck = _deck208();
        uint256[2] memory reveal;
        uint256[8] memory proof;
        vm.prank(a); // disputant itself
        vm.expectRevert(ChannelTableBase.NotYourDispute.selector);
        zk.respondWithShare(id, deck, reveal, proof);
    }

    function test_respondWithShare_revertsBadDeck_wrongLength() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openShareDispute(id, 0);
        uint256[] memory shortDeck = new uint256[](207);
        uint256[2] memory reveal;
        uint256[8] memory proof;
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.BadDeck.selector);
        zk.respondWithShare(id, shortDeck, reveal, proof);
    }

    function test_respondWithShare_revertsBadDeck_wrongCommitment() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openShareDispute(id, 0);
        uint256[] memory wrongDeck = _deck208();
        wrongDeck[0] = 999_999; // same length, different commitment
        uint256[2] memory reveal;
        uint256[8] memory proof;
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.BadDeck.selector);
        zk.respondWithShare(id, wrongDeck, reveal, proof);
    }

    /// After the openDispute hardening, an out-of-range SHARE demandSlot is rejected at the trust
    /// boundary (openDispute), so it can never reach respondWithShare — the deep `slot > 51` guard
    /// there is now an unreachable assert. This pins the boundary rejection instead.
    function test_openDispute_rejectsShareSlotTooHigh() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        uint256[] memory deck = _deck208();
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        s.deckCommitment = keccak256(abi.encodePacked(deck));
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(id, s, sigA, sigB, gameState, 2, 52); // slot 52 > 51
    }

    function test_respondWithShare_revertsBadProof_callFails() public {
        RevertingVerifier rv = new RevertingVerifier();
        rules.setRevealVerifier(address(rv));
        bytes32 id = _createJoin(1 ether, 1 ether);
        uint256[] memory deck = _openShareDispute(id, 0);
        uint256[2] memory reveal;
        uint256[8] memory proof;
        vm.prank(b);
        vm.expectRevert(ZkTable.BadProof.selector);
        zk.respondWithShare(id, deck, reveal, proof);
    }

    function test_respondWithShare_revertsBadProof_shortReturn() public {
        ShortReturnVerifier sv = new ShortReturnVerifier();
        rules.setRevealVerifier(address(sv));
        bytes32 id = _createJoin(1 ether, 1 ether);
        uint256[] memory deck = _openShareDispute(id, 0);
        uint256[2] memory reveal;
        uint256[8] memory proof;
        vm.prank(b);
        vm.expectRevert(ZkTable.BadProof.selector);
        zk.respondWithShare(id, deck, reveal, proof);
    }

    function test_respondWithShare_revertsBadProof_falseResult() public {
        MockRevealVerifier mv = new MockRevealVerifier();
        mv.setOk(false);
        rules.setRevealVerifier(address(mv));
        bytes32 id = _createJoin(1 ether, 1 ether);
        uint256[] memory deck = _openShareDispute(id, 0);
        uint256[2] memory reveal;
        uint256[8] memory proof;
        vm.prank(b);
        vm.expectRevert(ZkTable.BadProof.selector);
        zk.respondWithShare(id, deck, reveal, proof);
    }

    function test_respondWithShare_succeeds() public {
        MockRevealVerifier mv = new MockRevealVerifier(); // ok == true by default
        rules.setRevealVerifier(address(mv));
        bytes32 id = _createJoin(1 ether, 1 ether);
        uint256[] memory deck = _openShareDispute(id, 3);
        uint256[2] memory reveal = [uint256(11), uint256(22)];
        uint256[8] memory proof;
        vm.expectEmit(true, false, false, true);
        emit DisputeAnsweredWithShare(id, 3, 11, 22);
        vm.prank(b);
        zk.respondWithShare(id, deck, reveal, proof);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // resolveTimeout()
    // ═══════════════════════════════════════════════════════════════════════

    function test_resolveTimeout_revertsBadStatus_notDisputed() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.resolveTimeout(id);
    }

    function test_resolveTimeout_revertsClockNotExpired() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _openMoveDispute(id, 1);
        vm.expectRevert(ChannelTableBase.ClockNotExpired.selector);
        zk.resolveTimeout(id); // still within the window
    }

    /// The MOVE/SHARE branch of resolveTimeout with B as the disputant (the pot
    /// lands on `toB`, the complement of the existing A-disputant fuzz coverage).
    function test_resolveTimeout_disputantB_getsPot() public {
        bytes32 id = _createJoin(1 ether, 3 ether); // total = 4 ether
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _emptyState(id);
        s.balanceA = 1 ether;
        s.balanceB = 1 ether;
        s.pot = 2 ether;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(b); // B is the disputant this time
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0);

        vm.roll(block.number + CLOCK + 1);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.expectEmit(true, false, false, true);
        emit DisputeForfeited(id, 2, 1 ether, 3 ether);
        zk.resolveTimeout(id);
        assertEq(a.balance - beforeA, 1 ether, "A gets only its balance");
        assertEq(b.balance - beforeB, 3 ether, "B (disputant) gets balance + pot");
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Settled));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // A3 fix: FLIP_DONE theft — resolveTimeout must pay the recorded winner at a
    // decided terminal state, not whichever seat happened to open the dispute.
    // ═══════════════════════════════════════════════════════════════════════

    /// THE regression test. At a decided state (winner = seat A), the LOSER (seat B)
    /// opens a MOVE dispute the winner cannot answer (mirrors HiLoWarRules.applyMove
    /// reverting on every move at FLIP_DONE) and lets the clock expire. Pre-fix,
    /// resolveTimeout paid the pot to `t.disputant` (B) — the loser stealing the pot.
    /// Post-fix it must pay the recorded winner (A) instead. Confirmed to FAIL before
    /// the resolveTimeout fix (temporarily reverting it flips this to B receiving the
    /// pot and the assertions below fail).
    function test_resolveTimeout_awardsWinner_notDisputant_whenDecided_MOVE() public {
        rules.setResult(true, 1); // decided: seat A (1) won
        bytes32 id = _createJoin(1 ether, 1 ether); // total escrow = 2 ether
        bytes memory gameState = abi.encode("decided-flip-done");
        ChannelState memory s = _emptyState(id);
        s.balanceA = 0.5 ether;
        s.balanceB = 0.5 ether;
        s.pot = 1 ether; // conserves: 0.5+0.5+1 == 2
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        // B is the LOSER of the decided hand, yet opens the dispute — the attack.
        vm.prank(b);
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0); // DEMAND_MOVE

        (bool decided, uint8 winner) = _disputeResult(id);
        assertTrue(decided, "dispute recorded the state as decided");
        assertEq(winner, 1, "recorded winner is seat A");

        vm.roll(block.number + CLOCK + 1);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.expectEmit(true, false, false, true);
        emit DisputeForfeited(id, 1, 1.5 ether, 0.5 ether);
        zk.resolveTimeout(id);
        assertEq(a.balance - beforeA, 1.5 ether, "recorded winner A gets balance + pot");
        assertEq(b.balance - beforeB, 0.5 ether, "loser/disputant B gets only its own balance");
    }

    /// Same decided-state theft, but the loser opens a SHARE demand instead of MOVE.
    /// Proves the payout is keyed on decided-ness, not demandKind.
    function test_resolveTimeout_awardsWinner_whenDecided_SHARE() public {
        rules.setResult(true, 1); // decided: seat A (1) won
        bytes32 id = _createJoin(1 ether, 1 ether); // total escrow = 2 ether
        bytes memory gameState = abi.encode("decided-flip-done-share");
        ChannelState memory s = _emptyState(id);
        s.balanceA = 0.5 ether;
        s.balanceB = 0.5 ether;
        s.pot = 1 ether;
        s.gameStateHash = keccak256(gameState);
        s.deckCommitment = keccak256("deck"); // required for a SHARE demand
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        vm.prank(b); // loser opens a SHARE demand this time
        zk.openDispute(id, s, sigA, sigB, gameState, 2, 0); // DEMAND_SHARE

        vm.roll(block.number + CLOCK + 1);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.expectEmit(true, false, false, true);
        emit DisputeForfeited(id, 1, 1.5 ether, 0.5 ether);
        zk.resolveTimeout(id);
        assertEq(a.balance - beforeA, 1.5 ether, "recorded winner A gets balance + pot even under a SHARE demand");
        assertEq(b.balance - beforeB, 0.5 ether, "loser/disputant B gets only its own balance");
    }

    /// An UNDECIDED contested state (e.g. a war/tie FLIP_DONE, or any non-terminal
    /// phase) preserves the original forfeit-to-disputant behavior — the lever that
    /// forces a reveal/move stays intact when there is no recorded winner to pay.
    function test_resolveTimeout_forfeitsToDisputant_whenUndecided() public {
        rules.setResult(false, 0); // explicit: undecided
        bytes32 id = _createJoin(1 ether, 1 ether); // total escrow = 2 ether
        bytes memory gameState = abi.encode("undecided-state");
        ChannelState memory s = _emptyState(id);
        s.balanceA = 0.5 ether;
        s.balanceB = 0.5 ether;
        s.pot = 1 ether;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        vm.prank(a); // A opens (and will be forfeited the pot, undecided path)
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0);

        (bool decided, ) = _disputeResult(id);
        assertFalse(decided, "undecided state recorded as such");

        vm.roll(block.number + CLOCK + 1);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.expectEmit(true, false, false, true);
        emit DisputeForfeited(id, 1, 1.5 ether, 0.5 ether);
        zk.resolveTimeout(id);
        assertEq(a.balance - beforeA, 1.5 ether, "disputant A forfeits the pot to itself (undecided)");
        assertEq(b.balance - beforeB, 0.5 ether, "B gets only its own balance");
    }

    /// A rules contract that reports decided=true with a winner outside {1,2} is a
    /// broken/malicious IGameRules implementation; openDispute must reject it rather
    /// than let resolveTimeout later pay a nonsensical seat.
    function test_openDispute_revertsBadWinnerRange() public {
        rules.setResult(true, 3); // decided, but winner not in {1, 2}
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadGameState.selector);
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0);
    }

    /// End-to-end with the REAL HiLoWarRules contract (not the mock): drive an actual
    /// hand to a decided FLIP_DONE via a genuine MOVE_FOLD (raiser A, non-raiser B
    /// folds -> A wins), have the LOSER (B) open the dispute HiLoWarRules.applyMove
    /// can never answer at FLIP_DONE, let the clock expire, and confirm the pot goes
    /// to the recorded winner (A), not the disputing loser (B).
    function test_resolveTimeout_realHiLoWar_paysWinner_notLoserDisputant() public {
        HiLoWarRules hiloRules = new HiLoWarRules(address(0xBEEF), address(0xCAFE));
        vm.prank(a);
        bytes32 id = zk.create{value: 1 ether}(IGameRules(address(hiloRules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        vm.prank(b);
        zk.join{value: 1 ether}(id, address(0), ZERO_DECK);

        // A real hand at CALL_OR_FOLD: A raised, B (non-raiser) folds -> A wins the pot.
        HiLo memory hs;
        hs.phase = HiLoCodec.PHASE_CALL_OR_FOLD;
        hs.raiser = HiLoCodec.SEAT_A;
        bytes memory finalGameState = hiloRules.applyMove(abi.encode(hs), HiLoCodec.fold(HiLoCodec.SEAT_B));
        HiLo memory fin = abi.decode(finalGameState, (HiLo));
        assertEq(fin.phase, HiLoCodec.PHASE_FLIP_DONE, "fold reaches FLIP_DONE");
        assertTrue(fin.resultSet, "fold decides the hand");
        assertEq(fin.resultWinner, HiLoCodec.SEAT_A, "raiser A wins on the non-raiser's fold");

        ChannelState memory s = _emptyState(id);
        s.phase = HiLoCodec.PHASE_FLIP_DONE;
        s.balanceA = 0.5 ether;
        s.balanceB = 0.5 ether;
        s.pot = 1 ether; // conserves 0.5+0.5+1 == escrowA+escrowB (2 ether)
        s.gameStateHash = hiloRules.hashGameState(finalGameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        // B is the loser; it opens a MOVE demand that HiLoWarRules.applyMove can never
        // satisfy at FLIP_DONE (it reverts WrongPhase for every move there) — the theft.
        vm.prank(b);
        zk.openDispute(id, s, sigA, sigB, finalGameState, 1, 0);

        vm.roll(block.number + CLOCK + 1);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.resolveTimeout(id);
        assertEq(a.balance - beforeA, 1.5 ether, "real winner A gets balance + pot");
        assertEq(b.balance - beforeB, 0.5 ether, "loser/disputant B gets only its own balance, pot denied");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Top-up freeze fix: an un-acknowledged unilateral top-up must never
    // permanently lock the escrows. topUp records a pending claim with a
    // clockBlocks deadline; acceptance of ANY co-signed state (which must
    // conserve the increased total) acknowledges and cancels it; otherwise the
    // top-upper reclaims exactly their own pending amount after the deadline.
    // ═══════════════════════════════════════════════════════════════════════

    /// THE freeze-regression test. Reproduces the exact fund-lock: a Live table with a
    /// checkpoint (so disputeSetup is closed), a co-signed latest state conserving the
    /// old total, then a unilateral top-up the counterparty never countersigns. Pre-fix:
    /// settle/openDispute revert ConservationViolated, disputeSetup reverts BadDemand —
    /// both escrows frozen forever. Post-fix: after the reclaim clock, the top-upper
    /// claws back exactly the un-acknowledged top-up, the old co-signed state conserves
    /// again, and BOTH seats exit with their exact funds; zero wei left in the contract.
    /// Confirmed to FAIL pre-fix (with reclaimTopUp stubbed to a revert, the recovery
    /// half of this test dies at the reclaim call — the table is unrecoverable).
    function test_topUp_thenCounterpartyStonewalls_fundsRecoverable() public {
        bytes32 id = _createJoin(1 ether, 1 ether); // total = 2 ether
        bytes memory gameState = abi.encode("gs");

        // Run one dispute cycle so hasCheckpoint == true (disputeSetup is then BadDemand).
        ChannelState memory d = _conservingState(id);
        d.nonce = 10;
        d.gameStateHash = keccak256(gameState);
        (bytes memory dA, bytes memory dB) = _coSign(d);
        vm.prank(a);
        zk.openDispute(id, d, dA, dB, gameState, 1, 0);
        ChannelState memory r = _conservingState(id);
        r.nonce = 20;
        (bytes memory rA, bytes memory rB) = _coSign(r);
        vm.prank(b);
        zk.respondWithState(id, r, rA, rB); // Live again, checkpointNonce = 20

        // The parties' co-signed LATEST state, conserving the 2-ether total.
        ChannelState memory latest = _emptyState(id);
        latest.nonce = 21;
        latest.balanceA = 0.8 ether;
        latest.balanceB = 1.2 ether;
        latest.phase = 1; // final under MockGameRules
        latest.gameStateHash = keccak256(gameState);
        (bytes memory lA, bytes memory lB) = _coSign(latest);

        // The griefing top-up: A unilaterally adds 0.5 ether; B countersigns nothing new.
        vm.prank(a);
        zk.topUp{value: 0.5 ether}(id);
        (uint256 pend, uint64 deadline) = zk.pendingTopUps(id, 1);
        assertEq(pend, 0.5 ether, "pending top-up recorded");
        assertEq(deadline, uint64(block.number) + CLOCK, "reclaim deadline = now + clockBlocks");

        // ── the freeze, exactly as pre-fix: every door is shut ──
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.ConservationViolated.selector);
        zk.settle(id, latest, lA, lB);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.ConservationViolated.selector);
        zk.openDispute(id, latest, lA, lB, gameState, 1, 0);
        vm.prank(b);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.disputeSetup(id);
        // and the reclaim clock has not run yet:
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.ClockNotExpired.selector);
        zk.reclaimTopUp(id);

        // ── the recovery path (does not exist pre-fix) ──
        vm.roll(block.number + CLOCK + 1);
        uint256 beforeA = a.balance;
        vm.expectEmit(true, false, false, true);
        emit TopUpReclaimed(id, 1, 0.5 ether);
        vm.prank(a);
        zk.reclaimTopUp(id);
        assertEq(a.balance - beforeA, 0.5 ether, "A reclaims exactly the un-acknowledged top-up");
        (uint256 escA, uint256 escB) = _escrows(id);
        assertEq(escA, 1 ether, "escrowA back to the conserved base");
        assertEq(escB, 1 ether, "escrowB untouched");

        // The old co-signed state conserves again: either seat settles unilaterally.
        beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.prank(b); // even the stonewalled counterparty can drive the exit
        zk.settle(id, latest, lA, lB);
        assertEq(a.balance - beforeA, 0.8 ether, "A exits with its co-signed balance");
        assertEq(b.balance - beforeB, 1.2 ether, "B exits with its co-signed balance");
        assertEq(address(zk).balance, 0, "zero residue: every escrowed wei paid out");
    }

    /// Cooperative path unchanged: a top-up reflected in a newer co-signed state settles
    /// exactly as before the fix — full increased total paid out, pending claim cancelled
    /// by the settle itself, zero residue.
    function test_topUp_acknowledged_settlesNormally() public {
        bytes32 id = _createJoin(1 ether, 1 ether); // base total = 2 ether
        vm.prank(a);
        zk.topUp{value: 0.5 ether}(id); // total = 2.5 ether

        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 1.7 ether;
        s.balanceB = 0.8 ether; // conserves 2.5
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.prank(a);
        zk.settle(id, s, sigA, sigB);
        assertEq(a.balance - beforeA, 1.7 ether, "A paid from the increased total");
        assertEq(b.balance - beforeB, 0.8 ether, "B paid from the increased total");
        assertEq(address(zk).balance, 0, "full 2.5 ether left the contract");
        (uint256 pend, ) = zk.pendingTopUps(id, 1);
        assertEq(pend, 0, "no leftover pending claim after an acknowledging settle");
    }

    /// No double-spend: once ANY co-signed state conserving the increased total is
    /// accepted on-chain (here via openDispute + respondWithState), the top-up is part
    /// of the conserved pot and can NEVER also be reclaimed — even after the deadline.
    /// The final settle then pays out the full increased total exactly once.
    function test_reclaim_deniedAfterAcknowledgment_noDoubleSpend() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(a);
        zk.topUp{value: 0.5 ether}(id); // total = 2.5, pending(A) = 0.5
        bytes memory gameState = abi.encode("gs");

        // B countersigns a post-top-up state; A checkpoints it via openDispute.
        ChannelState memory s = _conservingState(id); // conserves 2.5 (current escrow)
        s.nonce = 1;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, 1, 0);
        (uint256 pend, ) = zk.pendingTopUps(id, 1);
        assertEq(pend, 0, "acceptance of a conserving co-signed state acknowledges the top-up");

        // Clear the dispute and let the reclaim clock run out anyway.
        ChannelState memory resp = _conservingState(id);
        resp.nonce = 2;
        (bytes memory rA, bytes memory rB) = _coSign(resp);
        vm.prank(b);
        zk.respondWithState(id, resp, rA, rB);
        vm.roll(block.number + CLOCK + 100);

        vm.prank(a);
        vm.expectRevert(ZkTable.NothingToReclaim.selector);
        zk.reclaimTopUp(id); // the acknowledged top-up is unreclaimable forever

        // The acknowledged total settles exactly once, in full.
        ChannelState memory fin = _emptyState(id);
        fin.nonce = 3;
        fin.balanceA = 1.25 ether;
        fin.balanceB = 1.25 ether;
        fin.phase = 1;
        (bytes memory fA, bytes memory fB) = _coSign(fin);
        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.prank(a);
        zk.settle(id, fin, fA, fB);
        assertEq(a.balance - beforeA, 1.25 ether);
        assertEq(b.balance - beforeB, 1.25 ether);
        assertEq(address(zk).balance, 0, "top-up paid out exactly once (settled, not reclaimed)");
    }

    /// Reclaim pays each seat exactly its OWN pending amount and nothing more: a second
    /// reclaim finds nothing, a seat with no pending gets NothingToReclaim (B cannot
    /// touch A's pending), and a stranger is NotPlayer.
    function test_reclaim_cannotExceedOwnPending() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(a);
        zk.topUp{value: 0.3 ether}(id);
        vm.prank(b);
        zk.topUp{value: 0.7 ether}(id); // escrow = (1.3, 1.7)
        vm.roll(block.number + CLOCK + 1);

        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.reclaimTopUp(id);

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        vm.prank(a);
        zk.reclaimTopUp(id);
        assertEq(a.balance - beforeA, 0.3 ether, "A gets exactly its own pending, not B's");
        vm.prank(a);
        vm.expectRevert(ZkTable.NothingToReclaim.selector);
        zk.reclaimTopUp(id); // nothing left to take on a second call
        vm.prank(b);
        zk.reclaimTopUp(id);
        assertEq(b.balance - beforeB, 0.7 ether, "B gets exactly its own pending");
        (uint256 escA, uint256 escB) = _escrows(id);
        assertEq(escA, 1 ether, "base escrow untouchable via reclaim");
        assertEq(escB, 1 ether, "base escrow untouchable via reclaim");
    }

    /// Deadline boundary: at block == deadline reclaim still reverts (mirrors the
    /// dispute clock's `<=` semantics); the first reclaimable block is deadline + 1.
    /// A later top-up accumulates the pending amount and refreshes the shared deadline.
    function test_reclaim_deadlineBoundary_andAccumulation() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(a);
        zk.topUp{value: 0.3 ether}(id);
        (, uint64 dl1) = zk.pendingTopUps(id, 1);

        vm.roll(uint256(dl1)); // exactly AT the deadline: not yet
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.ClockNotExpired.selector);
        zk.reclaimTopUp(id);

        // second top-up: amount accumulates, deadline refreshes forward
        vm.prank(a);
        zk.topUp{value: 0.2 ether}(id);
        (uint256 pend, uint64 dl2) = zk.pendingTopUps(id, 1);
        assertEq(pend, 0.5 ether, "pending accumulates across top-ups");
        assertEq(dl2, uint64(block.number) + CLOCK, "deadline refreshed by the later top-up");
        assertGt(dl2, dl1, "refreshed deadline is strictly later");

        vm.roll(uint256(dl1) + 1); // past the OLD deadline but not the refreshed one
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.ClockNotExpired.selector);
        zk.reclaimTopUp(id);

        vm.roll(uint256(dl2) + 1); // first reclaimable block
        uint256 beforeA = a.balance;
        vm.prank(a);
        zk.reclaimTopUp(id);
        assertEq(a.balance - beforeA, 0.5 ether, "full accumulated pending reclaimed at once");
    }

    /// Pending top-up + setup dispute (the only way to be Disputed with a live pending
    /// claim, since openDispute's acceptance clears it): reclaim is blocked while
    /// Disputed, but the setup-timeout refund returns every wei — including the pending
    /// top-up — to its own seat. No state where the pending amount is stuck or stolen.
    function test_reclaim_blockedWhileDisputed_setupTimeoutRefundsTopUp() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        vm.prank(a);
        zk.topUp{value: 0.5 ether}(id); // escrow = (1.5, 1)
        vm.prank(b);
        zk.disputeSetup(id); // no checkpoint exists -> allowed; table now Disputed

        vm.roll(block.number + CLOCK + 1); // past BOTH the reclaim and dispute clocks
        vm.prank(a);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.reclaimTopUp(id); // reclaim never fires while Disputed

        uint256 beforeA = a.balance;
        uint256 beforeB = b.balance;
        zk.resolveTimeout(id); // setup-dispute timeout: full per-seat refund
        assertEq(a.balance - beforeA, 1.5 ether, "A refunded base escrow + its pending top-up");
        assertEq(b.balance - beforeB, 1 ether, "B refunded its base escrow");
        assertEq(address(zk).balance, 0, "conservation: nothing created or destroyed");
    }
}

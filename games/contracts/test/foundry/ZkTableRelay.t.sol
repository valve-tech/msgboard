// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {SignedIntentBase} from "../../contracts/zk/SignedIntentBase.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelState, ChannelStateLib} from "../../contracts/zk/ChannelState.sol";
import {IGameRules} from "../../contracts/zk/IGameRules.sol";
import {MockGameRules} from "../../contracts/test/MockGameRules.sol";
import {MockRevealVerifier} from "../../contracts/test/MockRevealVerifier.sol";
import {MockX402} from "../../contracts/test/MockX402.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {X402AuthLib} from "./X402AuthLib.sol";

/// @notice FUND-CRITICAL coverage for ZkTable's signed-intent relay (2026-08 pass): every `*For`
/// entrypoint plus the Part-1 permissionless carve-out (respondWithShare/postShowdownReveals,
/// covered primarily in ZkTableUnit.t.sol / ZkTableShowdownUnit.t.sol / ZkTableShowdownDispute.t.sol
/// — this file focuses on the SignedIntentBase-backed `*For` family). The #1 risk under test
/// throughout is a RELAYER IMPERSONATING A SEAT: every test that submits via `relayer` asserts
/// the relayer's own token balance never moves and that dispute/payout identity always keys off
/// the RECOVERED SIGNER, never `msg.sender`.
contract ZkTableRelayTest is Test {
    using ChannelStateLib for ChannelState;

    ZkTable internal zk;
    MockGameRules internal rules;
    MockX402 internal token;

    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    uint256 internal constant PK_STRANGER = 0x5717A;
    uint256 internal constant PK_KEYA = 0x5E55A; // dedicated channel-signing key, != wallet a
    address internal a;
    address internal b;
    address internal stranger;
    address internal keyA;
    // Throwaway relayer EOA: NEVER a seat on any table in this file, and NEVER the destination
    // of any payout — every happy-path assertion below checks its balance stays put.
    address internal relayer = address(0xBEEF);

    uint64 internal constant CLOCK = 30; // MIN_CLOCK_BLOCKS
    uint256[2] internal ZERO_DECK = [uint256(0), uint256(0)];
    uint64 internal constant VALID_BEFORE = type(uint64).max;
    uint64 internal constant FAR_DEADLINE = type(uint64).max;

    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHARE = 2;
    uint8 internal constant DEMAND_SHOWDOWN = 3;

    function setUp() public {
        zk = new ZkTable(address(0)); // factory=0: unit-test funding via a bare MockX402
        rules = new MockGameRules();
        token = new MockX402();
        a = vm.addr(PK_A);
        b = vm.addr(PK_B);
        stranger = vm.addr(PK_STRANGER);
        keyA = vm.addr(PK_KEYA);
        token.mint(a, 1_000_000 ether);
        token.mint(b, 1_000_000 ether);
    }

    // ── x402 deposit-auth helpers (mirrors ZkTableUnit.t.sol / ZkTableX402.t.sol) ──────────────

    function _authFor(uint256 pk, address from, uint256 value, bytes32 nonce) internal returns (ZkTable.DepositAuth memory) {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, VALID_BEFORE, nonce);
        return ZkTable.DepositAuth({from: from, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    function _create(uint256 pk, address from, uint256 buyIn, IGameRules rules_, uint256 stake, uint64 clock, address channelKey, uint256[2] memory deckKey)
        internal
        returns (bytes32 tableId)
    {
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), rules_, buyIn, stake, clock, channelKey, deckKey, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(pk, from, buyIn, nonce);
        vm.prank(from);
        tableId = zk.create(IX402Token(address(token)), buyIn, rules_, stake, clock, channelKey, deckKey, auth);
    }

    function _join(uint256 pk, address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey) internal {
        bytes32 nonce = zk.joinNonce(tableId, from, channelKey, deckKey);
        ZkTable.DepositAuth memory auth = _authFor(pk, from, stake, nonce);
        vm.prank(from);
        zk.join(tableId, channelKey, deckKey, auth);
    }

    function _topUp(uint256 pk, address from, bytes32 tableId, uint256 amount) internal {
        bytes32 nonce = zk.topUpNonce(tableId, from, amount, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(pk, from, amount, nonce);
        vm.prank(from);
        zk.topUp(tableId, amount, auth);
    }

    /// create(A) + join(B) with the default channelKey == address(0) (keyA/keyB == the wallets).
    function _createJoin(uint256 escrowA, uint256 stake) internal returns (bytes32 tableId) {
        tableId = _create(PK_A, a, escrowA, IGameRules(address(rules)), stake, CLOCK, address(0), ZERO_DECK);
        _join(PK_B, b, tableId, stake, address(0), ZERO_DECK);
    }

    /// create(A) with a DEDICATED channel-signing key (keyA != wallet a) — used by the
    /// impersonation test proving a channel key alone cannot authorize a wallet-only `cancelFor`.
    function _createWithChannelKey() internal returns (bytes32 tableId) {
        tableId = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, keyA, ZERO_DECK);
    }

    // ── generic signing ─────────────────────────────────────────────────────────────────────

    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        return X402AuthLib.sign65(pk, digest);
    }

    // ── table readbacks (narrow, viaIR stack-depth reasons — mirrors ZkTableUnit.t.sol) ────────

    function _status(bytes32 id) internal view returns (ChannelTableBase.Status status) {
        (, , , , , , , , , status, , , , , , , , , ) = zk.tables(id);
    }

    function _escrows(bytes32 id) internal view returns (uint256 escA, uint256 escB) {
        (, , , , escA, escB, , , , , , , , , , , , , ) = zk.tables(id);
    }

    function _players(bytes32 id) internal view returns (address pA, address pB) {
        (pA, pB, , , , , , , , , , , , , , , , , ) = zk.tables(id);
    }

    function _disputeMeta(bytes32 id) internal view returns (uint8 disputant, uint8 demandKind, uint32 demandSlot) {
        (, , , , , , , , , , , , , disputant, demandKind, demandSlot, , , ) = zk.tables(id);
    }

    function _checkpointMeta(bytes32 id) internal view returns (uint64 checkpointNonce, bool hasCheckpoint) {
        (, , , , , , , , , , checkpointNonce, hasCheckpoint, , , , , , , ) = zk.tables(id);
    }

    function _totalEscrow(bytes32 id) internal view returns (uint256 total) {
        (uint256 eA, uint256 eB) = _escrows(id);
        total = eA + eB;
    }

    function _emptyState(bytes32 tableId) internal pure returns (ChannelState memory s) {
        s.tableId = tableId;
        s.nonce = 0;
        s.deckCommitment = bytes32(0);
        s.phase = 0;
        s.gameStateHash = bytes32(0);
    }

    function _conservingState(bytes32 id) internal view returns (ChannelState memory s) {
        s = _emptyState(id);
        s.balanceB = _totalEscrow(id);
    }

    function _coSign(ChannelState memory s) internal view returns (bytes memory sigA, bytes memory sigB) {
        bytes32 digest = zk.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK_A, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK_B, digest);
        sigA = abi.encodePacked(r1, s1, v1);
        sigB = abi.encodePacked(r2, s2, v2);
    }

    /// Opens a MOVE dispute DIRECTLY (disputant A) — used as fixture setup by tests that relay
    /// the ANSWER (respondWithMoveFor) rather than the open.
    function _openMoveDisputeDirect(bytes32 id, uint64 nonce) internal returns (bytes memory gameState) {
        gameState = abi.encode("gs", nonce);
        ChannelState memory s = _conservingState(id);
        s.nonce = nonce;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a);
        zk.openDispute(id, s, sigA, sigB, gameState, DEMAND_MOVE, 0);
    }

    // ── per-intent sign helpers ─────────────────────────────────────────────────────────────

    function _signDisputeSetup(uint256 pk, bytes32 tableId, uint256 nonce, uint64 deadline) internal returns (bytes memory) {
        return _sig(pk, zk.disputeSetupIntentDigest(tableId, nonce, deadline));
    }

    function _signOpenDispute(
        uint256 pk,
        bytes32 tableId,
        bytes32 stateHash,
        uint8 demandKind,
        uint32 demandSlot,
        uint256 nonce,
        uint64 deadline
    ) internal returns (bytes memory) {
        return _sig(pk, zk.openDisputeIntentDigest(tableId, stateHash, demandKind, demandSlot, nonce, deadline));
    }

    function _signRespondMove(uint256 pk, bytes32 tableId, bytes32 gameStateHash, bytes32 moveHash, uint256 nonce, uint64 deadline)
        internal
        returns (bytes memory)
    {
        return _sig(pk, zk.respondWithMoveIntentDigest(tableId, gameStateHash, moveHash, nonce, deadline));
    }

    function _signReclaimTopUp(uint256 pk, bytes32 tableId, uint256 nonce, uint64 deadline) internal returns (bytes memory) {
        return _sig(pk, zk.reclaimTopUpIntentDigest(tableId, nonce, deadline));
    }

    function _signCancel(uint256 pk, bytes32 tableId, uint256 nonce, uint64 deadline) internal returns (bytes memory) {
        return _sig(pk, zk.cancelIntentDigest(tableId, nonce, deadline));
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 1. Happy relay — every `*For`, submitted by a throwaway relayer, matches the direct path
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_happyRelay_disputeSetupFor() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_A, id, 0, FAR_DEADLINE);

        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.disputeSetupFor(id, 0, FAR_DEADLINE, sig);

        (uint8 disputant, uint8 demandKind, ) = _disputeMeta(id);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Disputed));
        assertEq(disputant, 1, "disputant keyed to the SIGNER (A), not the relayer");
        assertEq(demandKind, 0);
        assertEq(zk.relayNonces(a), 1, "signer's nonce burned");
        assertEq(token.balanceOf(relayer), relayerBefore, "relayer balance untouched");
    }

    function test_happyRelay_openDisputeFor() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(PK_B, id, stateHash, DEMAND_MOVE, 0, 0, FAR_DEADLINE);

        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.openDisputeFor(id, s, sigA, sigB, gameState, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);

        (uint8 disputant, uint8 demandKind, ) = _disputeMeta(id);
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Disputed));
        assertEq(disputant, 2, "disputant keyed to the SIGNER (B), not the relayer");
        assertEq(demandKind, DEMAND_MOVE);
        assertEq(zk.relayNonces(b), 1);
        assertEq(token.balanceOf(relayer), relayerBefore);
    }

    function test_happyRelay_respondWithMoveFor() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 1); // disputant = A (direct)
        bytes memory move = "some-move";
        bytes memory nextState = abi.encode("gs2");
        rules.setApply(nextState, false);

        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256(move);
        bytes memory sig = _signRespondMove(PK_B, id, gameStateHash, moveHash, 0, FAR_DEADLINE);

        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.respondWithMoveFor(id, gameState, move, 0, FAR_DEADLINE, sig);

        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live), "dispute cleared by B's signed answer");
        assertEq(zk.relayNonces(b), 1);
        assertEq(token.balanceOf(relayer), relayerBefore);
    }

    function test_happyRelay_reclaimTopUpFor() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _topUp(PK_A, a, id, 0.3 ether);
        vm.roll(block.number + CLOCK + 1); // reclaim clock expired, never acknowledged

        bytes memory sig = _signReclaimTopUp(PK_A, id, 0, FAR_DEADLINE);
        uint256 beforeA = token.balanceOf(a);
        uint256 relayerBefore = token.balanceOf(relayer);

        vm.prank(relayer);
        zk.reclaimTopUpFor(id, 0, FAR_DEADLINE, sig);

        assertEq(token.balanceOf(a) - beforeA, 0.3 ether, "refund lands on the SIGNER's wallet, not the relayer");
        assertEq(token.balanceOf(relayer), relayerBefore, "relayer never touches the reclaimed funds");
        assertEq(zk.relayNonces(a), 1);
    }

    function test_happyRelay_cancelFor() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes memory sig = _signCancel(PK_A, id, 0, FAR_DEADLINE);
        uint256 beforeA = token.balanceOf(a);
        uint256 relayerBefore = token.balanceOf(relayer);

        vm.prank(relayer);
        zk.cancelFor(id, 0, FAR_DEADLINE, sig);

        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Cancelled));
        assertEq(token.balanceOf(a) - beforeA, 1 ether, "refund lands on playerA, not the relayer");
        assertEq(token.balanceOf(relayer), relayerBefore);
        assertEq(zk.relayNonces(a), 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 2. Impersonation
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_impersonation_disputeSetupFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_STRANGER, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.disputeSetupFor(id, 0, FAR_DEADLINE, sig);
    }

    function test_impersonation_openDisputeFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(PK_STRANGER, id, stateHash, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.openDisputeFor(id, s, sigA, sigB, gameState, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);
    }

    function test_impersonation_respondWithMoveFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(PK_STRANGER, id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.respondWithMoveFor(id, gameState, "move", 0, FAR_DEADLINE, sig);
    }

    function test_impersonation_reclaimTopUpFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _topUp(PK_A, a, id, 0.1 ether);
        vm.roll(block.number + CLOCK + 1);
        bytes memory sig = _signReclaimTopUp(PK_STRANGER, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.reclaimTopUpFor(id, 0, FAR_DEADLINE, sig);
    }

    function test_impersonation_cancelFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes memory sig = _signCancel(PK_STRANGER, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancelFor(id, 0, FAR_DEADLINE, sig);
    }

    /// The A3 wallet-only requirement: `cancelFor` signed by a valid CHANNEL KEY (a real `_seatOf`
    /// identity — it co-signs ChannelStates for this exact table) must still revert, because
    /// `cancelFor` checks `signer == t.playerA` directly, never `_seatOf`. A channel key is NOT
    /// sufficient to move the wallet's full escrow via cancel.
    function test_impersonation_cancelFor_channelKeySigner_revertsNotPlayer() public {
        bytes32 id = _createWithChannelKey(); // playerA = a, keyA = keyA (dedicated, != a)
        bytes memory sig = _signCancel(PK_KEYA, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancelFor(id, 0, FAR_DEADLINE, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 3. Tamper matrix — flip each bound field after signing; every cell reverts
    // ═══════════════════════════════════════════════════════════════════════════════════════

    // ── disputeSetupFor: tableId, nonce, deadline ──────────────────────────────────────────

    function test_tamper_disputeSetupFor_tableId() public {
        // distinct buyIn amounts: two create() calls from the SAME signer with identical
        // params would collide on an identical createNonce (see ZkTableX402.t.sol's note)
        bytes32 id1 = _createJoin(1 ether, 1 ether);
        bytes32 id2 = _createJoin(2 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_A, id1, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(); // recovers a garbage signer -> NotPlayer (or occasionally BadNonce)
        zk.disputeSetupFor(id2, 0, FAR_DEADLINE, sig);
    }

    function test_tamper_disputeSetupFor_nonce() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_A, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        // signer becomes garbage; relayNonces[garbage] == 0 != 1 (the tampered value) -> BadNonce,
        // deterministically, regardless of which garbage address gets recovered.
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.disputeSetupFor(id, 1, FAR_DEADLINE, sig);
    }

    function test_tamper_disputeSetupFor_deadline() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_A, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.disputeSetupFor(id, 0, FAR_DEADLINE - 1, sig);
    }

    // ── openDisputeFor: tableId, stateHash (via a different state), demandKind, demandSlot, nonce, deadline

    function _openDisputeForFixture(bytes32 id)
        internal
        view
        returns (ChannelState memory s, bytes memory sigA, bytes memory sigB, bytes memory gameState, bytes32 stateHash)
    {
        gameState = abi.encode("gs");
        s = _conservingState(id);
        s.gameStateHash = keccak256(gameState);
        (sigA, sigB) = _coSign(s);
        stateHash = s.structHashMem();
    }

    function test_tamper_openDisputeFor_tableId() public {
        // distinct buyIn amounts: two create() calls from the SAME signer with identical
        // params would collide on an identical createNonce (see ZkTableX402.t.sol's note)
        bytes32 id1 = _createJoin(1 ether, 1 ether);
        bytes32 id2 = _createJoin(2 ether, 1 ether);
        (ChannelState memory s, , , bytes memory gameState, bytes32 stateHash) = _openDisputeForFixture(id1);
        bytes memory intentSig = _signOpenDispute(PK_A, id1, stateHash, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        // submit against id2 with a state re-pinned to id2 (else _checkCoSigned's tableId guard
        // fires first) — the INTENT was signed for id1, so the recomputed stateHash/tableId
        // combination the relayer must supply for id2 never matches what was signed.
        ChannelState memory s2 = s;
        s2.tableId = id2;
        (bytes memory sigA2, bytes memory sigB2) = _coSign(s2);
        vm.prank(relayer);
        vm.expectRevert();
        zk.openDisputeFor(id2, s2, sigA2, sigB2, gameState, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_stateHash_viaDifferentState() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        (ChannelState memory s, , , bytes memory gameState, bytes32 stateHash) = _openDisputeForFixture(id);
        bytes memory intentSig = _signOpenDispute(PK_A, id, stateHash, DEMAND_MOVE, 0, 0, FAR_DEADLINE);

        // A DIFFERENT (but independently validly co-signed) state for the same table/nonce shape.
        ChannelState memory other = _conservingState(id);
        other.gameStateHash = keccak256("different-gs");
        (bytes memory sigA2, bytes memory sigB2) = _coSign(other);
        vm.prank(relayer);
        vm.expectRevert(); // recomputed stateHash != what the signer actually signed
        zk.openDisputeFor(id, other, sigA2, sigB2, gameState, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_demandKind() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        (ChannelState memory s, bytes memory sigA, bytes memory sigB, bytes memory gameState, bytes32 stateHash) = _openDisputeForFixture(id);
        s.deckCommitment = keccak256("deck"); // needed if the tampered kind resolves to SHARE
        (sigA, sigB) = _coSign(s);
        stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(PK_A, id, stateHash, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.openDisputeFor(id, s, sigA, sigB, gameState, DEMAND_SHARE, 0, 0, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_demandSlot() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        (ChannelState memory s, , , bytes memory gameState, ) = _openDisputeForFixture(id);
        s.deckCommitment = keccak256("deck");
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(PK_A, id, stateHash, DEMAND_SHARE, 5, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.openDisputeFor(id, s, sigA, sigB, gameState, DEMAND_SHARE, 6, 0, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_nonce() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        (ChannelState memory s, bytes memory sigA, bytes memory sigB, bytes memory gameState, bytes32 stateHash) = _openDisputeForFixture(id);
        bytes memory intentSig = _signOpenDispute(PK_A, id, stateHash, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.openDisputeFor(id, s, sigA, sigB, gameState, DEMAND_MOVE, 0, 1, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_deadline() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        (ChannelState memory s, bytes memory sigA, bytes memory sigB, bytes memory gameState, bytes32 stateHash) = _openDisputeForFixture(id);
        bytes memory intentSig = _signOpenDispute(PK_A, id, stateHash, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.openDisputeFor(id, s, sigA, sigB, gameState, DEMAND_MOVE, 0, 0, FAR_DEADLINE - 1, intentSig);
    }

    // ── respondWithMoveFor: tableId, gameStateHash (via move/gameState bytes), moveHash, nonce, deadline

    function test_tamper_respondWithMoveFor_tableId() public {
        // distinct buyIn amounts: two create() calls from the SAME signer with identical
        // params would collide on an identical createNonce (see ZkTableX402.t.sol's note)
        bytes32 id1 = _createJoin(1 ether, 1 ether);
        bytes32 id2 = _createJoin(2 ether, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id1, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(PK_B, id1, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.respondWithMoveFor(id2, gameState, "move", 0, FAR_DEADLINE, sig);
    }

    function test_tamper_respondWithMoveFor_gameStateBytes() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(PK_B, id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        bytes memory tamperedGameState = abi.encode("gs", uint64(999)); // different preimage
        vm.prank(relayer);
        vm.expectRevert();
        zk.respondWithMoveFor(id, tamperedGameState, "move", 0, FAR_DEADLINE, sig);
    }

    function test_tamper_respondWithMoveFor_moveBytes() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(PK_B, id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.respondWithMoveFor(id, gameState, "different-move", 0, FAR_DEADLINE, sig);
    }

    function test_tamper_respondWithMoveFor_nonce() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(PK_B, id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.respondWithMoveFor(id, gameState, "move", 1, FAR_DEADLINE, sig);
    }

    function test_tamper_respondWithMoveFor_deadline() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(PK_B, id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.respondWithMoveFor(id, gameState, "move", 0, FAR_DEADLINE - 1, sig);
    }

    // ── reclaimTopUpFor: tableId, nonce, deadline ──────────────────────────────────────────

    function test_tamper_reclaimTopUpFor_tableId() public {
        // distinct buyIn amounts: two create() calls from the SAME signer with identical
        // params would collide on an identical createNonce (see ZkTableX402.t.sol's note)
        bytes32 id1 = _createJoin(1 ether, 1 ether);
        bytes32 id2 = _createJoin(2 ether, 1 ether);
        _topUp(PK_A, a, id1, 0.1 ether);
        vm.roll(block.number + CLOCK + 1);
        bytes memory sig = _signReclaimTopUp(PK_A, id1, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.reclaimTopUpFor(id2, 0, FAR_DEADLINE, sig);
    }

    function test_tamper_reclaimTopUpFor_nonce() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _topUp(PK_A, a, id, 0.1 ether);
        vm.roll(block.number + CLOCK + 1);
        bytes memory sig = _signReclaimTopUp(PK_A, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.reclaimTopUpFor(id, 1, FAR_DEADLINE, sig);
    }

    function test_tamper_reclaimTopUpFor_deadline() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        _topUp(PK_A, a, id, 0.1 ether);
        vm.roll(block.number + CLOCK + 1);
        bytes memory sig = _signReclaimTopUp(PK_A, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.reclaimTopUpFor(id, 0, FAR_DEADLINE - 1, sig);
    }

    // ── cancelFor: tableId, nonce, deadline ─────────────────────────────────────────────────

    function test_tamper_cancelFor_tableId() public {
        bytes32 id1 = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes32 id2 = _create(PK_A, a, 2 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes memory sig = _signCancel(PK_A, id1, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.cancelFor(id2, 0, FAR_DEADLINE, sig);
    }

    function test_tamper_cancelFor_nonce() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes memory sig = _signCancel(PK_A, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.cancelFor(id, 1, FAR_DEADLINE, sig);
    }

    function test_tamper_cancelFor_deadline() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes memory sig = _signCancel(PK_A, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.cancelFor(id, 0, FAR_DEADLINE - 1, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 4. Replay / reorder
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_replay_sameIntentTwice_revertsBadNonce() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_A, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        zk.disputeSetupFor(id, 0, FAR_DEADLINE, sig);

        // clear back to Live so a second disputeSetup would otherwise be structurally legal —
        // isolating the assertion to the nonce, not an incidental BadStatus/BadDemand.
        ChannelState memory s2 = _conservingState(id);
        s2.nonce = 1;
        (bytes memory sA, bytes memory sB) = _coSign(s2);
        vm.prank(b);
        zk.respondWithState(id, s2, sA, sB);

        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.disputeSetupFor(id, 0, FAR_DEADLINE, sig); // identical bytes, already consumed
    }

    function test_reorder_nonceAheadOfQueue_revertsBadNonce() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_A, id, 1, FAR_DEADLINE); // signer's true next nonce is 0
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.disputeSetupFor(id, 1, FAR_DEADLINE, sig);
    }

    /// Two DIFFERENT intents (different tables), same signer, same nonce slot: whichever lands
    /// first wins; the second, still-valid-looking intent dies on the now-stale nonce.
    function test_replay_competingSameNonceIntents_firstWinsSecondDies() public {
        // distinct buyIn amounts: two create() calls from the SAME signer with identical
        // params would collide on an identical createNonce (see ZkTableX402.t.sol's note)
        bytes32 id1 = _createJoin(1 ether, 1 ether);
        bytes32 id2 = _createJoin(2 ether, 1 ether);
        bytes memory sig1 = _signDisputeSetup(PK_A, id1, 0, FAR_DEADLINE);
        bytes memory sig2 = _signDisputeSetup(PK_A, id2, 0, FAR_DEADLINE);

        vm.prank(relayer);
        zk.disputeSetupFor(id1, 0, FAR_DEADLINE, sig1);
        assertEq(uint8(_status(id1)), uint8(ChannelTableBase.Status.Disputed), "first intent won");

        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.disputeSetupFor(id2, 0, FAR_DEADLINE, sig2);
        assertEq(uint8(_status(id2)), uint8(ChannelTableBase.Status.Live), "second (competing) intent never landed");
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 5. Expiry / withhold
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_expiry_pastDeadline_revertsIntentExpired() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        uint64 deadline = uint64(block.timestamp + 100);
        bytes memory sig = _signDisputeSetup(PK_A, id, 0, deadline);
        vm.warp(block.timestamp + 101);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.IntentExpired.selector);
        zk.disputeSetupFor(id, 0, deadline, sig);
    }

    /// A withheld `cancelFor` intent, signed while a table was still `Created`, is stale (not
    /// merely late) once the counterparty joins: it now hits the direct-path status check
    /// (`Live`, not `Created`) inside `_cancel`, not any intent-specific guard.
    function test_withhold_cancelFor_afterCounterpartyJoins_revertsBadStatus() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes memory sig = _signCancel(PK_A, id, 0, FAR_DEADLINE);
        _join(PK_B, b, id, 1 ether, address(0), ZERO_DECK); // table is now Live

        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.cancelFor(id, 0, FAR_DEADLINE, sig);
    }

    /// Dedicated cross-dispute test: a RespondMoveIntent signed for dispute round 1's contested
    /// game state is replayed (same calldata, same nonce, still unconsumed) against a SECOND,
    /// later dispute on the SAME table whose contested game state differs. `_respondWithMove`'s
    /// own `BadGameState` guard rejects it — the intent's `gameStateHash` binding gives this
    /// protection "for free" (see the `RespondMoveIntent` typehash comment in ZkTable.sol).
    function test_crossDispute_respondMoveIntent_replayedAgainstDifferentRound_revertsBadGameState() public {
        bytes32 id = _createJoin(1 ether, 1 ether);

        // Round 1: A disputes at nonce=1; sign B's answer but do NOT submit it yet.
        bytes memory gameState1 = _openMoveDisputeDirect(id, 1);
        bytes32 gameStateHash1 = rules.hashGameState(gameState1);
        bytes32 moveHash = keccak256("move");
        bytes memory withheldSig = _signRespondMove(PK_B, id, gameStateHash1, moveHash, 0, FAR_DEADLINE);

        // Clear round 1 differently (a fresh co-signed state), then open round 2 with a
        // DIFFERENT contested game state.
        ChannelState memory clear = _conservingState(id);
        clear.nonce = 2;
        (bytes memory csA, bytes memory csB) = _coSign(clear);
        vm.prank(b);
        zk.respondWithState(id, clear, csA, csB);

        bytes memory gameState2 = abi.encode("gs", uint64(3));
        ChannelState memory s2 = _conservingState(id);
        s2.nonce = 3;
        s2.gameStateHash = keccak256(gameState2);
        (bytes memory sA2, bytes memory sB2) = _coSign(s2);
        vm.prank(a);
        zk.openDispute(id, s2, sA2, sB2, gameState2, DEMAND_MOVE, 0); // round 2, different gameState

        // Replay the ROUND-1 intent (unmodified — same gameState1/move/nonce/sig) against the
        // table now mid ROUND 2.
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.BadGameState.selector);
        zk.respondWithMoveFor(id, gameState1, "move", 0, FAR_DEADLINE, withheldSig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 7. Pot destination — payouts always key to the SIGNING seat, never the relayer
    // ═══════════════════════════════════════════════════════════════════════════════════════

    /// Relayed openDisputeFor + timeout: the A3 forfeit-to-disputant pot lands on the SIGNING
    /// seat's wallet (B, who authorized the openDisputeFor intent), never the relayer.
    function test_potDestination_relayedOpenDisputeFor_timeout_paysSigningSeat() public {
        bytes32 id = _createJoin(1 ether, 3 ether); // total escrow = 4 ether
        bytes memory gameState = abi.encode("gs");
        ChannelState memory s = _conservingState(id);
        s.pot = 1 ether;
        s.balanceB = _totalEscrow(id) - 1 ether;
        s.gameStateHash = keccak256(gameState);
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(PK_B, id, stateHash, DEMAND_MOVE, 0, 0, FAR_DEADLINE);

        vm.prank(relayer);
        zk.openDisputeFor(id, s, sigA, sigB, gameState, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);
        (uint8 disputant, , ) = _disputeMeta(id);
        assertEq(disputant, 2, "B is the disputant (the signer), not the relayer");

        vm.roll(block.number + CLOCK + 1);
        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        uint256 relayerBefore = token.balanceOf(relayer);
        zk.resolveTimeout(id);

        uint256 paidA = token.balanceOf(a) - beforeA;
        uint256 paidB = token.balanceOf(b) - beforeB;
        assertEq(paidB, s.balanceB + 1 ether, "pot forfeits to the disputant/signer B");
        assertEq(paidA, s.balanceA, "A gets only its balance");
        assertEq(paidA + paidB, 4 ether, "conservation: full escrow paid out");
        assertEq(token.balanceOf(relayer), relayerBefore, "relayer is never a payout destination");
    }

    /// Relayed showdown reveal (Part 1 carve-out, not a signed intent): a stranger posts ONLY
    /// seat A's reveals; B never answers. Timeout pays the pot to A's wallet, never the stranger.
    function test_potDestination_strangerRelaysShowdownReveal_timeoutPaysA_notStranger() public {
        MockGameRules mockRules = new MockGameRules();
        MockRevealVerifier verifier = new MockRevealVerifier(); // ok == true by default
        mockRules.setRevealVerifier(address(verifier));
        mockRules.setShowdownSlots(true, 0, 1);

        bytes32 id = _create(PK_A, a, 2 ether, IGameRules(address(mockRules)), 2 ether, CLOCK, address(0), ZERO_DECK);
        _join(PK_B, b, id, 2 ether, address(0), ZERO_DECK);

        uint256[] memory deck = new uint256[](208);
        for (uint256 i = 0; i < 208; i++) deck[i] = i + 1;
        uint256 pot = 1 ether;
        uint256 balA = 1.5 ether;
        uint256 balB = 4 ether - pot - balA;
        ChannelState memory s = _emptyState(id);
        s.balanceA = balA;
        s.balanceB = balB;
        s.pot = pot;
        s.deckCommitment = keccak256(abi.encodePacked(deck));
        s.gameStateHash = keccak256("gs");
        (bytes memory sigA, bytes memory sigB) = _coSign(s);
        vm.prank(a); // disputant = A
        zk.openDispute(id, s, sigA, sigB, "gs", DEMAND_SHOWDOWN, 0);

        address showdownStranger = address(0xFEED);
        uint256[8] memory zeroProof;
        vm.prank(showdownStranger); // no seat relationship to this table at all
        zk.postShowdownReveals(id, 1, deck, [uint32(0), uint32(1)], [[uint256(1), uint256(2)], [uint256(3), uint256(4)]], [zeroProof, zeroProof]);

        vm.roll(block.number + CLOCK + 1);
        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        uint256 strangerBefore = token.balanceOf(showdownStranger);
        zk.resolveTimeout(id);

        assertEq(token.balanceOf(a) - beforeA, balA + pot, "A (disputant, fully revealed) gets balance + pot");
        assertEq(token.balanceOf(b) - beforeB, balB, "B (never revealed) gets only its balance");
        assertEq(token.balanceOf(showdownStranger), strangerBefore, "the relaying stranger is never a payout destination");
        assertEq((token.balanceOf(a) - beforeA) + (token.balanceOf(b) - beforeB), 4 ether, "conservation");
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 8. Cross-domain
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_crossDomain_identicalIntentBytes_wrongTable_reverts() public {
        // distinct buyIn amounts: two create() calls from the SAME signer with identical
        // params would collide on an identical createNonce (see ZkTableX402.t.sol's note)
        bytes32 id1 = _createJoin(1 ether, 1 ether);
        bytes32 id2 = _createJoin(2 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_A, id1, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.disputeSetupFor(id2, 0, FAR_DEADLINE, sig);
    }

    /// A chain-id change invalidates Solady EIP712's cached domain separator (it recomputes
    /// on-the-fly when `block.chainid` no longer matches what was cached at deploy) — an intent
    /// signed under the original chain id can never be replayed after a fork/chain-id change.
    function test_crossDomain_chainIdChange_revertsPreviouslyValidIntent() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes memory sig = _signDisputeSetup(PK_A, id, 0, FAR_DEADLINE);
        vm.chainId(block.chainid + 1);
        vm.prank(relayer);
        vm.expectRevert();
        zk.disputeSetupFor(id, 0, FAR_DEADLINE, sig);
    }
}

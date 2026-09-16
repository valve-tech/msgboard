// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";
import {SignedIntentBase} from "../../contracts/zk/SignedIntentBase.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelStateN, ChannelStateNLib, SidePot} from "../../contracts/zk/ChannelStateN.sol";
import {IGameRulesN} from "../../contracts/zk/IGameRulesN.sol";
import {MockGameRulesN} from "../../contracts/test/MockGameRulesN.sol";
import {MockX402} from "../../contracts/test/MockX402.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {EllipticCurve} from "../../contracts/zk/lib/EllipticCurve.sol";
import {RevealShareDLEQ} from "../../contracts/zk/lib/RevealShareDLEQ.sol";
import {LibString} from "solady/src/utils/LibString.sol";
import {X402AuthLib} from "./X402AuthLib.sol";

/// @notice FUND-CRITICAL coverage for HoldemTableN's signed-intent relay (2026-08 pass),
/// mirroring ZkTableRelay.t.sol: every `*For` entrypoint (`startFor`/`registerDeckKeyFor`/
/// `leaveBeforeStartFor`/`cancelFor`/`openDisputeFor`/`respondWithMoveFor`) plus the Part-1
/// permissionless carve-out (`respondWithShare`, now keyed to `t.demandSeat` structurally instead
/// of `_seatOf(msg.sender)`). The #1 risk under test throughout is a RELAYER IMPERSONATING A
/// SEAT: every test that submits via `relayer` asserts the relayer's own token balance never
/// moves and that dispute/payout/forfeiture identity always keys off the RECOVERED SIGNER (or,
/// for openDispute, the SIGNED `demandSeat`), never `msg.sender`.
contract HoldemTableNRelayTest is Test {
    using ChannelStateNLib for ChannelStateN;

    HoldemTableN internal zk;
    MockGameRulesN internal rules;
    MockX402 internal token;
    address internal treasury = address(0x7);

    // Throwaway relayer EOA: NEVER a seat on any table in this file, and NEVER the destination
    // of any payout/refund — every happy-path assertion below checks its balance stays put.
    address internal relayer = address(0xBEEF);
    address internal stranger = address(0xFEED);

    uint64 internal constant CLOCK = 30; // MIN_CLOCK_BLOCKS
    uint64 internal constant VALID_BEFORE = type(uint64).max;
    uint64 internal constant FAR_DEADLINE = type(uint64).max;
    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHARE = 2;

    // secp256k1 generator — a convenient on-curve deck-key placeholder for seats that never
    // answer a SHARE demand in a given test.
    uint256 internal constant GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 internal constant GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;

    function _pk(uint256 i) internal pure returns (uint256) { return 0xA11CE + i * 0x1000 + 1; }

    function setUp() public {
        zk = new HoldemTableN(treasury, address(0)); // factory=0: unit-test funding via a bare MockX402
        rules = new MockGameRulesN();
        token = new MockX402();
        for (uint256 i = 0; i <= 9; i++) {
            token.mint(vm.addr(_pk(i)), 10_000_000 ether);
        }
    }

    // ── x402 deposit-auth helpers (mirrors HoldemTableNUnit.t.sol) ─────────────────────────────

    function _authFor(uint256 pk, address from, uint256 value, bytes32 nonce) internal returns (HoldemTableN.DepositAuth memory) {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, VALID_BEFORE, nonce);
        return HoldemTableN.DepositAuth({from: from, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    function _create(
        uint256 pk,
        address from,
        uint256 buyIn,
        uint256 maxSeats,
        address channelKey,
        uint256[2] memory deckKey
    ) internal returns (bytes32 tableId) {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), r, buyIn, maxSeats, 0, 0, CLOCK, channelKey, deckKey, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(pk, from, buyIn, nonce);
        vm.prank(from);
        tableId = zk.create(IX402Token(address(token)), r, buyIn, maxSeats, 0, 0, CLOCK, channelKey, deckKey, auth);
    }

    function _join(uint256 pk, address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey) internal {
        bytes32 nonce = zk.joinNonce(tableId, from, channelKey, deckKey, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(pk, from, stake, nonce);
        vm.prank(from);
        zk.join(tableId, channelKey, deckKey, auth);
    }

    /// create() seat 0 + (n-1) joins, every seat's channel key its own wallet, still Forming.
    function _createAndJoin(uint256 n, uint256 buyIn) internal returns (bytes32 tableId) {
        address a0 = vm.addr(_pk(0));
        tableId = _create(_pk(0), a0, buyIn, n, a0, [GX, GY]);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            _join(_pk(i), ai, tableId, buyIn, ai, [GX, GY]);
        }
    }

    /// create() + joins + start() — Live table with n seats, every seat's own wallet as its
    /// channel key. Used as fixture setup wherever the specific relay under test isn't `startFor`.
    function _table(uint256 n, uint256 buyIn) internal returns (bytes32 tableId) {
        tableId = _createAndJoin(n, buyIn);
        vm.prank(vm.addr(_pk(0)));
        zk.start(tableId);
    }

    /// create() with a DEDICATED channel-signing key (keyA != the wallet) — used by the
    /// impersonation test proving a channel key alone cannot authorize a wallet-only `cancelFor`.
    function _createWithChannelKey(uint256 channelPk) internal returns (bytes32 tableId, address wallet, address key) {
        wallet = vm.addr(_pk(0));
        key = vm.addr(channelPk);
        tableId = _create(_pk(0), wallet, 1 ether, 2, key, [GX, GY]);
    }

    function _emptyState(bytes32 tableId, uint256 n) internal pure returns (ChannelStateN memory s) {
        s.tableId = tableId;
        s.nonce = 0;
        s.balances = new uint256[](n);
        s.sidePots = new SidePot[](0);
        s.deckCommitment = bytes32(0);
        s.phase = 0;
        s.gameStateHash = bytes32(0);
    }

    function _coSign(uint256 n, ChannelStateN memory s) internal view returns (bytes[] memory sigs) {
        bytes32 digest = zk.stateDigest(s);
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 ss) = vm.sign(_pk(i), digest);
            sigs[i] = abi.encodePacked(r, ss, v);
        }
    }

    /// Opens a MOVE dispute DIRECTLY (opener = seat 0) naming `demandSeat` — used as fixture
    /// setup by tests that relay the ANSWER (`respondWithMoveFor`) rather than the open. Every
    /// call site uses this against a table built via `_table(3, 1 ether)`, so the conserving
    /// split below (all 3 ether parked on seat 0) is hardcoded to match — mirrors
    /// HoldemTableNUnit.t.sol's own `_openMoveDispute` convention.
    function _openMoveDisputeDirect(bytes32 tableId, uint256 n, uint64 nonce, uint8 demandSeat)
        internal
        returns (bytes memory gameState)
    {
        gameState = abi.encode("gs", nonce);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = nonce;
        s.balances[0] = n * 1 ether; // conserves Σ escrow == n seats * 1 ether buy-in
        s.gameStateHash = keccak256(gameState);
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, gameState, demandSeat, DEMAND_MOVE, 0);
    }

    // ── per-intent sign helpers ─────────────────────────────────────────────────────────────

    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        return X402AuthLib.sign65(pk, digest);
    }

    function _signStart(uint256 pk, bytes32 tableId, uint256 nonce, uint64 deadline) internal returns (bytes memory) {
        return _sig(pk, zk.startIntentDigest(tableId, nonce, deadline));
    }

    function _signRegisterDeckKey(uint256 pk, bytes32 tableId, uint256 pkX, uint256 pkY, uint256 nonce, uint64 deadline)
        internal
        returns (bytes memory)
    {
        return _sig(pk, zk.registerDeckKeyIntentDigest(tableId, pkX, pkY, nonce, deadline));
    }

    function _signLeave(uint256 pk, bytes32 tableId, uint256 nonce, uint64 deadline) internal returns (bytes memory) {
        return _sig(pk, zk.leaveIntentDigest(tableId, nonce, deadline));
    }

    function _signCancel(uint256 pk, bytes32 tableId, uint256 nonce, uint64 deadline) internal returns (bytes memory) {
        return _sig(pk, zk.cancelIntentDigest(tableId, nonce, deadline));
    }

    function _signOpenDispute(
        uint256 pk,
        bytes32 tableId,
        bytes32 stateHash,
        uint8 demandSeat,
        uint8 demandKind,
        uint32 demandSlot,
        uint256 nonce,
        uint64 deadline
    ) internal returns (bytes memory) {
        return _sig(pk, zk.openDisputeIntentDigest(tableId, stateHash, demandSeat, demandKind, demandSlot, nonce, deadline));
    }

    function _signRespondMove(uint256 pk, bytes32 tableId, bytes32 gameStateHash, bytes32 moveHash, uint256 nonce, uint64 deadline)
        internal
        returns (bytes memory)
    {
        return _sig(pk, zk.respondWithMoveIntentDigest(tableId, gameStateHash, moveHash, nonce, deadline));
    }

    // (HoldemTableN has no public tuple getter for `Table` — its `_tables` mapping is internal —
    // so tests assert observable effects (status transitions, balances, events) via the dedicated
    // view functions, exactly like HoldemTableNUnit.t.sol does.)

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 0. Chaum–Pedersen DLEQ proof construction (pure Solidity, no ffi) — for the
    //    respondWithShare permissionless-carve-out tests below.
    // ═══════════════════════════════════════════════════════════════════════════════════════

    /// Builds a REAL DLEQ statement (pk = G*sk, d = c1*sk, honest {t1,t2,z}) matching
    /// RevealShareDLEQ.verify's two equations exactly, using the same EllipticCurve arithmetic
    /// the contract itself uses — no off-chain prover / ffi needed. `sk`/`c1Scalar`/`w` are
    /// arbitrary nonzero scalars distinct enough to avoid degenerate points.
    function _makeShareProof(uint256 sk, uint256 c1Scalar, uint256 w, string memory ctx)
        internal
        pure
        returns (uint256[2] memory pk, uint256[4] memory deckWord, uint256[2] memory share, uint256[5] memory proof)
    {
        (uint256 pkX, uint256 pkY) = EllipticCurve.ecMul(sk, EllipticCurve.GX, EllipticCurve.GY);
        (uint256 c1X, uint256 c1Y) = EllipticCurve.ecMul(c1Scalar, EllipticCurve.GX, EllipticCurve.GY);
        // c2 only feeds the Fiat-Shamir challenge (never used in the two verify equations) — any
        // on-curve point works; reuse G itself.
        (uint256 c2X, uint256 c2Y) = (EllipticCurve.GX, EllipticCurve.GY);
        (uint256 dX, uint256 dY) = EllipticCurve.ecMul(sk, c1X, c1Y);
        (uint256 t1X, uint256 t1Y) = EllipticCurve.ecMul(w, EllipticCurve.GX, EllipticCurve.GY);
        (uint256 t2X, uint256 t2Y) = EllipticCurve.ecMul(w, c1X, c1Y);

        RevealShareDLEQ.Statement memory s = RevealShareDLEQ.Statement({
            pkX: pkX, pkY: pkY, c1X: c1X, c1Y: c1Y, c2X: c2X, c2Y: c2Y,
            dX: dX, dY: dY, t1X: t1X, t1Y: t1Y, t2X: t2X, t2Y: t2Y, z: 0
        });
        uint256 e = RevealShareDLEQ.challenge(s, ctx);
        uint256 z = addmod(w, mulmod(e, sk, EllipticCurve.NN), EllipticCurve.NN);

        pk = [pkX, pkY];
        deckWord = [c1X, c1Y, c2X, c2Y];
        share = [dX, dY];
        proof = [t1X, t1Y, t2X, t2Y, z];
    }

    /// Mirrors HoldemTableN._ctxFor exactly (private on-chain; duplicated here like
    /// HoldemTableNUnit.t.sol duplicates `_deckHash` as `_mirrorDeckHash`).
    function _ctxFor(bytes32 tableId, uint32 slot) internal pure returns (string memory) {
        return string.concat("holdem/", LibString.toHexString(uint256(tableId), 32), "/slot/", LibString.toString(uint256(slot)));
    }

    /// Mirrors HoldemTableN._deckHash exactly.
    function _deckHash(uint256[] memory deck) internal pure returns (bytes32) {
        bytes memory acc;
        for (uint256 i = 0; i < deck.length; i += 4) {
            acc = abi.encodePacked(
                acc,
                bytes1(uint8(2 + (deck[i + 1] & 1))), bytes32(deck[i]),
                bytes1(uint8(2 + (deck[i + 3] & 1))), bytes32(deck[i + 2])
            );
        }
        return keccak256(acc);
    }

    /// Sets up a Live 3-seat table with an open SHARE dispute naming `demandSeat` for `slot`
    /// (always 0 here — a single-card deck array is all `respondWithShare` reads). Registers
    /// `demandSeat`'s REAL DLEQ pubkey (from `_makeShareProof`'s `sk`) at join time.
    function _setupShareDispute(uint8 demandSeat, uint256 sk, uint256 c1Scalar, uint256 w)
        internal
        returns (bytes32 tableId, uint256[] memory deck, uint256[2] memory share, uint256[5] memory proof)
    {
        uint256 n = 3;
        uint256 buyIn = 3 ether;
        address a0 = vm.addr(_pk(0));

        bytes32 predictedId = keccak256(abi.encode(block.chainid, address(zk), _nextCounter()));
        string memory ctx = _ctxFor(predictedId, 0);
        (uint256[2] memory pk, uint256[4] memory deckWord, uint256[2] memory sh, uint256[5] memory pf) =
            _makeShareProof(sk, c1Scalar, w, ctx);
        share = sh;
        proof = pf;

        tableId = _create(_pk(0), a0, buyIn, n, a0, demandSeat == 0 ? pk : [GX, GY]);
        require(tableId == predictedId, "ctx/tableId mismatch: bump _nextCounter");
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            _join(_pk(i), ai, tableId, buyIn, ai, i == demandSeat ? pk : [GX, GY]);
        }
        vm.prank(a0);
        zk.start(tableId);

        deck = new uint256[](4);
        deck[0] = deckWord[0]; deck[1] = deckWord[1]; deck[2] = deckWord[2]; deck[3] = deckWord[3];

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = buyIn; s.balances[1] = buyIn; s.balances[2] = buyIn;
        s.deckCommitment = _deckHash(deck);
        s.gameStateHash = keccak256("gs");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(a0);
        zk.openDispute(tableId, s, sigs, "gs", demandSeat, DEMAND_SHARE, 0);
    }

    /// The table id predicted by `create()` is `keccak256(abi.encode(chainid, this, ++_counter))`
    /// — `_counter` increments once per `create()` call across the WHOLE test's lifetime, so this
    /// tracks how many tables have been created so far in the current test (each test starts a
    /// fresh contract instance via `setUp`, so this is always 1 the first time it's called).
    uint256 internal _createCount;
    function _nextCounter() internal returns (uint256) {
        _createCount += 1;
        return _createCount;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 1. Happy relay — every `*For`, submitted by a throwaway relayer
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_happyRelay_startFor() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        bytes memory sig = _signStart(_pk(0), id, 0, FAR_DEADLINE);

        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.startFor(id, 0, FAR_DEADLINE, sig);

        assertEq(uint8(zk.status(id)), uint8(ChannelTableBase.Status.Live), "table started");
        assertEq(zk.relayNonces(vm.addr(_pk(0))), 1, "signer's nonce burned");
        assertEq(token.balanceOf(relayer), relayerBefore, "relayer balance untouched");
    }

    function test_happyRelay_registerDeckKeyFor() public {
        bytes32 id = _createAndJoin(2, 1 ether);
        uint256 g2x = 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5;
        uint256 g2y = 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a;
        bytes memory sig = _signRegisterDeckKey(_pk(1), id, g2x, g2y, 0, FAR_DEADLINE);

        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.registerDeckKeyFor(id, g2x, g2y, 0, FAR_DEADLINE, sig);

        uint256[2] memory got = zk.deckKeyOf(id, 1);
        assertEq(got[0], g2x, "seat 1's key rotated by the SIGNER, not the relayer");
        assertEq(zk.relayNonces(vm.addr(_pk(1))), 1);
        assertEq(token.balanceOf(relayer), relayerBefore);
    }

    function test_happyRelay_leaveBeforeStartFor() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        address seat1 = vm.addr(_pk(1));
        bytes memory sig = _signLeave(_pk(1), id, 0, FAR_DEADLINE);

        uint256 before1 = token.balanceOf(seat1);
        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.leaveBeforeStartFor(id, 0, FAR_DEADLINE, sig);

        assertEq(zk.seatCount(id), 2, "seat compacted away");
        assertEq(token.balanceOf(seat1) - before1, 1 ether, "refund lands on the SIGNER's own wallet");
        assertEq(token.balanceOf(relayer), relayerBefore, "relayer never touches the refund");
        assertEq(zk.relayNonces(seat1), 1);
    }

    function test_happyRelay_cancelFor() public {
        address a0 = vm.addr(_pk(0));
        bytes32 id = _create(_pk(0), a0, 1 ether, 2, a0, [GX, GY]);
        bytes memory sig = _signCancel(_pk(0), id, 0, FAR_DEADLINE);

        uint256 before0 = token.balanceOf(a0);
        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.cancelFor(id, 0, FAR_DEADLINE, sig);

        assertEq(uint8(zk.status(id)), uint8(ChannelTableBase.Status.Cancelled));
        assertEq(token.balanceOf(a0) - before0, 1 ether, "refund lands on seats[0], not the relayer");
        assertEq(token.balanceOf(relayer), relayerBefore);
        assertEq(zk.relayNonces(a0), 1);
    }

    function test_happyRelay_openDisputeFor() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelStateN memory s = _emptyState(id, 3);
        s.balances[0] = 1 ether; s.balances[1] = 1 ether; s.balances[2] = 1 ether;
        s.gameStateHash = keccak256(gameState);
        bytes[] memory sigs = _coSign(3, s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(_pk(0), id, stateHash, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE);

        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.openDisputeFor(id, s, sigs, gameState, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);

        assertEq(uint8(zk.status(id)), uint8(ChannelTableBase.Status.Disputed), "dispute opened");
        assertEq(zk.relayNonces(vm.addr(_pk(0))), 1, "OPENER's (signer's) nonce burned, not the relayer's");
        assertEq(token.balanceOf(relayer), relayerBefore);
    }

    function test_happyRelay_respondWithMoveFor() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 3, 1, 1); // demandSeat = 1
        bytes memory move = "some-move";
        bytes memory nextState = abi.encode("gs2");
        rules.setApply(nextState, false);

        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256(move);
        bytes memory sig = _signRespondMove(_pk(1), id, gameStateHash, moveHash, 0, FAR_DEADLINE);

        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(relayer);
        zk.respondWithMoveFor(id, gameState, move, 0, FAR_DEADLINE, sig);

        assertEq(uint8(zk.status(id)), uint8(ChannelTableBase.Status.Live), "dispute cleared by seat 1's signed answer");
        assertEq(zk.relayNonces(vm.addr(_pk(1))), 1);
        assertEq(token.balanceOf(relayer), relayerBefore);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 2. Impersonation
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_impersonation_startFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        bytes memory sig = _signStart(_pk(9), id, 0, FAR_DEADLINE); // pk(9) never seated
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.startFor(id, 0, FAR_DEADLINE, sig);
    }

    function test_impersonation_registerDeckKeyFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _createAndJoin(2, 1 ether);
        bytes memory sig = _signRegisterDeckKey(_pk(9), id, GX, GY, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.registerDeckKeyFor(id, GX, GY, 0, FAR_DEADLINE, sig);
    }

    function test_impersonation_leaveBeforeStartFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        bytes memory sig = _signLeave(_pk(9), id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.leaveBeforeStartFor(id, 0, FAR_DEADLINE, sig);
    }

    function test_impersonation_cancelFor_nonSeatSigner_revertsNotPlayer() public {
        address a0 = vm.addr(_pk(0));
        bytes32 id = _create(_pk(0), a0, 1 ether, 2, a0, [GX, GY]);
        bytes memory sig = _signCancel(_pk(9), id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancelFor(id, 0, FAR_DEADLINE, sig);
    }

    /// The wallet-only requirement: `cancelFor` signed by a valid CHANNEL KEY (a real `_seatOf`
    /// identity — it co-signs ChannelStateN for this exact table) must still revert, because
    /// `cancelFor` checks `signer == t.seats[0]` directly, never `_seatOf`. A channel key is NOT
    /// sufficient to move the wallet's full escrow via cancel.
    function test_impersonation_cancelFor_channelKeySigner_revertsNotPlayer() public {
        uint256 channelPk = 0x5E55A;
        (bytes32 id, , address key) = _createWithChannelKey(channelPk);
        bytes memory sig = _signCancel(channelPk, id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancelFor(id, 0, FAR_DEADLINE, sig);
        assertTrue(key != address(0)); // silence unused-var warning; key is asserted implicitly by the sig above
    }

    function test_impersonation_openDisputeFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelStateN memory s = _emptyState(id, 3);
        s.balances[0] = 1 ether; s.balances[1] = 1 ether; s.balances[2] = 1 ether;
        s.gameStateHash = keccak256(gameState);
        bytes[] memory sigs = _coSign(3, s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(_pk(9), id, stateHash, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.openDisputeFor(id, s, sigs, gameState, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);
    }

    function test_impersonation_respondWithMoveFor_nonSeatSigner_revertsNotPlayer() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 3, 1, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(_pk(9), id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.respondWithMoveFor(id, gameState, "move", 0, FAR_DEADLINE, sig);
    }

    /// A seat that IS a real seat, but not `demandSeat`, still cannot answer via the relay: the
    /// identity check inside `_respondWithMove` (`seat != t.demandSeat -> NotYourDispute`) applies
    /// identically to the relayed path.
    function test_impersonation_respondWithMoveFor_wrongSeatSigner_revertsNotYourDispute() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 3, 1, 1); // demandSeat = 1
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(_pk(2), id, gameStateHash, moveHash, 0, FAR_DEADLINE); // seat 2, not demanded
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.NotYourDispute.selector);
        zk.respondWithMoveFor(id, gameState, "move", 0, FAR_DEADLINE, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 3. Tamper matrix — flip each bound field after signing; every cell reverts
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_tamper_startFor_tableId() public {
        bytes32 id1 = _createAndJoin(3, 1 ether);
        bytes32 id2 = _createAndJoin(3, 2 ether); // distinct buyIn: avoids an identical createNonce
        bytes memory sig = _signStart(_pk(0), id1, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(); // recovers a garbage signer -> NotPlayer (occasionally BadNonce)
        zk.startFor(id2, 0, FAR_DEADLINE, sig);
    }

    function test_tamper_startFor_nonce() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        bytes memory sig = _signStart(_pk(0), id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.startFor(id, 1, FAR_DEADLINE, sig);
    }

    function test_tamper_startFor_deadline() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        bytes memory sig = _signStart(_pk(0), id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.startFor(id, 0, FAR_DEADLINE - 1, sig);
    }

    function test_tamper_registerDeckKeyFor_pkX() public {
        bytes32 id = _createAndJoin(2, 1 ether);
        uint256 g2x = 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5;
        uint256 g2y = 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a;
        bytes memory sig = _signRegisterDeckKey(_pk(1), id, g2x, g2y, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.registerDeckKeyFor(id, g2x + 1, g2y, 0, FAR_DEADLINE, sig);
    }

    function test_tamper_registerDeckKeyFor_pkY() public {
        bytes32 id = _createAndJoin(2, 1 ether);
        uint256 g2x = 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5;
        uint256 g2y = 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a;
        bytes memory sig = _signRegisterDeckKey(_pk(1), id, g2x, g2y, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.registerDeckKeyFor(id, g2x, g2y + 1, 0, FAR_DEADLINE, sig);
    }

    function test_tamper_leaveBeforeStartFor_tableId() public {
        bytes32 id1 = _createAndJoin(3, 1 ether);
        bytes32 id2 = _createAndJoin(3, 2 ether);
        bytes memory sig = _signLeave(_pk(1), id1, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.leaveBeforeStartFor(id2, 0, FAR_DEADLINE, sig);
    }

    function test_tamper_cancelFor_tableId() public {
        address a0 = vm.addr(_pk(0));
        bytes32 id1 = _create(_pk(0), a0, 1 ether, 2, a0, [GX, GY]);
        bytes32 id2 = _create(_pk(0), a0, 2 ether, 2, a0, [GX, GY]);
        bytes memory sig = _signCancel(_pk(0), id1, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.cancelFor(id2, 0, FAR_DEADLINE, sig);
    }

    function test_tamper_openDisputeFor_demandSeat() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelStateN memory s = _emptyState(id, 3);
        s.balances[0] = 1 ether; s.balances[1] = 1 ether; s.balances[2] = 1 ether;
        s.gameStateHash = keccak256(gameState);
        bytes[] memory sigs = _coSign(3, s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(_pk(0), id, stateHash, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(); // signed for demandSeat=1, relayer tries to redirect the forfeit to seat 2
        zk.openDisputeFor(id, s, sigs, gameState, 2, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_demandKind() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelStateN memory s = _emptyState(id, 3);
        s.balances[0] = 1 ether; s.balances[1] = 1 ether; s.balances[2] = 1 ether;
        s.gameStateHash = keccak256(gameState);
        s.deckCommitment = keccak256("deck"); // needed if the tampered kind resolves to SHARE
        bytes[] memory sigs = _coSign(3, s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(_pk(0), id, stateHash, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.openDisputeFor(id, s, sigs, gameState, 1, DEMAND_SHARE, 0, 0, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_demandSlot() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelStateN memory s = _emptyState(id, 3);
        s.balances[0] = 1 ether; s.balances[1] = 1 ether; s.balances[2] = 1 ether;
        s.gameStateHash = keccak256(gameState);
        s.deckCommitment = keccak256("deck");
        bytes[] memory sigs = _coSign(3, s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(_pk(0), id, stateHash, 1, DEMAND_SHARE, 5, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.openDisputeFor(id, s, sigs, gameState, 1, DEMAND_SHARE, 6, 0, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_stateHash_viaDifferentState() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelStateN memory s = _emptyState(id, 3);
        s.balances[0] = 1 ether; s.balances[1] = 1 ether; s.balances[2] = 1 ether;
        s.gameStateHash = keccak256(gameState);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(_pk(0), id, stateHash, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE);

        // A DIFFERENT (but independently validly co-signed) state for the same table.
        ChannelStateN memory other = _emptyState(id, 3);
        other.balances[0] = 1 ether; other.balances[1] = 1 ether; other.balances[2] = 1 ether;
        other.gameStateHash = keccak256("different-gs");
        bytes[] memory sigsOther = _coSign(3, other);
        vm.prank(relayer);
        vm.expectRevert(); // recomputed stateHash != what the signer actually signed
        zk.openDisputeFor(id, other, sigsOther, gameState, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);
    }

    function test_tamper_openDisputeFor_nonce() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = abi.encode("gs");
        ChannelStateN memory s = _emptyState(id, 3);
        s.balances[0] = 1 ether; s.balances[1] = 1 ether; s.balances[2] = 1 ether;
        s.gameStateHash = keccak256(gameState);
        bytes[] memory sigs = _coSign(3, s);
        bytes32 stateHash = s.structHashMem();
        bytes memory intentSig = _signOpenDispute(_pk(0), id, stateHash, 1, DEMAND_MOVE, 0, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.openDisputeFor(id, s, sigs, gameState, 1, DEMAND_MOVE, 0, 1, FAR_DEADLINE, intentSig);
    }

    function test_tamper_respondWithMoveFor_gameStateBytes() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 3, 1, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(_pk(1), id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        bytes memory tampered = abi.encode("gs", uint64(999));
        vm.prank(relayer);
        vm.expectRevert();
        zk.respondWithMoveFor(id, tampered, "move", 0, FAR_DEADLINE, sig);
    }

    function test_tamper_respondWithMoveFor_moveBytes() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 3, 1, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(_pk(1), id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.respondWithMoveFor(id, gameState, "different-move", 0, FAR_DEADLINE, sig);
    }

    function test_tamper_respondWithMoveFor_nonce() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 3, 1, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(_pk(1), id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.respondWithMoveFor(id, gameState, "move", 1, FAR_DEADLINE, sig);
    }

    function test_tamper_respondWithMoveFor_deadline() public {
        bytes32 id = _table(3, 1 ether);
        bytes memory gameState = _openMoveDisputeDirect(id, 3, 1, 1);
        bytes32 gameStateHash = rules.hashGameState(gameState);
        bytes32 moveHash = keccak256("move");
        bytes memory sig = _signRespondMove(_pk(1), id, gameStateHash, moveHash, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.respondWithMoveFor(id, gameState, "move", 0, FAR_DEADLINE - 1, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 4. Replay / reorder
    // ═══════════════════════════════════════════════════════════════════════════════════════

    /// `startFor` is a one-shot transition (Created -> Live), so a REPLAYED intent against the
    /// same table would hit `BadStatus` first, not `BadNonce` — that's a status collision, not a
    /// nonce one. `registerDeckKeyFor` stays structurally legal to call again (rotation is
    /// idempotent while Forming), isolating this assertion to the nonce itself.
    function test_replay_sameIntentTwice_revertsBadNonce() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        bytes memory sig = _signRegisterDeckKey(_pk(0), id, GX, GY, 0, FAR_DEADLINE);
        vm.prank(relayer);
        zk.registerDeckKeyFor(id, GX, GY, 0, FAR_DEADLINE, sig);

        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.registerDeckKeyFor(id, GX, GY, 0, FAR_DEADLINE, sig); // identical bytes, already consumed
    }

    function test_reorder_nonceAheadOfQueue_revertsBadNonce() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        bytes memory sig = _signStart(_pk(0), id, 1, FAR_DEADLINE); // signer's true next nonce is 0
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.startFor(id, 1, FAR_DEADLINE, sig);
    }

    /// Two DIFFERENT intents (different tables), same signer, same nonce slot: whichever lands
    /// first wins; the second, still-valid-looking intent dies on the now-stale nonce.
    function test_replay_competingSameNonceIntents_firstWinsSecondDies() public {
        bytes32 id1 = _createAndJoin(3, 1 ether);
        bytes32 id2 = _createAndJoin(3, 2 ether);
        bytes memory sig1 = _signStart(_pk(0), id1, 0, FAR_DEADLINE);
        bytes memory sig2 = _signStart(_pk(0), id2, 0, FAR_DEADLINE);

        vm.prank(relayer);
        zk.startFor(id1, 0, FAR_DEADLINE, sig1);
        assertEq(uint8(zk.status(id1)), uint8(ChannelTableBase.Status.Live), "first intent won");

        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.BadNonce.selector);
        zk.startFor(id2, 0, FAR_DEADLINE, sig2);
        assertEq(uint8(zk.status(id2)), uint8(ChannelTableBase.Status.Created), "second (competing) intent never landed");
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 5. Expiry
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_expiry_pastDeadline_revertsIntentExpired() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        uint64 deadline = uint64(block.timestamp + 100);
        bytes memory sig = _signStart(_pk(0), id, 0, deadline);
        vm.warp(block.timestamp + 101);
        vm.prank(relayer);
        vm.expectRevert(SignedIntentBase.IntentExpired.selector);
        zk.startFor(id, 0, deadline, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 6. Cross-dispute RespondMoveIntent replay
    // ═══════════════════════════════════════════════════════════════════════════════════════

    /// A RespondMoveIntent signed for dispute round 1's contested game state is replayed (same
    /// calldata, same nonce, still unconsumed) against a SECOND, later dispute on the SAME table
    /// whose contested game state differs. `_respondWithMove`'s own `BadGameState` guard rejects
    /// it — the intent's `gameStateHash` binding gives this protection "for free".
    function test_crossDispute_respondMoveIntent_replayedAgainstDifferentRound_revertsBadGameState() public {
        bytes32 id = _table(3, 1 ether);

        // Round 1: seat 0 disputes at nonce=1, naming seat 1; sign seat 1's answer but withhold it.
        bytes memory gameState1 = _openMoveDisputeDirect(id, 3, 1, 1);
        bytes32 gameStateHash1 = rules.hashGameState(gameState1);
        bytes32 moveHash = keccak256("move");
        bytes memory withheldSig = _signRespondMove(_pk(1), id, gameStateHash1, moveHash, 0, FAR_DEADLINE);

        // Clear round 1 differently (a fresh co-signed state), then open round 2 naming a
        // DIFFERENT contested game state (and a different demandSeat, to show it's the game
        // state hash — not the seat — doing the work here).
        ChannelStateN memory clear = _emptyState(id, 3);
        clear.nonce = 2;
        clear.balances[0] = 1 ether; clear.balances[1] = 1 ether; clear.balances[2] = 1 ether;
        bytes[] memory clearSigs = _coSign(3, clear);
        vm.prank(vm.addr(_pk(1)));
        zk.respondWithState(id, clear, clearSigs);

        bytes memory gameState2 = abi.encode("gs", uint64(3));
        ChannelStateN memory s2 = _emptyState(id, 3);
        s2.nonce = 3;
        s2.balances[0] = 1 ether; s2.balances[1] = 1 ether; s2.balances[2] = 1 ether;
        s2.gameStateHash = keccak256(gameState2);
        bytes[] memory sigs2 = _coSign(3, s2);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(id, s2, sigs2, gameState2, 1, DEMAND_MOVE, 0); // round 2, different gameState

        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.BadGameState.selector);
        zk.respondWithMoveFor(id, gameState1, "move", 0, FAR_DEADLINE, withheldSig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 7. Carve-out: a STRANGER relays respondWithShare (no `*For`/signature at all — the
    //    function is self-authenticating via the DLEQ proof, see the contract header).
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_carveOut_strangerRelaysRespondWithShare_clearsDispute() public {
        (bytes32 id, uint256[] memory deck, uint256[2] memory share, uint256[5] memory proof) =
            _setupShareDispute(1, 0xD00D1, 0xD00D2, 0xD00D3);

        vm.prank(stranger); // NOT seat 1, not any seat at this table at all
        zk.respondWithShare(id, deck, share, proof);

        assertEq(uint8(zk.status(id)), uint8(ChannelTableBase.Status.Live), "dispute cleared by the stranger's relay");
    }

    /// A wrong-pk proof (signed under a DIFFERENT secret than the seat's registered deckKey)
    /// reverts regardless of who calls — even the demanded seat itself cannot forge past this.
    function test_carveOut_wrongPkProof_revertsBadShareProof_regardlessOfCaller() public {
        (bytes32 id, uint256[] memory deck, , ) = _setupShareDispute(1, 0xD00D1, 0xD00D2, 0xD00D3);
        // A share/proof generated under a DIFFERENT secret than the one registered for seat 1.
        string memory ctx = _ctxFor(id, 0);
        (, , uint256[2] memory wrongShare, uint256[5] memory wrongProof) = _makeShareProof(0xBAD1, 0xD00D2, 0xD00D3, ctx);

        vm.prank(vm.addr(_pk(1))); // even the TRUE demand seat cannot land a forged proof
        vm.expectRevert(HoldemTableN.BadShareProof.selector);
        zk.respondWithShare(id, deck, wrongShare, wrongProof);

        vm.prank(stranger);
        vm.expectRevert(HoldemTableN.BadShareProof.selector);
        zk.respondWithShare(id, deck, wrongShare, wrongProof);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 8. Forfeiture/pot destination — keyed to the SIGNED demandSeat, never the relayer
    // ═══════════════════════════════════════════════════════════════════════════════════════

    /// Relayed openDisputeFor (signed by seat 0, naming demandSeat=2) + timeout: ForcedFold
    /// forfeits exactly the SIGNED demandSeat's pot share; the relayer never receives anything;
    /// conservation holds (Σ payouts + rake == Σ escrow).
    function test_potDestination_relayedOpenDisputeFor_timeout_forfeitsSignedDemandSeat() public {
        uint256 buyIn = 1 ether;
        bytes32 id = _table(3, buyIn); // total escrow = 3 ether
        bytes memory gameState = abi.encode("gs");
        ChannelStateN memory s = _emptyState(id, 3);
        s.pot = 0.3 ether;
        uint256 remaining = 3 ether - s.pot;
        s.balances[0] = remaining / 3;
        s.balances[1] = remaining / 3;
        s.balances[2] = remaining - s.balances[0] - s.balances[1];
        s.gameStateHash = keccak256(gameState);
        bytes[] memory sigs = _coSign(3, s);
        bytes32 stateHash = s.structHashMem();
        // signed by seat 0, naming seat 2 as the demand/forfeiture target
        bytes memory intentSig = _signOpenDispute(_pk(0), id, stateHash, 2, DEMAND_MOVE, 0, 0, FAR_DEADLINE);

        vm.prank(relayer);
        zk.openDisputeFor(id, s, sigs, gameState, 2, DEMAND_MOVE, 0, 0, FAR_DEADLINE, intentSig);
        assertEq(uint8(zk.status(id)), uint8(ChannelTableBase.Status.Disputed));

        vm.roll(block.number + CLOCK + 1);
        address a0 = vm.addr(_pk(0));
        address a1 = vm.addr(_pk(1));
        address a2 = vm.addr(_pk(2));
        uint256 before0 = token.balanceOf(a0);
        uint256 before1 = token.balanceOf(a1);
        uint256 before2 = token.balanceOf(a2);
        uint256 relayerBefore = token.balanceOf(relayer);
        uint256 treasuryBefore = token.balanceOf(treasury);

        zk.resolveTimeout(id);

        uint256 paid0 = token.balanceOf(a0) - before0;
        uint256 paid1 = token.balanceOf(a1) - before1;
        uint256 paid2 = token.balanceOf(a2) - before2;
        uint256 rakePaid = token.balanceOf(treasury) - treasuryBefore;

        assertEq(paid2, s.balances[2], "seat 2 (forfeiting/demanded) gets ONLY its own balance, no pot share");
        assertEq(paid0, s.balances[0] + s.pot / 2, "seat 0 gets its balance plus half the forfeited pot");
        assertEq(paid1, s.balances[1] + (s.pot - s.pot / 2), "seat 1 gets its balance plus the other half (+ odd wei)");
        assertEq(paid0 + paid1 + paid2 + rakePaid, 3 ether, "conservation: full escrow paid out");
        assertEq(token.balanceOf(relayer), relayerBefore, "relayer is never a payout destination");
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 9. Cross-domain
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_crossDomain_identicalIntentBytes_wrongTable_reverts() public {
        bytes32 id1 = _createAndJoin(3, 1 ether);
        bytes32 id2 = _createAndJoin(3, 2 ether);
        bytes memory sig = _signStart(_pk(0), id1, 0, FAR_DEADLINE);
        vm.prank(relayer);
        vm.expectRevert();
        zk.startFor(id2, 0, FAR_DEADLINE, sig);
    }

    /// A chain-id change invalidates Solady EIP712's cached domain separator (it recomputes
    /// on-the-fly when `block.chainid` no longer matches what was cached at deploy) — an intent
    /// signed under the original chain id can never be replayed after a fork/chain-id change.
    function test_crossDomain_chainIdChange_revertsPreviouslyValidIntent() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        bytes memory sig = _signStart(_pk(0), id, 0, FAR_DEADLINE);
        vm.chainId(block.chainid + 1);
        vm.prank(relayer);
        vm.expectRevert();
        zk.startFor(id, 0, FAR_DEADLINE, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 10. leaveBeforeStartFor — swap-and-pop + _deckKey migration preserved under relay
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_leaveBeforeStartFor_preservesSwapPopAndDeckKeyMigration() public {
        bytes32 id = _createAndJoin(3, 1 ether);
        address seat2 = vm.addr(_pk(2));
        uint256[2] memory seat2Key = zk.deckKeyOf(id, 2);

        // seat 1 leaves: seat 2 (the LAST seat) swaps down into index 1.
        bytes memory sig = _signLeave(_pk(1), id, 0, FAR_DEADLINE);
        vm.prank(relayer);
        zk.leaveBeforeStartFor(id, 0, FAR_DEADLINE, sig);

        assertEq(zk.seatCount(id), 2, "compacted to 2 seats");
        assertEq(zk.seatAt(id, 1), seat2, "the last seat swapped down into the vacated index");
        uint256[2] memory movedKey = zk.deckKeyOf(id, 1);
        assertEq(movedKey[0], seat2Key[0], "seat 2's deck key moved WITH it to index 1");
        assertEq(movedKey[1], seat2Key[1]);
    }
}

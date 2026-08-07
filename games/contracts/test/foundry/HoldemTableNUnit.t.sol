// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelStateN, SidePot} from "../../contracts/zk/ChannelStateN.sol";
import {IGameRulesN} from "../../contracts/zk/IGameRulesN.sol";
import {MockGameRulesN} from "../../contracts/test/MockGameRulesN.sol";
import {MockX402} from "../../contracts/test/MockX402.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {X402AuthLib} from "./X402AuthLib.sol";

/// @notice Coverage-focused unit suite for HoldemTableN. HoldemTableN.t.sol / *Showdown.t.sol /
/// *Invariant.t.sol exercise the happy paths + a handful of guards (BadSig, ConservationViolated,
/// RakeTooHigh, NotYourTurn, BadDeckKey, BadStatus) plus — ONLY under the `ffi` profile —
/// BadDeck/BadShareProof/NotYourDispute via the real off-chain prover (HoldemShareDispute.t.sol).
/// This file closes the remaining reverts reachable WITHOUT ffi: every seating guard
/// (WrongValue/BadClock/BadRules/BadSeatCount/RakeTooHigh at create; BadStatus/WrongValue/
/// TooManySeats/NotPlayer/DuplicateKey at join; NotEnoughSeats at start), the two lifecycle
/// functions with NO prior coverage at all (leaveBeforeStart, cancel, respondWithMove), the
/// dispute-clock guards (ClockNotExpired, StaleNonce at all three call sites, BadGameState,
/// BadDemand, SeatRange), the co-signed-state guards (WrongTable, BadSeatCount, WrongSigCount),
/// settle's NotFinal/PotNotZero, and the respondWithShare branches that do NOT require a valid
/// DLEQ proof (NotDemanded, NotYourDispute, DeckKeyNotSet, BadDeck, the in-function BadDemand
/// slot-range check, and BadShareProof via a garbage/off-curve proof — `RevealShareDLEQ.verify`
/// returns `false` on malformed input without needing real curve math, so this does not need ffi).
///
/// OUT OF SCOPE (by design, per Wave E split): the SHARE-dispute HAPPY path — a proof that
/// actually passes both DLEQ equations and reaches `DisputeAnsweredWithShare` / `_clearDispute`
/// — needs a genuine Chaum–Pedersen proof matching the off-chain `zk-cards-core` prover byte for
/// byte; that parity is exactly what HoldemShareDispute.t.sol (ffi) verifies and is intentionally
/// not duplicated here.
///
/// ── x402 CONVERSION (2026-08) ────────────────────────────────────────────────────────────────
/// HoldemTableN no longer escrows native PLS: every seat's buy-in moves via a MockX402 wrapper
/// token, pulled through a signed `DepositAuth` (see the contract's own header). `auth.from` is
/// the player identity — NOT necessarily `msg.sender` — so every seat-creating call site below
/// signs with the seat's OWN private key (`_pk(i)`) and prank-sends as that same address; balance
/// assertions read `token.balanceOf(...)` instead of native `.balance`. Call sites that only
/// exercise a revert reachable BEFORE `_pull` (every one of create/join's own guards) use the
/// `_createDummy`/`_joinDummy` garbage-auth helpers — mirrors ZkTableUnit.t.sol, the already-
/// migrated sibling suite for ZkTable's identical conversion.
contract HoldemTableNUnitTest is Test {
    HoldemTableN internal zk;
    MockGameRulesN internal rules;
    MockX402 internal token;
    address internal treasury = address(0x7);

    uint64 internal constant CLOCK = 30; // MIN_CLOCK_BLOCKS
    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHARE = 2;
    uint64 internal constant VALID_BEFORE = type(uint64).max;

    // secp256k1 generator — a convenient on-curve point for registerDeckKey in these tests.
    uint256 internal constant GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 internal constant GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;

    function _pk(uint256 i) internal pure returns (uint256) { return 0xA11CE + i * 0x1000 + 1; }

    function setUp() public {
        zk = new HoldemTableN(treasury, address(0)); // factory=0 skips the clone-check (unit tests fund via a bare MockX402)
        rules = new MockGameRulesN();
        token = new MockX402();
        // Generously fund every actor this file uses (seats 0..8 plus _pk(9), the "stranger"
        // pool), so no per-test minting/vm.deal is needed anywhere else.
        for (uint256 i = 0; i <= 9; i++) {
            token.mint(vm.addr(_pk(i)), 10_000_000 ether);
        }
    }

    // ── x402 deposit-auth helpers (mirrors ZkTableUnit.t.sol's idiom for HoldemTableN's shape) ──

    function _authFor(uint256 pk, address from, uint256 value, bytes32 nonce) internal returns (HoldemTableN.DepositAuth memory) {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, VALID_BEFORE, nonce);
        return HoldemTableN.DepositAuth({from: from, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    function _create(uint256 pk, address from, uint256 buyIn, IGameRulesN rules_, uint256 maxSeats, uint16 rakeBps, uint256 rakeCap, uint64 clock, address channelKey, uint256[2] memory deckKey)
        internal
        returns (bytes32 tableId)
    {
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), rules_, buyIn, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(pk, from, buyIn, nonce);
        vm.prank(from);
        tableId = zk.create(IX402Token(address(token)), rules_, buyIn, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey, auth);
    }

    function _join(uint256 pk, address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey) internal {
        bytes32 nonce = zk.joinNonce(tableId, from, channelKey, deckKey, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(pk, from, stake, nonce);
        vm.prank(from);
        zk.join(tableId, channelKey, deckKey, auth);
    }

    /// A garbage (unsigned, empty-sig) auth for `from`. Safe ONLY for call sites that revert
    /// before `_pull` is ever reached — every one of create/join's OWN guards
    /// (WrongValue/BadClock/BadRules/BadSeatCount/RakeTooHigh/BadDeckKey/BadStatus/
    /// TooManySeats/NotPlayer/DuplicateKey) runs before the token pull.
    function _dummyAuth(address from) internal pure returns (HoldemTableN.DepositAuth memory) {
        return HoldemTableN.DepositAuth({from: from, validBefore: 0, salt: bytes32(0), sig: ""});
    }

    function _createDummy(address from, uint256 buyIn, IGameRulesN rules_, uint256 maxSeats, uint16 rakeBps, uint256 rakeCap, uint64 clock, address channelKey, uint256[2] memory deckKey)
        internal
        returns (bytes32 tableId)
    {
        vm.prank(from);
        tableId = zk.create(IX402Token(address(token)), rules_, buyIn, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey, _dummyAuth(from));
    }

    function _joinDummy(address from, bytes32 tableId, address channelKey, uint256[2] memory deckKey) internal {
        vm.prank(from);
        zk.join(tableId, channelKey, deckKey, _dummyAuth(from));
    }

    // ── shared helpers (mirrors of the patterns in HoldemTableN.t.sol) ──────────────────

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

    /// Create only (1 seat, Forming). Each seat's channel key IS its wallet. Seat 0's deck key
    /// is the generator (on-curve) — create() now requires one directly, no separate registration.
    function _createOnly(uint256 buyIn, uint256 maxSeats) internal returns (bytes32 tableId) {
        address a0 = vm.addr(_pk(0));
        tableId = _create(_pk(0), a0, buyIn, IGameRulesN(address(rules)), maxSeats, 0, 0, CLOCK, a0, [GX, GY]);
    }

    /// Create + (n-1) joins, WITHOUT starting (still Forming, exactly n seats). Every seat's
    /// deck key is the generator (on-curve) — join() now requires one directly.
    function _createAndJoin(uint256 n, uint256 buyIn) internal returns (bytes32 tableId) {
        tableId = _createOnly(buyIn, n);
        for (uint256 i = 1; i < n; i++) {
            address ai = vm.addr(_pk(i));
            _join(_pk(i), ai, tableId, buyIn, ai, [GX, GY]);
        }
    }

    /// Create + (n-1) joins + start. Each seat's channel key IS its wallet. Every seat already
    /// has an on-curve deck key from create()/join() — no separate registration needed.
    function _table(uint256 n, uint256 buyIn) internal returns (bytes32 tableId) {
        tableId = _createAndJoin(n, buyIn);
        vm.prank(vm.addr(_pk(0)));
        zk.start(tableId);
    }

    /// Mirror of HoldemTableN._deckHash — the on-chain compressed-point packing over
    /// (c1x,c1y,c2x,c2y) tuples per slot, so tests can produce a deck array whose hash matches
    /// a chosen ChannelStateN.deckCommitment without needing real curve points.
    function _mirrorDeckHash(uint256[] memory deck) internal pure returns (bytes32) {
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

    /// Open a live table + a MOVE dispute naming `demandSeat`; returns the disputeState nonce
    /// used so callers can build strictly-newer states.
    function _openMoveDispute(bytes32 tableId, uint256 n, uint64 nonce, uint8 demandSeat)
        internal
        returns (ChannelStateN memory s)
    {
        s = _emptyState(tableId, n);
        s.nonce = nonce;
        s.balances[0] = n * 100; // arbitrary conserving split handled by caller's buyIn=100
        s.phase = 4;
        s.gameStateHash = keccak256("gs");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "gs", demandSeat, DEMAND_MOVE, 0);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // constructor
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_constructorTreasuryFallsBackToDeployer() public {
        HoldemTableN zk2 = new HoldemTableN(address(0), address(0));
        assertEq(zk2.treasury(), address(this), "treasury defaults to deployer");
    }

    function test_constructorTreasuryExplicit() public {
        HoldemTableN zk2 = new HoldemTableN(address(0x1234), address(0));
        assertEq(zk2.treasury(), address(0x1234), "explicit treasury honored");
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // create()
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_createRevertsZeroBuyIn() public {
        vm.expectRevert(ChannelTableBase.WrongValue.selector);
        _createDummy(address(this), 0, IGameRulesN(address(rules)), 2, 0, 0, CLOCK, address(0), [GX, GY]);
    }

    /// create()'s old msg.value-mismatch WrongValue check is gone along with msg.value itself:
    /// buyIn is passed once and used directly for the pull, with nothing left to compare it
    /// against. Structural replacement (mirrors ZkTableUnit.t.sol's
    /// test_join_revertsBadSig_authSignedForWrongAmount): createNonce binds buyIn into the create
    /// authorization's own nonce, so a caller who invokes create() with a DIFFERENT buyIn than
    /// what the signer actually authorized recomputes a different nonce; the token's signature
    /// recovery then fails against the original signature and the call reverts.
    function test_createRevertsBadSigWhenBuyInTamperedAfterSigning() public {
        address a0 = vm.addr(_pk(0));
        bytes32 nonce = zk.createNonce(a0, IX402Token(address(token)), IGameRulesN(address(rules)), 1 ether, 2, 0, 0, CLOCK, address(0), [GX, GY], bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(_pk(0), a0, 1 ether, nonce); // signed for buyIn = 1 ether
        vm.prank(a0);
        vm.expectRevert(); // MockX402.InvalidSignature — value/nonce recomputed for buyIn = 2 ether won't match
        zk.create(IX402Token(address(token)), IGameRulesN(address(rules)), 2 ether, 2, 0, 0, CLOCK, address(0), [GX, GY], auth);
    }

    function test_createRevertsClockTooLow() public {
        // NOTE: compute the bound BEFORE arming expectRevert — a view call made while
        // evaluating the create() arguments would otherwise consume the armed expectation.
        uint64 tooLow = zk.MIN_CLOCK_BLOCKS() - 1;
        vm.expectRevert(ChannelTableBase.BadClock.selector);
        _createDummy(address(this), 1 ether, IGameRulesN(address(rules)), 2, 0, 0, tooLow, address(0), [GX, GY]);
    }

    function test_createRevertsClockTooHigh() public {
        uint64 tooHigh = zk.MAX_CLOCK_BLOCKS() + 1;
        vm.expectRevert(ChannelTableBase.BadClock.selector);
        _createDummy(address(this), 1 ether, IGameRulesN(address(rules)), 2, 0, 0, tooHigh, address(0), [GX, GY]);
    }

    function test_createRevertsBadRules() public {
        vm.expectRevert(ChannelTableBase.BadRules.selector);
        // address(0x9999) has no code
        _createDummy(address(this), 1 ether, IGameRulesN(address(0x9999)), 2, 0, 0, CLOCK, address(0), [GX, GY]);
    }

    function test_createRevertsSeatCountTooLow() public {
        vm.expectRevert(HoldemTableN.BadSeatCount.selector);
        _createDummy(address(this), 1 ether, IGameRulesN(address(rules)), 1, 0, 0, CLOCK, address(0), [GX, GY]);
    }

    function test_createRevertsSeatCountTooHigh() public {
        uint256 tooManySeats = zk.MAX_SEATS() + 1;
        vm.expectRevert(HoldemTableN.BadSeatCount.selector);
        _createDummy(address(this), 1 ether, IGameRulesN(address(rules)), tooManySeats, 0, 0, CLOCK, address(0), [GX, GY]);
    }

    function test_createRevertsRakeTooHigh() public {
        uint16 tooMuchRake = uint16(zk.MAX_RAKE_BPS() + 1);
        vm.expectRevert(HoldemTableN.RakeTooHigh.selector);
        _createDummy(address(this), 1 ether, IGameRulesN(address(rules)), 2, tooMuchRake, 0, CLOCK, address(0), [GX, GY]);
    }

    /// HARDENING (Option B): a seat cannot come into existence without a valid on-curve deck
    /// key — create() now takes the key directly and rejects an off-curve point up front, before
    /// any seat is pushed. (Formerly this invariant was enforced only later, at start(), via a
    /// separate registerDeckKey() call gated by a start-time loop — see
    /// test_joinRevertsBadDeckKey below for the join() side of the same guarantee.)
    function test_createRevertsBadDeckKey() public {
        vm.expectRevert(HoldemTableN.BadDeckKey.selector);
        _createDummy(address(this), 1 ether, IGameRulesN(address(rules)), 2, 0, 0, CLOCK, address(0), [uint256(1), uint256(1)]);
    }

    function test_createChannelKeyDefaultsToSender() public {
        address from0 = vm.addr(_pk(0));
        bytes32 tableId = _create(_pk(0), from0, 1 ether, IGameRulesN(address(rules)), 2, 0, 0, CLOCK, address(0), [GX, GY]);
        assertEq(zk.seatAt(tableId, 0), from0, "seat 0 is creator");
        assertEq(zk.escrowOf(tableId, 0), 1 ether, "escrow recorded");
        assertEq(zk.totalEscrow(tableId), 1 ether, "totalEscrow matches");
        assertEq(zk.deckKeyOf(tableId, 0)[0], GX, "deck key set directly by create()");
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // join()
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_joinRevertsBadStatus() public {
        bytes32 tableId = _table(2, 1 ether); // Live already
        address stranger = vm.addr(_pk(9));
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        _joinDummy(stranger, tableId, stranger, [GX, GY]);
    }

    /// join()'s old msg.value-mismatch WrongValue check is gone: there is no caller-supplied
    /// amount anymore — it always pulls exactly t.buyIn, read from contract state. Structural
    /// replacement (mirrors ZkTableUnit.t.sol's test_join_revertsBadSig_authSignedForWrongAmount):
    /// a joiner who signs an authorization for a DIFFERENT value than t.buyIn produces a
    /// token-level digest join() can never match (value is baked into the wrapper's own signed
    /// struct), so join() reverts at the token (InvalidSignature), not via any HoldemTableN-level
    /// guard.
    function test_joinRevertsBadSigWhenAuthSignedForWrongAmount() public {
        bytes32 tableId = _createOnly(1 ether, 3);
        address a1 = vm.addr(_pk(1));
        bytes32 nonce = zk.joinNonce(tableId, a1, a1, [GX, GY], bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(_pk(1), a1, 0.5 ether, nonce); // signed for 0.5 ether, real pull is 1 ether
        vm.prank(a1);
        vm.expectRevert(); // MockX402.InvalidSignature
        zk.join(tableId, a1, [GX, GY], auth);
    }

    function test_joinRevertsTooManySeats() public {
        bytes32 tableId = _createAndJoin(2, 1 ether); // Forming, exactly at maxSeats(2)
        address a2 = vm.addr(_pk(2));
        vm.expectRevert(HoldemTableN.TooManySeats.selector);
        _joinDummy(a2, tableId, a2, [GX, GY]);
    }

    function test_joinRevertsNotPlayerSelfCollision() public {
        bytes32 tableId = _createOnly(1 ether, 3);
        address a0 = vm.addr(_pk(0));
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        _joinDummy(a0, tableId, a0, [GX, GY]); // already seat 0
    }

    function test_joinRevertsDuplicateKey() public {
        address a0 = vm.addr(_pk(0));
        address keyA = address(0xABCD);
        bytes32 tableId = _create(_pk(0), a0, 1 ether, IGameRulesN(address(rules)), 3, 0, 0, CLOCK, keyA, [GX, GY]);

        address a1 = vm.addr(_pk(1)); // a brand new wallet, not colliding with a0/keyA
        vm.expectRevert(HoldemTableN.DuplicateKey.selector);
        _joinDummy(a1, tableId, keyA, [GX, GY]); // channelKey collides with seat 0's channel key
    }

    /// HARDENING (Option B): the join() side of "a seat cannot exist without a valid on-curve
    /// deck key" — see test_createRevertsBadDeckKey for the create() side of the same guarantee.
    function test_joinRevertsBadDeckKey() public {
        bytes32 tableId = _createOnly(1 ether, 2);
        address a1 = vm.addr(_pk(1));
        vm.expectRevert(HoldemTableN.BadDeckKey.selector);
        _joinDummy(a1, tableId, a1, [uint256(1), uint256(1)]);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // start()
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_startRevertsBadStatus() public {
        bytes32 tableId = _table(2, 1 ether); // already Live
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.start(tableId);
    }

    function test_startRevertsNotPlayer() public {
        bytes32 tableId = _createOnly(1 ether, 2);
        address stranger = vm.addr(_pk(9));
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.start(tableId);
    }

    function test_startRevertsNotEnoughSeats() public {
        bytes32 tableId = _createOnly(1 ether, 3); // only 1 seat joined
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(HoldemTableN.NotEnoughSeats.selector);
        zk.start(tableId);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // registerDeckKey() — BadStatus / BadDeckKey / happy already covered in HoldemTableN.t.sol
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_registerDeckKeyRevertsNotPlayer() public {
        bytes32 tableId = _createOnly(1 ether, 2);
        address stranger = vm.addr(_pk(9));
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.registerDeckKey(tableId, [GX, GY]);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // leaveBeforeStart() — no prior coverage at all
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_leaveBeforeStartRevertsBadStatus() public {
        bytes32 tableId = _table(2, 1 ether); // Live
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.leaveBeforeStart(tableId);
    }

    function test_leaveBeforeStartRevertsNotPlayer() public {
        bytes32 tableId = _createOnly(1 ether, 2);
        address stranger = vm.addr(_pk(9));
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.leaveBeforeStart(tableId);
    }

    /// Middle seat leaves a 3-seat Forming table: refunded, arrays swap-and-pop compact.
    function test_leaveBeforeStartRefundsAndCompacts() public {
        uint256 buyIn = 1 ether;
        bytes32 tableId = _createAndJoin(3, buyIn);
        address seat1 = vm.addr(_pk(1));
        address seat2 = vm.addr(_pk(2));
        uint256 before = token.balanceOf(seat1);

        vm.prank(seat1);
        zk.leaveBeforeStart(tableId);

        assertEq(token.balanceOf(seat1) - before, buyIn, "seat 1 refunded its buy-in");
        assertEq(zk.seatCount(tableId), 2, "compacted to 2 seats");
        assertEq(zk.seatAt(tableId, 1), seat2, "former last seat swapped into freed slot");
        assertEq(zk.escrowOf(tableId, 1), buyIn, "escrow moved with the swap");
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Created), "still forming");
    }

    /// HARDENING (regression): _deckKey is indexed by seat, so leaveBeforeStart's swap-and-pop must
    /// move it with the swapped-down seat. Otherwise the seat now occupying the freed slot reads the
    /// DEPARTED seat's pubkey and can never answer a SHARE dispute (its honest proof fails verify ->
    /// force-folded on timeout) — a single-caller+sybil pot-theft primitive. Uses two distinct
    /// on-curve keys (G and 2G) so the move is observable via deckKeyOf.
    function test_leaveBeforeStartMovesDeckKeyWithSwappedSeat() public {
        uint256 g2x = 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5; // 2*G.x
        uint256 g2y = 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a; // 2*G.y
        // seat 0 gets G directly from create(), seat 1 gets 2G directly from join() — no
        // separate registerDeckKey() calls needed now that both are set at seating time.
        address a0 = vm.addr(_pk(0));
        bytes32 tableId = _create(_pk(0), a0, 1 ether, IGameRulesN(address(rules)), 2, 0, 0, CLOCK, a0, [GX, GY]);
        address a1 = vm.addr(_pk(1));
        _join(_pk(1), a1, tableId, 1 ether, a1, [g2x, g2y]);
        assertEq(zk.deckKeyOf(tableId, 0)[0], GX, "seat 0 key = G");
        assertEq(zk.deckKeyOf(tableId, 1)[0], g2x, "seat 1 key = 2G");

        // seat 0 leaves -> last seat (1) swap-and-popped down into index 0.
        vm.prank(a0);
        zk.leaveBeforeStart(tableId);

        assertEq(zk.seatAt(tableId, 0), a1, "former last seat now at index 0");
        assertEq(zk.deckKeyOf(tableId, 0)[0], g2x, "swapped seat's deck key moved down with it");
        assertEq(zk.deckKeyOf(tableId, 0)[1], g2y, "and its y-coord");
        assertEq(zk.deckKeyOf(tableId, 1)[0], 0, "vacated tail deck key cleared");
        assertEq(zk.deckKeyOf(tableId, 1)[1], 0, "and its y-coord");
    }

    /// The only remaining seat leaves: table auto-cancels and gets its full escrow back.
    function test_leaveBeforeStartLastSeatCancelsTable() public {
        uint256 buyIn = 1 ether;
        bytes32 tableId = _createOnly(buyIn, 2);
        address a0 = vm.addr(_pk(0));
        uint256 before = token.balanceOf(a0);

        vm.expectEmit(true, false, false, false, address(zk));
        emit HoldemTableN.TableCancelled(tableId);
        vm.prank(a0);
        zk.leaveBeforeStart(tableId);

        assertEq(token.balanceOf(a0) - before, buyIn, "sole seat refunded");
        assertEq(zk.seatCount(tableId), 0, "no seats left");
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Cancelled), "auto-cancelled");
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // cancel()
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_cancelRevertsBadStatus() public {
        bytes32 tableId = _table(2, 1 ether); // Live
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.cancel(tableId);
    }

    function test_cancelRevertsNotPlayerTooManySeats() public {
        bytes32 tableId = _createAndJoin(2, 1 ether); // 2 seats joined, still Forming
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancel(tableId); // seats.length != 1
    }

    function test_cancelRevertsNotPlayerWrongCaller() public {
        bytes32 tableId = _createOnly(1 ether, 2);
        address stranger = vm.addr(_pk(9));
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancel(tableId);
    }

    function test_cancelHappyRefundsSoleSeat() public {
        uint256 buyIn = 1 ether;
        bytes32 tableId = _createOnly(buyIn, 2);
        address a0 = vm.addr(_pk(0));
        uint256 before = token.balanceOf(a0);

        vm.prank(a0);
        zk.cancel(tableId);

        assertEq(token.balanceOf(a0) - before, buyIn, "creator refunded");
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Cancelled), "cancelled");
        assertEq(zk.escrowOf(tableId, 0), 0, "escrow zeroed");
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // settle() — extra reverts beyond ConservationViolated / BadSig / RakeTooHigh(cap)
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_settleRevertsBadStatus() public {
        bytes32 tableId = _createOnly(1 ether, 2); // Forming, not Live
        ChannelStateN memory s = _emptyState(tableId, 1);
        bytes[] memory sigs = new bytes[](1);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.settle(tableId, s, sigs);
    }

    // settle/respondWithState are now fully permissionless (no _seatOf gate) — see
    // HoldemTableNX402.t.sol's dedicated permissionless-settle/-respond coverage.

    function test_settleRevertsWrongTable() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        // The outer `tableId` param must reference a REAL Live table (else BadStatus fires
        // first, since a nonexistent table's default status is None) — the mismatch has to be
        // in the co-signed state's OWN `.tableId` field, which _checkCoSigned compares against
        // the outer param.
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.tableId = keccak256("not-this-table"); // embedded id != the real, outer tableId
        s.nonce = 1;
        s.balances[0] = n * buyIn;
        s.phase = 11;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.WrongTable.selector);
        zk.settle(tableId, s, sigs);
    }

    function test_settleRevertsBadSeatCountBalances() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n - 1); // wrong length
        s.nonce = 1;
        s.phase = 11;
        bytes[] memory sigs = new bytes[](n - 1);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(HoldemTableN.BadSeatCount.selector);
        zk.settle(tableId, s, sigs);
    }

    function test_settleRevertsWrongSigCount() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * buyIn;
        s.phase = 11;
        bytes[] memory sigs = new bytes[](n - 1); // too few sigs
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(HoldemTableN.WrongSigCount.selector);
        zk.settle(tableId, s, sigs);
    }

    function test_settleRevertsNotFinal() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        rules.setFinalAll(false);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * buyIn;
        s.phase = 11;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.NotFinal.selector);
        zk.settle(tableId, s, sigs);
    }

    function test_settleRevertsPotNotZero() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * buyIn - 1;
        s.pot = 1; // nonzero pot on a settle attempt
        s.phase = 11;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.PotNotZero.selector);
        zk.settle(tableId, s, sigs);
    }

    function test_settleRevertsPotNotZeroSidePots() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * buyIn - 1;
        s.sidePots = new SidePot[](1);
        s.sidePots[0] = SidePot({amount: 1, eligibleMask: 0x1});
        s.phase = 11;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.PotNotZero.selector);
        zk.settle(tableId, s, sigs);
    }

    /// settle's `<=` StaleNonce check: after a dispute round-trip pins checkpointNonce, a
    /// settle at the SAME nonce (not just older) is rejected.
    function test_settleRevertsStaleNonceAtCheckpoint() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);

        // open + resolve a dispute to pin checkpointNonce = 6, back to Live.
        ChannelStateN memory dispute = _emptyState(tableId, n);
        dispute.nonce = 5;
        dispute.balances[0] = n * buyIn;
        dispute.phase = 4;
        dispute.gameStateHash = keccak256("g");
        bytes[] memory disputeSigs = _coSign(n, dispute);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, dispute, disputeSigs, "g", 0, DEMAND_MOVE, 0);

        ChannelStateN memory resp = _emptyState(tableId, n);
        resp.nonce = 6;
        resp.balances[0] = n * buyIn;
        resp.phase = 4;
        bytes[] memory respSigs = _coSign(n, resp);
        vm.prank(vm.addr(_pk(0)));
        zk.respondWithState(tableId, resp, respSigs);
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "back to live");

        // settle at nonce == checkpointNonce (6) -> StaleNonce
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 6;
        s.balances[0] = n * buyIn;
        s.phase = 11;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.StaleNonce.selector);
        zk.settle(tableId, s, sigs);
    }

    /// settle's own `_checkRake`: rakeAccrued within cap but exceeding the rakeBps ratio of the
    /// reconstructed gross (balances + rake). Distinct branch from openDispute's cap-only check.
    /// settle's own `_checkRake` cap check (`rakeAccrued > t.rakeCap`) — a distinct call site
    /// from openDispute's identical-looking cap check (test_openDisputeRejectsOverCapRake in
    /// HoldemTableN.t.sol only exercises the openDispute call site).
    function test_settleRevertsRakeTooHighOverCap() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        uint256 total = n * buyIn;
        uint256 rakeCap = 5;
        address a0 = vm.addr(_pk(0));
        bytes32 tableId = _create(_pk(0), a0, buyIn, IGameRulesN(address(rules)), n, 250, rakeCap, CLOCK, a0, [GX, GY]);
        address a1 = vm.addr(_pk(1));
        _join(_pk(1), a1, tableId, buyIn, a1, [GX, GY]);
        vm.prank(a0);
        zk.start(tableId);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.rakeAccrued = 10; // > rakeCap (5)
        s.balances[0] = total - s.rakeAccrued;
        s.phase = 11;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(a0);
        vm.expectRevert(HoldemTableN.RakeTooHigh.selector);
        zk.settle(tableId, s, sigs);
    }

    function test_settleRevertsRakeTooHighBpsRatio() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        uint256 total = n * buyIn; // 200
        address a0 = vm.addr(_pk(0));
        // rakeBps 0.5% (50), rakeCap loose (1000) so the cap never binds — only the ratio does.
        bytes32 tableId = _create(_pk(0), a0, buyIn, IGameRulesN(address(rules)), n, 50, 1000, CLOCK, a0, [GX, GY]);
        address a1 = vm.addr(_pk(1));
        _join(_pk(1), a1, tableId, buyIn, a1, [GX, GY]);
        vm.prank(a0);
        zk.start(tableId);

        // gross = rake(2) + balances(198) = 200; bps bound = 50/10000*200 = 1 < rake(2).
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = total - 2 - 0;
        s.balances[1] = 0;
        s.rakeAccrued = 2;
        s.phase = 11;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(a0);
        vm.expectRevert(HoldemTableN.RakeTooHigh.selector);
        zk.settle(tableId, s, sigs);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // openDispute() — extra reverts beyond RakeTooHigh(cap) / NotYourTurn
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_openDisputeRevertsBadStatus() public {
        bytes32 tableId = _createOnly(1 ether, 2); // Forming
        ChannelStateN memory s = _emptyState(tableId, 1);
        bytes[] memory sigs = new bytes[](1);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.openDispute(tableId, s, sigs, "", 0, DEMAND_MOVE, 0);
    }

    function test_openDisputeRevertsNotPlayer() public {
        bytes32 tableId = _table(2, 1 ether);
        ChannelStateN memory s = _emptyState(tableId, 2);
        bytes[] memory sigs = new bytes[](2);
        address stranger = vm.addr(_pk(9));
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.openDispute(tableId, s, sigs, "", 0, DEMAND_MOVE, 0);
    }

    /// openDispute's `<` StaleNonce check: strictly older than the pinned checkpoint is
    /// rejected (equal is allowed — a different operator from settle's `<=`).
    function test_openDisputeRevertsStaleNonce() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);

        // pin checkpointNonce = 6 via a dispute round-trip.
        ChannelStateN memory dispute = _emptyState(tableId, n);
        dispute.nonce = 5;
        dispute.balances[0] = n * buyIn;
        dispute.phase = 4;
        dispute.gameStateHash = keccak256("g");
        bytes[] memory disputeSigs = _coSign(n, dispute);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, dispute, disputeSigs, "g", 0, DEMAND_MOVE, 0);

        ChannelStateN memory resp = _emptyState(tableId, n);
        resp.nonce = 6;
        resp.balances[0] = n * buyIn;
        resp.phase = 4;
        bytes[] memory respSigs = _coSign(n, resp);
        vm.prank(vm.addr(_pk(0)));
        zk.respondWithState(tableId, resp, respSigs);

        // re-open with an older nonce (5 < checkpoint 6) -> StaleNonce
        ChannelStateN memory s2 = _emptyState(tableId, n);
        s2.nonce = 5;
        s2.balances[0] = n * buyIn;
        s2.phase = 4;
        s2.gameStateHash = keccak256("g2");
        bytes[] memory sigs2 = _coSign(n, s2);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.StaleNonce.selector);
        zk.openDispute(tableId, s2, sigs2, "g2", 0, DEMAND_MOVE, 0);
    }

    function test_openDisputeRevertsBadGameState() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * buyIn;
        s.phase = 4;
        s.gameStateHash = keccak256("real");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadGameState.selector);
        zk.openDispute(tableId, s, sigs, "fake", 0, DEMAND_MOVE, 0); // hash("fake") != hash("real")
    }

    function test_openDisputeRevertsBadDemand() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * buyIn;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(tableId, s, sigs, "g", 0, 3, 0); // demandKind neither MOVE nor SHARE
    }

    function test_openDisputeRevertsSeatRange() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * buyIn;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(HoldemTableN.SeatRange.selector);
        zk.openDispute(tableId, s, sigs, "g", 5, DEMAND_MOVE, 0); // seat 5 doesn't exist (n=2)
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // respondWithState() — extra reverts beyond ConservationViolated (tested elsewhere)
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_respondWithStateRevertsBadStatus() public {
        bytes32 tableId = _table(2, 1 ether); // Live, not Disputed
        ChannelStateN memory s = _emptyState(tableId, 2);
        bytes[] memory sigs = new bytes[](2);
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.respondWithState(tableId, s, sigs);
    }

    // settle/respondWithState are now fully permissionless (no _seatOf gate) — see
    // HoldemTableNX402.t.sol's dedicated permissionless-settle/-respond coverage.

    /// respondWithState's own StaleNonce check compares against disputeState.nonce directly.
    function test_respondWithStateRevertsStaleNonce() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        _openMoveDisputeSimple(tableId, n, 3, 0);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 3; // equal to disputeState.nonce -> not strictly newer
        s.balances[0] = n * 100;
        s.phase = 4;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.StaleNonce.selector);
        zk.respondWithState(tableId, s, sigs);
    }

    /// Small helper distinct from `_openMoveDispute` (which hardcodes buyIn=100 assumptions):
    /// opens a MOVE dispute at `nonce` naming `demandSeat`, with buyIn == 100 per seat.
    function _openMoveDisputeSimple(bytes32 tableId, uint256 n, uint64 nonce, uint8 demandSeat) internal {
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = nonce;
        s.balances[0] = n * 100;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", demandSeat, DEMAND_MOVE, 0);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // respondWithMove() — ZERO prior coverage (not touched by any existing test file)
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_respondWithMoveRevertsBadStatus() public {
        bytes32 tableId = _table(2, 100); // Live, not Disputed
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.respondWithMove(tableId, "g", "move");
    }

    function test_respondWithMoveRevertsNotDemanded() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        // open a SHARE dispute instead of MOVE
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * 100;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        s.deckCommitment = keccak256("deck"); // a SHARE dispute is over a committed deck
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_SHARE, 0);

        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.NotDemanded.selector);
        zk.respondWithMove(tableId, "g", "move");
    }

    function test_respondWithMoveRevertsNotYourDispute() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        _openMoveDisputeSimple(tableId, n, 1, 0); // demand seat 0
        vm.prank(vm.addr(_pk(1))); // seat 1, not the demanded seat
        vm.expectRevert(ChannelTableBase.NotYourDispute.selector);
        zk.respondWithMove(tableId, "g", "move");
    }

    function test_respondWithMoveRevertsBadGameState() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        _openMoveDisputeSimple(tableId, n, 1, 0);
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadGameState.selector);
        zk.respondWithMove(tableId, "wrong-preimage", "move");
    }

    function test_respondWithMoveRevertsIllegalMovePropagates() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        _openMoveDisputeSimple(tableId, n, 1, 0);
        rules.setApply("", true); // MockGameRulesN.applyMove reverts
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(bytes("mock: illegal"));
        zk.respondWithMove(tableId, "g", "move");
    }

    function test_respondWithMoveHappyClearsDispute() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        _openMoveDisputeSimple(tableId, n, 1, 0);
        rules.setApply("new-state", false);

        vm.expectEmit(true, false, false, true, address(zk));
        emit HoldemTableN.DisputeAnsweredWithMove(tableId, "move", keccak256("new-state"));
        vm.prank(vm.addr(_pk(0)));
        zk.respondWithMove(tableId, "g", "move");

        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "dispute cleared");
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // respondWithShare() — branches reachable WITHOUT a valid DLEQ proof (no ffi needed)
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_respondWithShareRevertsNotDemanded() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        _openMoveDisputeSimple(tableId, n, 1, 0); // MOVE dispute, not SHARE
        uint256[] memory deck = new uint256[](0);
        uint256[2] memory share;
        uint256[5] memory proof;
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.NotDemanded.selector);
        zk.respondWithShare(tableId, deck, share, proof);
    }

    function test_respondWithShareRevertsNotYourDispute() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * 100;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        s.deckCommitment = keccak256("deck"); // a SHARE dispute is over a committed deck
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_SHARE, 0); // demand seat 0

        uint256[] memory deck = new uint256[](0);
        uint256[2] memory share;
        uint256[5] memory proof;
        vm.prank(vm.addr(_pk(1))); // wrong seat
        vm.expectRevert(ChannelTableBase.NotYourDispute.selector);
        zk.respondWithShare(tableId, deck, share, proof);
    }

    function test_respondWithShareRevertsBadDeck() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * 100;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        s.deckCommitment = keccak256("some-committed-deck");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_SHARE, 0);

        uint256[] memory deck = new uint256[](4);
        deck[0] = 1; deck[1] = 2; deck[2] = 3; deck[3] = 4; // hash won't match deckCommitment
        uint256[2] memory share;
        uint256[5] memory proof;
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDeck.selector);
        zk.respondWithShare(tableId, deck, share, proof);
    }

    /// `_deckHash`'s OWN length guard (`deck.length % 4 != 0`) — a different reason for BadDeck
    /// than a hash mismatch (test_respondWithShareRevertsBadDeck above): a malformed deck array
    /// whose length isn't a multiple of 4 (not a whole number of (c1,c2) card tuples).
    function test_respondWithShareRevertsBadDeckMisalignedLength() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * 100;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        s.deckCommitment = keccak256("whatever"); // never reached — length check reverts first
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_SHARE, 0);

        uint256[] memory deck = new uint256[](5); // not a multiple of 4
        uint256[2] memory share;
        uint256[5] memory proof;
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDeck.selector);
        zk.respondWithShare(tableId, deck, share, proof);
    }

    /// respondWithShare's OWN BadDemand check (the demanded slot's 4-word window falls outside
    /// the supplied deck array) — a different code path from openDispute's demandKind BadDemand.
    function test_respondWithShareRevertsBadDemandSlotOutOfRange() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        uint256[] memory deck = new uint256[](4); // 1 slot only (slot 0)
        deck[0] = 11; deck[1] = 22; deck[2] = 33; deck[3] = 44;
        bytes32 commitment = _mirrorDeckHash(deck);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * 100;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        s.deckCommitment = commitment;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_SHARE, 3); // slot 3 -> base 12 > deck.length(4)

        uint256[2] memory share;
        uint256[5] memory proof;
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.respondWithShare(tableId, deck, share, proof);
    }

    /// HARDENING (Option B): a seat cannot come into existence without a valid on-curve deck key
    /// — create()/join() require and validate one directly (see test_createRevertsBadDeckKey /
    /// test_joinRevertsBadDeckKey), so a table can never reach Live with an unregistered seat and
    /// start() no longer needs (or has) a key-completeness gate. This makes respondWithShare's
    /// DeckKeyNotSet an unreachable assert. (Formerly this coverage lived here as
    /// test_startRevertsWhenASeatHasNoDeckKey / test_respondWithShareRevertsDeckKeyNotSet, both
    /// scenarios that are now unreachable by construction — moved to the new enforcement point.)

    /// A garbage (off-curve / all-zero) proof fails `RevealShareDLEQ.verify` — which returns
    /// `false` rather than reverting on malformed input — so this reaches BadShareProof without
    /// needing a real Chaum-Pedersen proof (no ffi required). The genuine PASSING-proof path
    /// (verify() == true -> DisputeAnsweredWithShare + _clearDispute) is the one branch this
    /// suite intentionally defers to the `ffi` profile (HoldemShareDispute.t.sol) — it requires
    /// a proof that satisfies both DLEQ equations against the off-chain prover's exact encoding.
    function test_respondWithShareRevertsBadShareProofGarbage() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100); // seat 0 has a real on-curve key
        uint256[] memory deck = new uint256[](4);
        deck[0] = 11; deck[1] = 22; deck[2] = 33; deck[3] = 44;
        bytes32 commitment = _mirrorDeckHash(deck);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = n * 100;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        s.deckCommitment = commitment;
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_SHARE, 0);

        uint256[2] memory share; // (0,0) - off curve
        uint256[5] memory proof; // all zero
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(HoldemTableN.BadShareProof.selector);
        zk.respondWithShare(tableId, deck, share, proof);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // resolveTimeout() — extra reverts + the "unreachable" _distribute sink revisited
    // ══════════════════════════════════════════════════════════════════════════════════

    function test_resolveTimeoutRevertsBadStatus() public {
        bytes32 tableId = _table(2, 100); // Live, not Disputed
        vm.expectRevert(ChannelTableBase.BadStatus.selector);
        zk.resolveTimeout(tableId);
    }

    function test_resolveTimeoutRevertsClockNotExpired() public {
        uint256 n = 2;
        bytes32 tableId = _table(n, 100);
        _openMoveDisputeSimple(tableId, n, 1, 0);
        vm.expectRevert(ChannelTableBase.ClockNotExpired.selector);
        zk.resolveTimeout(tableId); // clock not rolled forward
    }

    /// BUG FIX (was: `_distribute`'s `count == 0` branch, formerly documented as "unreachable
    /// with an honest majority"). Nothing on-chain enforced that a side-pot's `eligibleMask`
    /// actually reflected real game eligibility (it only needed Sigma-conserving co-signed
    /// sigs). A side pot whose ONLY eligible seat was the one later forced-folded drove the
    /// mask to empty after `& ~(1<<forfeit)` in resolveTimeout, and the old code silently
    /// sank the orphaned amount into payouts[0] — misdirecting funds to seat 0 even when seat 0
    /// was never eligible for that pot. A real side-pot always has >=2 contestants when it is
    /// created, so a co-signed dispute state naming only the about-to-forfeit seat as eligible is
    /// ill-formed; openDispute now rejects it outright (BadDemand) before it can ever become
    /// disputeState, so resolveTimeout can never reach that orphaned-pot situation.
    function test_openDisputeRevertsWhenSidePotWouldOrphanOnForfeit() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        uint256 total = n * buyIn; // 200
        bytes32 tableId = _table(n, buyIn);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = 0;
        s.balances[1] = 0;
        s.pot = 0;
        s.sidePots = new SidePot[](1);
        s.sidePots[0] = SidePot({amount: total, eligibleMask: 0x1}); // ONLY seat 0 eligible
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);

        // demanding of seat 0 — the side pot's sole eligible seat — would orphan it on forfeit.
        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_MOVE, 0);

        // the table is untouched: still Live, no dispute state pinned.
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "rejected dispute must not open");
    }

    /// Companion positive case: a side pot naming a DIFFERENT seat as eligible (in addition to
    /// the forfeiting seat) survives the openDispute guard and resolveTimeout still splits it
    /// correctly among the remaining eligible seats — the fix does not reject legitimate states.
    function test_resolveTimeoutDistributesSidePotAmongSurvivingEligibleSeats() public {
        uint256 n = 3;
        uint256 buyIn = 100;
        uint256 total = n * buyIn; // 300
        bytes32 tableId = _table(n, buyIn);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.pot = 0;
        s.sidePots = new SidePot[](1);
        // seats 1 and 2 eligible; seat 0 (the one about to be demanded-of/forfeited) is not.
        s.sidePots[0] = SidePot({amount: total, eligibleMask: (1 << 1) | (1 << 2)});
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_MOVE, 0); // forfeit seat 0

        vm.roll(block.number + CLOCK + 1);
        uint256 before0 = token.balanceOf(vm.addr(_pk(0)));
        uint256 before1 = token.balanceOf(vm.addr(_pk(1)));
        uint256 before2 = token.balanceOf(vm.addr(_pk(2)));
        zk.resolveTimeout(tableId);

        // removing seat 0 from the mask leaves seats 1 and 2 -> split evenly (300/2 = 150 each).
        assertEq(token.balanceOf(vm.addr(_pk(0))) - before0, 0, "forfeiting seat gets nothing from the side pot");
        assertEq(token.balanceOf(vm.addr(_pk(1))) - before1, 150, "seat 1 share");
        assertEq(token.balanceOf(vm.addr(_pk(2))) - before2, 150, "seat 2 share");
        assertEq(token.balanceOf(address(zk)), 0, "no residue");
    }

    /// Covers `_distribute`'s `count == 0 -> BadDemand` guard, which the openDispute orphan-check
    /// (test_openDisputeRevertsWhenSidePotWouldOrphanOnForfeit) does NOT catch. That check only
    /// rejects an IN-RANGE mask emptied by the forfeit (`eligibleMask & ~demandBit == 0`). But
    /// nothing validates that a side pot's `eligibleMask` bits fall inside the seat range [0, n):
    /// a co-signed side pot whose only set bit is OUT OF RANGE (here bit 5 with n = 2) survives
    /// openDispute (`(1<<5) & ~(1<<0) != 0`), yet `_distribute`'s popcount over `payouts.length`
    /// seats yields count == 0 -> the guard fires. Reaching it needs an ill-formed N-of-N
    /// co-signed state (every seat signs a mask naming a non-existent seat), so it is a
    /// collusion/broken-client path — but it is reachable, and the guard reverts cleanly instead
    /// of dividing by zero. This pins that behavior.
    /// HARDENING (input validation): a side pot whose eligibleMask names a seat OUTSIDE [0, n) is
    /// now rejected at the trust boundary in _checkCoSigned (covers openDispute AND respondWithState),
    /// so it can never become disputeState. Previously it survived openDispute's orphan check and
    /// either fund-locked resolveTimeout (all-out-of-range -> _distribute count==0) or silently paid
    /// the wrong seats (partially out-of-range). Here bit 5 is outside seats {0,1}.
    function test_openDisputeRejectsSidePotMaskOutOfSeatRange() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        uint256 total = n * buyIn; // 200
        bytes32 tableId = _table(n, buyIn);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.pot = 0;
        s.sidePots = new SidePot[](1);
        s.sidePots[0] = SidePot({amount: total, eligibleMask: (1 << 5)}); // bit 5 ∉ {0,1}
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);

        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(tableId, s, sigs, "g", 0, DEMAND_MOVE, 0);
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "malformed mask must not open a dispute");
    }

    /// HARDENING (input validation): a SHARE demand naming an out-of-range deck slot is unanswerable
    /// by construction (respondWithShare reads t.demandSlot, not a caller arg), so left unbounded a
    /// single seat could open a dispute no honest counterparty can clear and take the pot on timeout.
    /// openDispute now rejects demandSlot > 51 up front.
    function test_openDisputeRejectsShareDemandSlotOutOfRange() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.pot = uint256(n) * buyIn; // conserved
        s.deckCommitment = keccak256("deck"); // non-zero so we isolate the slot bound
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);

        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(tableId, s, sigs, "g", 1, DEMAND_SHARE, 52); // slot 52 > 51
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "out-of-range SHARE slot must not open a dispute");
    }

    /// HARDENING (input validation): a SHARE demand against a state with NO committed deck
    /// (deckCommitment == 0) is likewise unanswerable (_deckHash of any deck is never 0), so it is
    /// rejected up front.
    function test_openDisputeRejectsShareDemandWithoutDeckCommitment() public {
        uint256 n = 2;
        uint256 buyIn = 100;
        bytes32 tableId = _table(n, buyIn);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.pot = uint256(n) * buyIn; // conserved
        s.deckCommitment = bytes32(0); // no committed deck
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        bytes[] memory sigs = _coSign(n, s);

        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openDispute(tableId, s, sigs, "g", 1, DEMAND_SHARE, 0); // valid slot, but no deck committed
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "SHARE demand w/o deck must not open a dispute");
    }
}

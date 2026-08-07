// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelStateN, SidePot} from "../../contracts/zk/ChannelStateN.sol";
import {IGameRulesN} from "../../contracts/zk/IGameRulesN.sol";
import {MockGameRulesN} from "../../contracts/test/MockGameRulesN.sol";
import {MockX402, Mock1271Wallet} from "../../contracts/test/MockX402.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {X402AuthLib} from "./X402AuthLib.sol";

/// A minimal ValveWrapperFactory stand-in for the `create()` clone-check: `wrapperOf(underlying)`
/// returns whatever address was registered for that underlying (or address(0) if none), exactly
/// mirroring the real factory's CREATE2-predicted-address semantics for test purposes. (Mirrors
/// ZkTableX402.t.sol's own MockWrapperFactory — a separate, file-local copy so this suite has no
/// import dependency on ZkTable's test file.)
contract HoldemMockWrapperFactory {
    mapping(address => address) public wrapperOf_;

    function register(address underlying, address wrapper) external {
        wrapperOf_[underlying] = wrapper;
    }

    function wrapperOf(address underlying) external view returns (address) {
        return wrapperOf_[underlying];
    }
}

/// @notice The x402 asset-plumbing conversion's own dedicated coverage for HoldemTableN (N-party
/// sibling of ZkTableX402.t.sol): relayer-vs-player identity separation across N seats, the
/// nonce-tamper seat-hijack closure (one test per bound term — including the N-party-only
/// maxSeats/rakeBps/rakeCap terms), replay/nonce-burn semantics, the EIP-7598 ERC-1271 path,
/// settle/respondWithState permissionlessness (and that the OTHER seat-gated functions did NOT
/// become permissionless), the factory clone-check, and a full multi-seat cycle with rake landing
/// on the treasury in the wrapper token with zero dust. Companion to the migrated
/// HoldemTableNUnit/HoldemTableN/HoldemTableNShowdown/HoldemTableNInvariant/HoldemShareDispute
/// suites, which re-exercise HoldemTableN's PRE-EXISTING business logic (now funded via x402) —
/// this file is only the NEW attack surface.
contract HoldemTableNX402Test is Test {
    HoldemTableN internal zk;
    MockGameRulesN internal rules;
    MockX402 internal token;

    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    uint256 internal constant PK_C = 0xC0FFEE;
    uint256 internal constant PK_D = 0xD00D;
    address internal a;
    address internal b;
    address internal c;
    address internal d;
    address internal relayer = address(0xBEEF);

    uint64 internal constant CLOCK = 30;
    // HoldemTableN validates every deck key is on-curve (Option B hardening) — unlike ZkTable,
    // (0,0) is rejected with BadDeckKey, so tests need real on-curve points. GX/GY is the
    // secp256k1 generator; G2X/G2Y is 2*G — a SECOND, distinct on-curve point used only by the
    // deckKey-tamper test (swapping the whole signed point, since flipping a single coordinate
    // of an on-curve point generally produces an off-curve one, which would hit BadDeckKey
    // before ever reaching the nonce/signature check under test).
    uint256 internal constant GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 internal constant GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;
    uint256 internal constant G2X = 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5;
    uint256 internal constant G2Y = 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a;
    uint256[2] internal DECK_KEY_A = [GX, GY];
    uint256[2] internal DECK_KEY_B = [G2X, G2Y];
    uint64 internal constant VALID_BEFORE = type(uint64).max;

    function setUp() public {
        zk = new HoldemTableN(address(0x7), address(0)); // factory=0: the clone-check has its own dedicated tests below
        rules = new MockGameRulesN();
        token = new MockX402();
        a = vm.addr(PK_A);
        b = vm.addr(PK_B);
        c = vm.addr(PK_C);
        d = vm.addr(PK_D);
        token.mint(a, 1_000_000 ether);
        token.mint(b, 1_000_000 ether);
        token.mint(c, 1_000_000 ether);
        token.mint(d, 1_000_000 ether);
    }

    // ── shared helpers ───────────────────────────────────────────────────────

    function _authFor(uint256 pk, address from, uint256 value, bytes32 nonce) internal returns (HoldemTableN.DepositAuth memory) {
        return _authForSalt(pk, from, value, nonce, bytes32(0));
    }

    /// Like `_authFor` but with an explicit `salt` in the returned auth (needed wherever the
    /// nonce itself was computed with a non-zero salt — e.g. `joinNonce`'s rejoin-liveness salt,
    /// see F2 — since `join()`/`create()` recompute the nonce from `auth.salt`, not a caller arg).
    function _authForSalt(uint256 pk, address from, uint256 value, bytes32 nonce, bytes32 salt) internal returns (HoldemTableN.DepositAuth memory) {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, VALID_BEFORE, nonce);
        return HoldemTableN.DepositAuth({from: from, validBefore: VALID_BEFORE, salt: salt, sig: X402AuthLib.sign65(pk, digest)});
    }

    function _createAuth(
        address from,
        uint256 buyIn,
        IGameRulesN rules_,
        uint256 maxSeats,
        uint16 rakeBps,
        uint256 rakeCap,
        uint64 clock,
        address channelKey,
        uint256[2] memory deckKey,
        uint256 pk
    ) internal returns (HoldemTableN.DepositAuth memory) {
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), rules_, buyIn, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey, bytes32(0));
        return _authFor(pk, from, buyIn, nonce);
    }

    function _joinAuth(address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey, uint256 pk)
        internal
        returns (HoldemTableN.DepositAuth memory)
    {
        return _joinAuthSalted(from, tableId, stake, channelKey, deckKey, pk, bytes32(0));
    }

    /// Like `_joinAuth` but with an explicit `salt` — see F2's rejoin-liveness note on
    /// `joinNonce`. Needed for `test_rejoinAfterLeave_freshSaltSucceeds_sameSaltReplayDies`.
    function _joinAuthSalted(address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey, uint256 pk, bytes32 salt)
        internal
        returns (HoldemTableN.DepositAuth memory)
    {
        bytes32 nonce = zk.joinNonce(tableId, from, channelKey, deckKey, salt);
        return _authForSalt(pk, from, stake, nonce, salt);
    }

    function _create(
        uint256 pk,
        address from,
        uint256 buyIn,
        IGameRulesN rules_,
        uint256 maxSeats,
        uint16 rakeBps,
        uint256 rakeCap,
        uint64 clock,
        address channelKey,
        uint256[2] memory deckKey
    ) internal returns (bytes32 tableId) {
        HoldemTableN.DepositAuth memory auth = _createAuth(from, buyIn, rules_, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey, pk);
        vm.prank(relayer); // every happy-path helper submits via a RELAYER, never the player itself
        tableId = zk.create(IX402Token(address(token)), rules_, buyIn, maxSeats, rakeBps, rakeCap, clock, channelKey, deckKey, auth);
    }

    function _join(uint256 pk, address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey) internal {
        HoldemTableN.DepositAuth memory auth = _joinAuth(from, tableId, stake, channelKey, deckKey, pk);
        vm.prank(relayer);
        zk.join(tableId, channelKey, deckKey, auth);
    }

    /// Like `_join` but with an explicit `salt` — see F2's rejoin-liveness note on `joinNonce`.
    function _joinSalted(uint256 pk, address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey, bytes32 salt)
        internal
    {
        HoldemTableN.DepositAuth memory auth = _joinAuthSalted(from, tableId, stake, channelKey, deckKey, pk, salt);
        vm.prank(relayer);
        zk.join(tableId, channelKey, deckKey, auth);
    }

    /// Create (seat 0 = a) + join b,c: a 3-seat table, buyIn/rake as given, every deposit
    /// relayed by `relayer`.
    function _createJoin3(uint256 buyIn, uint16 rakeBps, uint256 rakeCap) internal returns (bytes32 tableId) {
        IGameRulesN r = IGameRulesN(address(rules));
        tableId = _create(PK_A, a, buyIn, r, 3, rakeBps, rakeCap, CLOCK, address(0), DECK_KEY_A);
        _join(PK_B, b, tableId, buyIn, address(0), DECK_KEY_A);
        _join(PK_C, c, tableId, buyIn, address(0), DECK_KEY_A);
    }

    function _coSign(uint256 n, ChannelStateN memory s, uint256[] memory pks) internal view returns (bytes[] memory sigs) {
        bytes32 digest = zk.stateDigest(s);
        sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pks[i], digest);
            sigs[i] = abi.encodePacked(r, ss, v);
        }
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

    // ═══════════════════════════════════════════════════════════════════════
    // Relayer-submits-not-player — across N seats
    // ═══════════════════════════════════════════════════════════════════════

    /// A relayer creates + joins a 3-seat table entirely on the players' behalf: every seat's
    /// identity lands on the SIGNER (auth.from), never on the relayer; the relayer never holds
    /// any escrowed token; settle (submitted by yet another stranger) pays the real seats.
    function test_relayer_createJoinSettle_landsOnAuthFrom_acrossNSeats() public {
        bytes32 id = _createJoin3(1 ether, 0, 0);
        assertEq(zk.seatAt(id, 0), a, "seat 0 is the create signer, not the relayer");
        assertEq(zk.seatAt(id, 1), b, "seat 1 is the first join signer, not the relayer");
        assertEq(zk.seatAt(id, 2), c, "seat 2 is the second join signer, not the relayer");
        assertEq(token.balanceOf(relayer), 0, "the relayer never held any of the escrowed tokens");
        assertEq(token.balanceOf(address(zk)), 3 ether, "exactly Sigma buy-ins escrowed");

        vm.prank(a);
        zk.start(id);

        ChannelStateN memory s = _emptyState(id, 3);
        s.nonce = 1;
        s.balances[0] = 1.5 ether;
        s.balances[1] = 1 ether;
        s.balances[2] = 0.5 ether;
        s.phase = 11;
        uint256[] memory pks = new uint256[](3);
        pks[0] = PK_A; pks[1] = PK_B; pks[2] = PK_C;
        bytes[] memory sigs = _coSign(3, s, pks);

        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        uint256 beforeC = token.balanceOf(c);
        address stranger = address(0xDEAD);
        vm.prank(stranger); // permissionless settle: yet another non-player submits it
        zk.settle(id, s, sigs);

        assertEq(token.balanceOf(a) - beforeA, 1.5 ether, "seat 0 paid, not the relayer or the settle submitter");
        assertEq(token.balanceOf(b) - beforeB, 1 ether, "seat 1 paid");
        assertEq(token.balanceOf(c) - beforeC, 0.5 ether, "seat 2 paid");
        assertEq(token.balanceOf(relayer), 0, "relayer still holds nothing - pure pass-through");
        assertEq(token.balanceOf(stranger), 0, "settle submitter never touches the funds");
        assertEq(token.balanceOf(address(zk)), 0, "zero dust");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Nonce-tamper reverts — one per bound term (the seat-hijack closure)
    // ═══════════════════════════════════════════════════════════════════════
    // Every case asserts the SPECIFIC failure mode (MockX402.InvalidSignature), not just "some
    // revert" — proving the tamper dies at the wrapper's signature check, not an earlier guard.

    function test_nonceTamper_create_channelKey() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, /* tampered */ c, DECK_KEY_A, auth);
    }

    /// Tampers the WHOLE deck key point (G -> 2G, both genuinely on-curve) rather than a single
    /// coordinate: HoldemTableN validates every deckKey is on-curve BEFORE the nonce/signature
    /// check (Option B hardening), so corrupting just one coordinate of an on-curve point would
    /// almost always land off-curve and revert with BadDeckKey before ever reaching the check
    /// this test targets.
    function test_nonceTamper_create_deckKey() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), /* tampered */ DECK_KEY_B, auth);
    }

    function test_nonceTamper_create_rules() public {
        IGameRulesN r = IGameRulesN(address(rules));
        MockGameRulesN otherRules = new MockGameRulesN();
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), IGameRulesN(address(otherRules)), 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
    }

    function test_nonceTamper_create_maxSeats() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, /* tampered */ 4, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
    }

    function test_nonceTamper_create_rakeBps() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, /* tampered */ 100, 0, CLOCK, address(0), DECK_KEY_A, auth);
    }

    function test_nonceTamper_create_rakeCap() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 100, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 100, /* tampered */ 1 ether, CLOCK, address(0), DECK_KEY_A, auth);
    }

    function test_nonceTamper_create_clockBlocks() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, /* tampered */ CLOCK + 1, address(0), DECK_KEY_A, auth);
    }

    /// `token` is bound inside createNonce (so redirecting escrow to a different wrapper fails
    /// the nonce check) AND is itself the receiver whose EIP-712 domain the signature was made
    /// against (so redirecting to a different wrapper ALSO fails the domain check).
    function test_nonceTamper_create_token() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        MockX402 otherToken = new MockX402();
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(otherToken)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
    }

    function test_nonceTamper_create_salt() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        auth.salt = bytes32(uint256(1)); // tampered after signing (sig unchanged)
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
    }

    /// buyIn is bound BOTH inside the nonce hash AND as the wrapper's own `value` field.
    function test_nonceTamper_create_buyIn() public {
        IGameRulesN r = IGameRulesN(address(rules));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, /* tampered */ 2 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
    }

    /// A join-auth signed for one table cannot be redirected at a different table: joinNonce
    /// binds the exact tableId.
    function test_nonceTamper_join_wrongTable() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 id1 = _create(PK_A, a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A);
        bytes32 id2 = _create(PK_D, d, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A); // a 2nd table, different creator
        HoldemTableN.DepositAuth memory auth = _joinAuth(b, id1, 1 ether, address(0), DECK_KEY_A, PK_B);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id2, address(0), DECK_KEY_A, auth); // signed for id1, submitted against id2
    }

    function test_nonceTamper_join_channelKey() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 id = _create(PK_A, a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A);
        HoldemTableN.DepositAuth memory auth = _joinAuth(b, id, 1 ether, address(0), DECK_KEY_A, PK_B);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id, /* tampered */ c, DECK_KEY_A, auth);
    }

    /// Tampers the WHOLE deck key point (G -> 2G) for the same reason as
    /// test_nonceTamper_create_deckKey — join() also validates on-curve BEFORE the nonce check.
    function test_nonceTamper_join_deckKey() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 id = _create(PK_A, a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A);
        HoldemTableN.DepositAuth memory auth = _joinAuth(b, id, 1 ether, address(0), DECK_KEY_A, PK_B);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id, address(0), /* tampered */ DECK_KEY_B, auth);
    }

    /// Feeding a CREATE-domain auth into join() fails even against the RIGHT table: the domain
    /// tags ("HoldemTableN.X402.Create" vs "HoldemTableN.X402.Join") make the two nonce spaces
    /// disjoint.
    function test_nonceTamper_functionTag_createAuthIntoJoin() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 id = _create(PK_A, a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A);
        bytes32 wrongDomainNonce = zk.createNonce(b, IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(PK_B, b, 1 ether, wrongDomainNonce);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id, address(0), DECK_KEY_A, auth);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CEI reorder verification — a bad auth persists NO table/seat
    // ═══════════════════════════════════════════════════════════════════════

    function test_ceiReorder_badAuthCreate_persistsNoTable() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 predictedId = keccak256(abi.encode(block.chainid, address(zk), uint256(1)));

        bytes32 nonce = zk.createNonce(a, IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, bytes32(0));
        // Signed with the WRONG key for auth.from=a (PK_B instead of PK_A).
        HoldemTableN.DepositAuth memory badAuth = _authFor(PK_B, a, 1 ether, nonce);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, badAuth);

        assertEq(uint8(zk.status(predictedId)), uint8(ChannelTableBase.Status.None), "no table persisted at all");

        // The counter never advanced: a REAL create() right after lands on the exact same id.
        bytes32 realId = _create(PK_A, a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A);
        assertEq(realId, predictedId, "the failed attempt did not consume a counter slot");
    }

    function test_ceiReorder_badAuthJoin_persistsNoSeat() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 id = _create(PK_A, a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A);
        bytes32 nonce = zk.joinNonce(id, b, address(0), DECK_KEY_A, bytes32(0));
        // Signed with the WRONG key for auth.from=b (PK_C instead of PK_B).
        HoldemTableN.DepositAuth memory badAuth = _authFor(PK_C, b, 1 ether, nonce);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id, address(0), DECK_KEY_A, badAuth);

        assertEq(zk.seatCount(id), 1, "no second seat persisted");
        assertEq(token.balanceOf(address(zk)), 1 ether, "escrow unchanged: only A's buy-in, B's pull never landed");

        // The real join (correctly signed) still works afterward.
        _join(PK_B, b, id, 1 ether, address(0), DECK_KEY_A);
        assertEq(zk.seatAt(id, 1), b, "the real join succeeds cleanly after the failed attempt");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Replay / nonce-burn semantics
    // ═══════════════════════════════════════════════════════════════════════

    function test_replay_executedCreateAuth_reverts() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 nonce = zk.createNonce(a, IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _createAuth(a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, PK_A);
        vm.prank(relayer);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MockX402.AuthorizationAlreadyUsed.selector, a, nonce));
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
    }

    /// A join() call that reverts BEFORE `_pull` (table full — TooManySeats) never touches the
    /// wrapper's nonce state — the auth is untouched/still "usable" (not burned).
    function test_replay_revertedJoin_leavesNonceUnburned() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 id = _create(PK_A, a, 1 ether, r, 2, 0, 0, CLOCK, address(0), DECK_KEY_A); // maxSeats=2
        _join(PK_B, b, id, 1 ether, address(0), DECK_KEY_A); // table now full (2/2)

        bytes32 nonce = zk.joinNonce(id, c, address(0), DECK_KEY_A, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(PK_C, c, 1 ether, nonce);

        assertFalse(token.authorizationState(c, nonce), "unused before the attempt");
        vm.prank(relayer);
        vm.expectRevert(HoldemTableN.TooManySeats.selector); // reverts before _pull
        zk.join(id, address(0), DECK_KEY_A, auth);
        assertFalse(token.authorizationState(c, nonce), "still unused: the failed attempt never reached the wrapper");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Rejoin-after-leave liveness (F2) — joinNonce's salt
    // ═══════════════════════════════════════════════════════════════════════

    /// F2: `leaveBeforeStart` frees a (tableId, from) slot, but WITHOUT a salt in `joinNonce`
    /// the freed seat could never rejoin the SAME table with the SAME channelKey/deckKey — the
    /// wrapper's nonce for that exact tuple would already be permanently burned. A fresh salt
    /// lets the same signer mint a new, distinguishable join authorization and rejoin cleanly;
    /// resubmitting the EXACT SAME (already-used) salted authorization still correctly dies at
    /// the wrapper's burned-nonce check (bearer replay of an already-executed auth is unaffected
    /// by this fix).
    function test_rejoinAfterLeave_freshSaltSucceeds_sameSaltReplayDies() public {
        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 id = _create(PK_A, a, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A);
        bytes32 firstSalt = bytes32(uint256(1));
        _joinSalted(PK_B, b, id, 1 ether, address(0), DECK_KEY_A, firstSalt);
        assertEq(zk.seatAt(id, 1), b, "b seated");

        // b leaves the Forming table: its (tableId, from) slot is freed, and the FIRST salted
        // join authorization is already burned at the wrapper.
        vm.prank(b);
        zk.leaveBeforeStart(id);
        assertEq(zk.seatCount(id), 1, "b's seat freed");

        // Replaying the EXACT SAME salted authorization dies at the wrapper's burned nonce —
        // this fix does not create a bearer-replay hole.
        bytes32 firstNonce = zk.joinNonce(id, b, address(0), DECK_KEY_A, firstSalt);
        HoldemTableN.DepositAuth memory staleAuth = _joinAuthSalted(b, id, 1 ether, address(0), DECK_KEY_A, PK_B, firstSalt);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MockX402.AuthorizationAlreadyUsed.selector, b, firstNonce));
        zk.join(id, address(0), DECK_KEY_A, staleAuth);

        // A FRESH salt lets b rejoin the SAME table with the SAME channelKey/deckKey.
        bytes32 secondSalt = bytes32(uint256(2));
        _joinSalted(PK_B, b, id, 1 ether, address(0), DECK_KEY_A, secondSalt);
        assertEq(zk.seatAt(id, 1), b, "b rejoined with a fresh salt");
        assertEq(zk.seatCount(id), 2, "table back to 2 seats");
        assertEq(token.balanceOf(address(zk)), 2 ether, "exactly two buy-ins escrowed (no double-charge)");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EIP-7598 ERC-1271 path
    // ═══════════════════════════════════════════════════════════════════════

    function test_x7598_mock1271Wallet_nonEoaSigner() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        token.mint(address(wallet), 10 ether);

        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 nonce = zk.createNonce(address(wallet), IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, bytes32(0));
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), address(wallet), address(zk), 1 ether, VALID_BEFORE, nonce);
        wallet.approveDigest(digest);

        bytes memory sig = hex"1234"; // any non-65-byte payload routes the 7598 `bytes` overload
        HoldemTableN.DepositAuth memory auth = HoldemTableN.DepositAuth({from: address(wallet), validBefore: VALID_BEFORE, salt: bytes32(0), sig: sig});

        vm.prank(relayer);
        bytes32 tableId = zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
        assertEq(zk.seatAt(tableId, 0), address(wallet), "the 1271 wallet is the seated player");
        assertEq(token.balanceOf(address(zk)), 1 ether, "escrow pulled via the 7598 path");
    }

    function test_x7598_mock1271Wallet_tamperReverts() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        token.mint(address(wallet), 10 ether);

        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 nonce = zk.createNonce(address(wallet), IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, bytes32(0));
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), address(wallet), address(zk), 1 ether, VALID_BEFORE, nonce);
        wallet.approveDigest(digest);

        HoldemTableN.DepositAuth memory auth =
            HoldemTableN.DepositAuth({from: address(wallet), validBefore: VALID_BEFORE, salt: bytes32(0), sig: hex"1234"});
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), r, 1 ether, 3, 0, 0, CLOCK, /* tampered */ c, DECK_KEY_A, auth);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Permissionless settle / respondWithState — and everything else stays gated
    // ═══════════════════════════════════════════════════════════════════════

    function test_permissionless_settle_strangerPaysOutRealSeats() public {
        bytes32 id = _createJoin3(1 ether, 0, 0);
        vm.prank(a);
        zk.start(id);

        ChannelStateN memory s = _emptyState(id, 3);
        s.nonce = 1;
        s.balances[0] = 1 ether; s.balances[1] = 1 ether; s.balances[2] = 1 ether;
        s.phase = 11;
        uint256[] memory pks = new uint256[](3);
        pks[0] = PK_A; pks[1] = PK_B; pks[2] = PK_C;
        bytes[] memory sigs = _coSign(3, s, pks);

        address stranger = address(0xDEAD);
        uint256 beforeA = token.balanceOf(a);
        vm.prank(stranger);
        zk.settle(id, s, sigs);
        assertEq(token.balanceOf(a) - beforeA, 1 ether);
        assertEq(token.balanceOf(stranger), 0, "stranger never touches the funds");
    }

    function test_permissionless_respondWithState_strangerCanSubmit() public {
        bytes32 id = _createJoin3(1 ether, 0, 0);
        vm.prank(a);
        zk.start(id);

        ChannelStateN memory dispute = _emptyState(id, 3);
        dispute.nonce = 1;
        dispute.balances[0] = 3 ether;
        dispute.phase = 4;
        dispute.gameStateHash = keccak256("g");
        uint256[] memory pks = new uint256[](3);
        pks[0] = PK_A; pks[1] = PK_B; pks[2] = PK_C;
        bytes[] memory disputeSigs = _coSign(3, dispute, pks);
        vm.prank(a);
        zk.openDispute(id, dispute, disputeSigs, "g", 0, 1, 0);

        ChannelStateN memory resp = _emptyState(id, 3);
        resp.nonce = 2;
        resp.balances[0] = 1 ether; resp.balances[1] = 1 ether; resp.balances[2] = 1 ether;
        resp.phase = 4;
        bytes[] memory respSigs = _coSign(3, resp, pks);

        address stranger = address(0xDEAD);
        vm.prank(stranger); // permissionless: stranger submits a newer co-signed state
        zk.respondWithState(id, resp, respSigs);
        assertEq(uint8(zk.status(id)), uint8(ChannelTableBase.Status.Live), "dispute cleared even though a stranger submitted it");
    }

    /// A stranger CANNOT open a dispute, start the table, register a deck key, leave, or cancel —
    /// only settle/respondWithState were opened up; the direct-action paths stay seat-gated.
    function test_permissionless_doesNotExtendToOtherFunctions() public {
        address stranger = address(0xDEAD);
        IGameRulesN r = IGameRulesN(address(rules));

        bytes32 forming = _create(PK_D, d, 1 ether, r, 3, 0, 0, CLOCK, address(0), DECK_KEY_A);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancel(forming);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.leaveBeforeStart(forming);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.registerDeckKey(forming, DECK_KEY_A);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.start(forming);

        bytes32 live = _createJoin3(1 ether, 0, 0);
        vm.prank(a);
        zk.start(live);
        ChannelStateN memory s = _emptyState(live, 3);
        s.nonce = 1;
        s.balances[0] = 3 ether;
        s.phase = 4;
        s.gameStateHash = keccak256("g");
        uint256[] memory pks = new uint256[](3);
        pks[0] = PK_A; pks[1] = PK_B; pks[2] = PK_C;
        bytes[] memory sigs = _coSign(3, s, pks);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.openDispute(live, s, sigs, "g", 0, 1, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Factory clone-check
    // ═══════════════════════════════════════════════════════════════════════

    function test_factoryCloneCheck_revertsBadToken_wrongWrapper() public {
        HoldemMockWrapperFactory factory = new HoldemMockWrapperFactory();
        HoldemTableN zkChecked = new HoldemTableN(address(0x7), address(factory));
        MockX402 fakeToken = new MockX402();
        address underlying = address(0x1234);
        fakeToken.setUnderlying(underlying);
        factory.register(underlying, address(0x9999)); // canonical wrapper is some OTHER address
        fakeToken.mint(a, 10 ether);

        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 nonce = zkChecked.createNonce(a, IX402Token(address(fakeToken)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, bytes32(0));
        bytes32 digest = X402AuthLib.receiveDigest(fakeToken.DOMAIN_SEPARATOR(), a, address(zkChecked), 1 ether, VALID_BEFORE, nonce);
        HoldemTableN.DepositAuth memory auth =
            HoldemTableN.DepositAuth({from: a, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(PK_A, digest)});

        vm.prank(relayer);
        vm.expectRevert(HoldemTableN.BadToken.selector);
        zkChecked.create(IX402Token(address(fakeToken)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
    }

    function test_factoryCloneCheck_succeedsForGenuineWrapper() public {
        HoldemMockWrapperFactory factory = new HoldemMockWrapperFactory();
        HoldemTableN zkChecked = new HoldemTableN(address(0x7), address(factory));
        MockX402 realToken = new MockX402();
        address underlying = address(0x1234);
        realToken.setUnderlying(underlying);
        factory.register(underlying, address(realToken)); // the factory's canonical wrapper IS realToken
        realToken.mint(a, 10 ether);

        IGameRulesN r = IGameRulesN(address(rules));
        bytes32 nonce = zkChecked.createNonce(a, IX402Token(address(realToken)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, bytes32(0));
        bytes32 digest = X402AuthLib.receiveDigest(realToken.DOMAIN_SEPARATOR(), a, address(zkChecked), 1 ether, VALID_BEFORE, nonce);
        HoldemTableN.DepositAuth memory auth =
            HoldemTableN.DepositAuth({from: a, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(PK_A, digest)});

        vm.prank(relayer);
        bytes32 tableId = zkChecked.create(IX402Token(address(realToken)), r, 1 ether, 3, 0, 0, CLOCK, address(0), DECK_KEY_A, auth);
        assertEq(zkChecked.seatAt(tableId, 0), a, "genuine wrapper clone passes the check");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Multi-seat full cycle with rake — treasury paid in the wrapper token, zero dust
    // ═══════════════════════════════════════════════════════════════════════

    function test_multiSeatFullCycle_rakeToTreasuryInWrapperToken_zeroDust() public {
        address treasury = address(0x7);
        uint256 buyIn = 10 ether;
        uint256 total = 3 * buyIn;
        uint16 rakeBps = 250; // 2.5% (MAX_RAKE_BPS)
        uint256 rakeCap = 100 ether; // loose — the bps ratio binds
        bytes32 id = _createJoin3(buyIn, rakeBps, rakeCap);
        vm.prank(a);
        zk.start(id);

        // rake = 2.5% of gross(30 ether) = 0.75 ether; remaining 29.25 ether split unevenly.
        uint256 rake = 0.75 ether;
        uint256 remaining = total - rake;
        ChannelStateN memory s = _emptyState(id, 3);
        s.nonce = 1;
        s.balances[0] = remaining / 2;
        s.balances[1] = remaining / 3;
        s.balances[2] = remaining - s.balances[0] - s.balances[1];
        s.rakeAccrued = rake;
        s.phase = 11;
        uint256[] memory pks = new uint256[](3);
        pks[0] = PK_A; pks[1] = PK_B; pks[2] = PK_C;
        bytes[] memory sigs = _coSign(3, s, pks);

        uint256 treasuryBefore = token.balanceOf(treasury);
        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        uint256 beforeC = token.balanceOf(c);

        address stranger = address(0xDEAD);
        vm.prank(stranger); // permissionless settle
        zk.settle(id, s, sigs);

        assertEq(token.balanceOf(a) - beforeA, s.balances[0], "seat 0 paid");
        assertEq(token.balanceOf(b) - beforeB, s.balances[1], "seat 1 paid");
        assertEq(token.balanceOf(c) - beforeC, s.balances[2], "seat 2 paid");
        assertEq(token.balanceOf(treasury) - treasuryBefore, rake, "treasury got the rake IN THE WRAPPER TOKEN");
        assertEq(token.balanceOf(address(zk)), 0, "zero dust left on the wrapper");
        assertEq(uint8(zk.status(id)), uint8(ChannelTableBase.Status.Settled), "settled");
    }
}

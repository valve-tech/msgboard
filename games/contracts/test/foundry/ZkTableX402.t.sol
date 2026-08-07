// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ChannelTableBase} from "../../contracts/zk/ChannelTableBase.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {IGameRules} from "../../contracts/zk/IGameRules.sol";
import {MockGameRules} from "../../contracts/test/MockGameRules.sol";
import {MockX402, Mock1271Wallet} from "../../contracts/test/MockX402.sol";
import {IX402Token} from "../../contracts/games/FlipBookX.sol";
import {X402AuthLib} from "./X402AuthLib.sol";

/// A minimal ValveWrapperFactory stand-in for the `create()` clone-check: `wrapperOf(underlying)`
/// returns whatever address was registered for that underlying (or address(0) if none), exactly
/// mirroring the real factory's CREATE2-predicted-address semantics for test purposes.
contract MockWrapperFactory {
    mapping(address => address) public wrapperOf_;

    function register(address underlying, address wrapper) external {
        wrapperOf_[underlying] = wrapper;
    }

    function wrapperOf(address underlying) external view returns (address) {
        return wrapperOf_[underlying];
    }
}

/// @notice The x402 asset-plumbing conversion's own dedicated coverage: relayer-vs-player
/// identity separation, the nonce-tamper seat-hijack closure (one test per bound term, per
/// function), replay/nonce-burn semantics, the EIP-7598 ERC-1271 path, settle/respondWithState
/// permissionlessness (and that the OTHER seat-gated functions did NOT become permissionless),
/// and the factory clone-check. Companion to the migrated ZkTableUnit/ZkTable/ZkTableInvariant/
/// ZkTableShowdownUnit/ZkTableShowdownDispute suites, which re-exercise ZkTable's PRE-EXISTING
/// business logic (now funded via x402) — this file is only the NEW attack surface.
contract ZkTableX402Test is Test {
    ZkTable internal zk;
    MockGameRules internal rules;
    MockX402 internal token;

    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    uint256 internal constant PK_C = 0xC0FFEE;
    address internal a;
    address internal b;
    address internal c;
    address internal relayer = address(0xBEEF);

    uint64 internal constant CLOCK = 30;
    uint256[2] internal ZERO_DECK = [uint256(0), uint256(0)];
    uint64 internal constant VALID_BEFORE = type(uint64).max;

    function setUp() public {
        zk = new ZkTable(address(0)); // factory=0: the clone-check has its own dedicated tests below
        rules = new MockGameRules();
        token = new MockX402();
        a = vm.addr(PK_A);
        b = vm.addr(PK_B);
        c = vm.addr(PK_C);
        token.mint(a, 1_000_000 ether);
        token.mint(b, 1_000_000 ether);
        token.mint(c, 1_000_000 ether);
    }

    // ── shared helpers ───────────────────────────────────────────────────────

    function _authFor(uint256 pk, address from, uint256 value, bytes32 nonce) internal returns (ZkTable.DepositAuth memory) {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, VALID_BEFORE, nonce);
        return ZkTable.DepositAuth({from: from, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    function _createAuth(address from, uint256 buyIn, IGameRules rules_, uint256 stake, uint64 clock, address channelKey, uint256[2] memory deckKey, uint256 pk)
        internal
        returns (ZkTable.DepositAuth memory)
    {
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), rules_, buyIn, stake, clock, channelKey, deckKey, bytes32(0));
        return _authFor(pk, from, buyIn, nonce);
    }

    function _joinAuth(address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey, uint256 pk)
        internal
        returns (ZkTable.DepositAuth memory)
    {
        bytes32 nonce = zk.joinNonce(tableId, from, channelKey, deckKey);
        return _authFor(pk, from, stake, nonce);
    }

    function _create(uint256 pk, address from, uint256 buyIn, IGameRules rules_, uint256 stake, uint64 clock, address channelKey, uint256[2] memory deckKey)
        internal
        returns (bytes32 tableId)
    {
        ZkTable.DepositAuth memory auth = _createAuth(from, buyIn, rules_, stake, clock, channelKey, deckKey, pk);
        vm.prank(relayer); // every happy-path helper submits via a RELAYER, never the player itself
        tableId = zk.create(IX402Token(address(token)), buyIn, rules_, stake, clock, channelKey, deckKey, auth);
    }

    function _join(uint256 pk, address from, bytes32 tableId, uint256 stake, address channelKey, uint256[2] memory deckKey) internal {
        ZkTable.DepositAuth memory auth = _joinAuth(from, tableId, stake, channelKey, deckKey, pk);
        vm.prank(relayer);
        zk.join(tableId, channelKey, deckKey, auth);
    }

    function _createJoin(uint256 escrowA, uint256 stake) internal returns (bytes32 tableId) {
        tableId = _create(PK_A, a, escrowA, IGameRules(address(rules)), stake, CLOCK, address(0), ZERO_DECK);
        _join(PK_B, b, tableId, stake, address(0), ZERO_DECK);
    }

    function _keys(bytes32 id) internal view returns (address kA, address kB) {
        (, , kA, kB, , , , , , , , , , , , , , , ) = zk.tables(id);
    }

    function _players(bytes32 id) internal view returns (address pA, address pB) {
        (pA, pB, , , , , , , , , , , , , , , , , ) = zk.tables(id);
    }

    function _status(bytes32 id) internal view returns (ChannelTableBase.Status status) {
        (, , , , , , , , , status, , , , , , , , , ) = zk.tables(id);
    }

    function _escrows(bytes32 id) internal view returns (uint256 escA, uint256 escB) {
        (, , , , escA, escB, , , , , , , , , , , , , ) = zk.tables(id);
    }

    function _emptyState(bytes32 tableId) internal pure returns (ChannelState memory s) {
        s.tableId = tableId;
        s.nonce = 0;
        s.deckCommitment = bytes32(0);
        s.phase = 0;
        s.gameStateHash = bytes32(0);
    }

    function _coSign(ChannelState memory s) internal view returns (bytes memory sigA, bytes memory sigB) {
        bytes32 digest = zk.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(PK_A, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK_B, digest);
        sigA = abi.encodePacked(r1, s1, v1);
        sigB = abi.encodePacked(r2, s2, v2);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Relayer-submits-not-player
    // ═══════════════════════════════════════════════════════════════════════

    /// The tx sender (relayer) is never a player identity: create+join land on auth.from, and
    /// the eventual payout goes to the real players, never the relayer.
    function test_relayer_createJoinSettle_landsOnAuthFrom_notMsgSender() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        (address pA, address pB) = _players(id);
        assertEq(pA, a, "playerA is the signer, not the relayer");
        assertEq(pB, b, "playerB is the signer, not the relayer");
        assertEq(token.balanceOf(relayer), 0, "the relayer never held any of the escrowed tokens");

        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 1.2 ether;
        s.balanceB = 0.8 ether;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        vm.prank(relayer);
        zk.settle(id, s, sigA, sigB);
        assertEq(token.balanceOf(a) - beforeA, 1.2 ether, "player A paid, not the relayer");
        assertEq(token.balanceOf(b) - beforeB, 0.8 ether, "player B paid, not the relayer");
        assertEq(token.balanceOf(relayer), 0, "relayer still holds nothing - pure pass-through");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Nonce-tamper reverts — one per bound term (the seat-hijack closure)
    // ═══════════════════════════════════════════════════════════════════════
    // Every case below asserts the SPECIFIC failure mode (MockX402.InvalidSignature), not just
    // "some revert" — proving the tamper dies at the wrapper's signature check, not at an
    // earlier, unrelated guard that would mask a real gap in the nonce binding.

    /// A relayer that alters `channelKey` between signing and submission recomputes a different
    /// createNonce; the wrapper's EIP-712 recovery then fails against the player's original sig.
    function test_nonceTamper_create_channelKey() public {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, /* tampered */ c, ZERO_DECK, auth);
    }

    function test_nonceTamper_create_deckKey0() public {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        uint256[2] memory tamperedDeck = [uint256(999), uint256(0)];
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, address(0), tamperedDeck, auth);
    }

    function test_nonceTamper_create_deckKey1() public {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        uint256[2] memory tamperedDeck = [uint256(0), uint256(999)];
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, address(0), tamperedDeck, auth);
    }

    function test_nonceTamper_create_rules() public {
        IGameRules r = IGameRules(address(rules));
        MockGameRules otherRules = new MockGameRules();
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), 1 ether, IGameRules(address(otherRules)), 1 ether, CLOCK, address(0), ZERO_DECK, auth);
    }

    function test_nonceTamper_create_joinStake() public {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), 1 ether, r, /* tampered */ 2 ether, CLOCK, address(0), ZERO_DECK, auth);
    }

    function test_nonceTamper_create_clockBlocks() public {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, /* tampered */ CLOCK + 1, address(0), ZERO_DECK, auth);
    }

    /// `token` is bound inside createNonce (so redirecting escrow to a different wrapper fails
    /// the nonce check) AND is itself the receiver whose EIP-712 domain the signature was made
    /// against (so redirecting to a different wrapper ALSO fails the domain check) — belt and
    /// suspenders, both closed by the same tamper.
    function test_nonceTamper_create_token() public {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        MockX402 otherToken = new MockX402();
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(otherToken)), 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);
    }

    /// `auth.salt` is read directly off the submitted struct (not re-derived) — a relayer can
    /// resubmit the SAME `sig` bytes wrapped in a struct with a different `salt`, which recomputes
    /// a different nonce than what was actually signed.
    function test_nonceTamper_create_salt() public {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        auth.salt = bytes32(uint256(1)); // tampered after signing (sig unchanged)
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);
    }

    /// buyIn is bound BOTH inside the nonce hash AND as the wrapper's own `value` field — either
    /// way, tampering it desyncs the signed digest from what's actually submitted.
    function test_nonceTamper_create_buyIn() public {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), /* tampered */ 2 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);
    }

    /// A join-auth signed for one table cannot be redirected at a different table: joinNonce
    /// binds the exact tableId.
    function test_nonceTamper_join_wrongTable() public {
        bytes32 id1 = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes32 id2 = _create(PK_C, c, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK); // a 2nd table, different creator
        ZkTable.DepositAuth memory auth = _joinAuth(b, id1, 1 ether, address(0), ZERO_DECK, PK_B);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id2, address(0), ZERO_DECK, auth); // signed for id1, submitted against id2
    }

    function test_nonceTamper_join_channelKey() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        ZkTable.DepositAuth memory auth = _joinAuth(b, id, 1 ether, address(0), ZERO_DECK, PK_B);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id, /* tampered */ c, ZERO_DECK, auth);
    }

    function test_nonceTamper_join_deckKey() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        ZkTable.DepositAuth memory auth = _joinAuth(b, id, 1 ether, address(0), ZERO_DECK, PK_B);
        uint256[2] memory tamperedDeck = [uint256(777), uint256(0)];
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id, address(0), tamperedDeck, auth);
    }

    /// Feeding a CREATE-domain auth into join() fails even against the RIGHT table: the domain
    /// tags ("ZkTable.X402.Create" vs "ZkTable.X402.Join") make the two nonce spaces disjoint.
    function test_nonceTamper_functionTag_createAuthIntoJoin() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        // Build what LOOKS like a join auth but is actually signed over the CREATE nonce formula.
        bytes32 wrongDomainNonce = zk.createNonce(b, IX402Token(address(token)), IGameRules(address(rules)), 1 ether, 1 ether, CLOCK, address(0), ZERO_DECK, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(PK_B, b, 1 ether, wrongDomainNonce);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id, address(0), ZERO_DECK, auth);
    }

    /// A topUp-auth signed for one table cannot be redirected at a different table: topUpNonce
    /// binds the exact tableId. `a` legitimately seats at BOTH tables (as playerA of id1, and as
    /// playerB of id2) so `_seatOf` never gates this — only the nonce mismatch does.
    function test_nonceTamper_topUp_wrongTable() public {
        bytes32 id1 = _createJoin(1 ether, 1 ether); // players a/b
        bytes32 id2 = _create(PK_C, c, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        _join(PK_A, a, id2, 1 ether, address(0), ZERO_DECK); // a seats at id2 too — a different table, no nonce collision

        bytes32 nonce = zk.topUpNonce(id1, a, 0.1 ether, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(PK_A, a, 0.1 ether, nonce);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.topUp(id2, 0.1 ether, auth); // signed for id1's topUp, submitted against id2
    }

    function test_nonceTamper_topUp_amount() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes32 nonce = zk.topUpNonce(id, a, 0.1 ether, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(PK_A, a, 0.1 ether, nonce);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.topUp(id, /* tampered */ 0.2 ether, auth); // signed for 0.1 ether, submitted for 0.2 ether
    }

    function test_nonceTamper_topUp_salt() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        bytes32 nonce = zk.topUpNonce(id, a, 0.1 ether, bytes32(0));
        ZkTable.DepositAuth memory auth = _authFor(PK_A, a, 0.1 ether, nonce);
        auth.salt = bytes32(uint256(1)); // tampered after signing (sig unchanged) — topUp uses auth.salt directly
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.topUp(id, 0.1 ether, auth);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CEI reorder verification — a bad auth persists NO table/seat (checks-effects-interactions:
    // `_pull` is the LAST statement in create/join/topUp, but a revert inside it still unwinds
    // every effect written earlier in the SAME transaction — atomicity comes from the revert, not
    // from the ordering. These pin that property directly rather than just trusting it.)
    // ═══════════════════════════════════════════════════════════════════════

    /// A create() with a signature that doesn't recover to `auth.from` reverts, and — because the
    /// revert unwinds the whole transaction — leaves NOTHING behind: not the Table struct, and
    /// not even the `_counter` bump used to derive its id (proven by a real create() right after
    /// landing on the SAME predicted id, i.e. the failed attempt never consumed a counter slot).
    function test_ceiReorder_badAuthCreate_persistsNoTable() public {
        IGameRules r = IGameRules(address(rules));
        bytes32 predictedId = keccak256(abi.encode(block.chainid, address(zk), uint256(1)));

        bytes32 nonce = zk.createNonce(a, IX402Token(address(token)), r, 1 ether, 1 ether, CLOCK, address(0), ZERO_DECK, bytes32(0));
        // Signed with the WRONG key for auth.from=a (PK_B instead of PK_A) — a stand-in for "any
        // bad auth"; the recovery mismatch is exactly what a tampered term also produces.
        ZkTable.DepositAuth memory badAuth = _authFor(PK_B, a, 1 ether, nonce);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, badAuth);

        (address pA, ) = _players(predictedId);
        ChannelTableBase.Status status = _status(predictedId);
        assertEq(pA, address(0), "no playerA persisted at the predicted id");
        assertEq(uint8(status), uint8(ChannelTableBase.Status.None), "no table persisted at all - status still None");

        // The counter never advanced: a REAL create() right after lands on the exact same id.
        bytes32 realId = _create(PK_A, a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK);
        assertEq(realId, predictedId, "the failed attempt did not consume a counter slot");
    }

    /// A join() with a bad signature reverts, leaving the table exactly as Created — no playerB,
    /// no keyB, no escrowB, status never flips to Live — and a SUBSEQUENT correctly-signed join
    /// still succeeds cleanly (nothing left behind by the failed attempt to interfere with it).
    function test_ceiReorder_badAuthJoin_persistsNoSeat() public {
        bytes32 id = _create(PK_A, a, 1 ether, IGameRules(address(rules)), 1 ether, CLOCK, address(0), ZERO_DECK);
        bytes32 nonce = zk.joinNonce(id, b, address(0), ZERO_DECK);
        // Signed with the WRONG key for auth.from=b (PK_C instead of PK_B).
        ZkTable.DepositAuth memory badAuth = _authFor(PK_C, b, 1 ether, nonce);
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        zk.join(id, address(0), ZERO_DECK, badAuth);

        (, address pB) = _players(id);
        (, address kB) = _keys(id);
        (, uint256 escB) = _escrows(id);
        assertEq(pB, address(0), "no playerB persisted");
        assertEq(kB, address(0), "no keyB persisted");
        assertEq(escB, 0, "no escrowB persisted");
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Created), "table stays Created, never flips to Live");
        assertEq(token.balanceOf(address(zk)), 1 ether, "escrow unchanged: only A's original buy-in, B's pull never landed");

        // The real join (correctly signed) still works afterward.
        _join(PK_B, b, id, 1 ether, address(0), ZERO_DECK);
        (, pB) = _players(id);
        assertEq(pB, b, "the real join succeeds cleanly after the failed attempt");
        assertEq(uint8(_status(id)), uint8(ChannelTableBase.Status.Live));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Replay / nonce-burn semantics
    // ═══════════════════════════════════════════════════════════════════════

    /// Resubmitting an already-executed create authorization dies at the wrapper's burned nonce.
    function test_replay_executedCreateAuth_reverts() public {
        IGameRules r = IGameRules(address(rules));
        bytes32 nonce = zk.createNonce(a, IX402Token(address(token)), r, 1 ether, 1 ether, CLOCK, address(0), ZERO_DECK, bytes32(0));
        ZkTable.DepositAuth memory auth = _createAuth(a, 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, PK_A);
        vm.prank(relayer);
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);

        // MockX402.AuthorizationAlreadyUsed(address,bytes32) carries params, so `.selector` alone
        // (which `vm.expectRevert(bytes4)` matches as an EXACT 4-byte revert payload, not a
        // prefix) would never match this call's actual ABI-encoded revert data — reconstruct the
        // full expected error instead of the parameterless-selector shortcut used elsewhere here.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MockX402.AuthorizationAlreadyUsed.selector, a, nonce));
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);
    }

    /// A join() call that reverts BEFORE `_pull` (table already Live) never touches the wrapper's
    /// nonce state — the auth is untouched/still "usable" (not burned) even though this specific
    /// attempt failed.
    function test_replay_revertedJoin_leavesNonceUnburned() public {
        bytes32 id = _createJoin(1 ether, 1 ether); // already Live
        bytes32 nonce = zk.joinNonce(id, c, address(0), ZERO_DECK);
        ZkTable.DepositAuth memory auth = _authFor(PK_C, c, 1 ether, nonce);

        assertFalse(token.authorizationState(c, nonce), "unused before the attempt");
        vm.prank(relayer);
        vm.expectRevert(ChannelTableBase.BadStatus.selector); // status != Created — reverts before _pull
        zk.join(id, address(0), ZERO_DECK, auth);
        assertFalse(token.authorizationState(c, nonce), "still unused: the failed attempt never reached the wrapper");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EIP-7598 ERC-1271 path
    // ═══════════════════════════════════════════════════════════════════════

    /// A smart-contract wallet (Mock1271Wallet) as `auth.from`: any non-65-byte `sig` routes
    /// through the `bytes` receiveWithAuthorization overload, verified via ERC-1271.
    function test_x7598_mock1271Wallet_nonEoaSigner() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        token.mint(address(wallet), 10 ether);

        IGameRules r = IGameRules(address(rules));
        bytes32 nonce = zk.createNonce(address(wallet), IX402Token(address(token)), r, 1 ether, 1 ether, CLOCK, address(0), ZERO_DECK, bytes32(0));
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), address(wallet), address(zk), 1 ether, VALID_BEFORE, nonce);
        wallet.approveDigest(digest);

        // Any non-65-byte payload routes the 7598 `bytes` overload (content is irrelevant to the
        // mock's ERC-1271 check — it only compares the digest).
        bytes memory sig = hex"1234";
        ZkTable.DepositAuth memory auth = ZkTable.DepositAuth({from: address(wallet), validBefore: VALID_BEFORE, salt: bytes32(0), sig: sig});

        vm.prank(relayer);
        bytes32 tableId = zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);
        (address pA, ) = _players(tableId);
        assertEq(pA, address(wallet), "the 1271 wallet is the seated player");
        assertEq(token.balanceOf(address(zk)), 1 ether, "escrow pulled via the 7598 path");
    }

    /// The 7598 path is equally seat-hijack-closed: an approved digest for one nonce does not
    /// approve a different (tampered-term) nonce.
    function test_x7598_mock1271Wallet_tamperReverts() public {
        Mock1271Wallet wallet = new Mock1271Wallet();
        token.mint(address(wallet), 10 ether);

        IGameRules r = IGameRules(address(rules));
        bytes32 nonce = zk.createNonce(address(wallet), IX402Token(address(token)), r, 1 ether, 1 ether, CLOCK, address(0), ZERO_DECK, bytes32(0));
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), address(wallet), address(zk), 1 ether, VALID_BEFORE, nonce);
        wallet.approveDigest(digest);

        ZkTable.DepositAuth memory auth =
            ZkTable.DepositAuth({from: address(wallet), validBefore: VALID_BEFORE, salt: bytes32(0), sig: hex"1234"});
        vm.prank(relayer);
        vm.expectRevert(MockX402.InvalidSignature.selector);
        // channelKey tampered -> different nonce -> the approved digest no longer matches.
        zk.create(IX402Token(address(token)), 1 ether, r, 1 ether, CLOCK, /* tampered */ c, ZERO_DECK, auth);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Permissionless settle / respondWithState — and everything else stays gated
    // ═══════════════════════════════════════════════════════════════════════

    function test_permissionless_settle_strangerPaysOutRealPlayers() public {
        bytes32 id = _createJoin(1 ether, 1 ether);
        ChannelState memory s = _emptyState(id);
        s.nonce = 1;
        s.balanceA = 0.4 ether;
        s.balanceB = 1.6 ether;
        s.phase = 1;
        (bytes memory sigA, bytes memory sigB) = _coSign(s);

        address stranger = address(0xDEAD);
        uint256 beforeA = token.balanceOf(a);
        uint256 beforeB = token.balanceOf(b);
        vm.prank(stranger);
        zk.settle(id, s, sigA, sigB);
        assertEq(token.balanceOf(a) - beforeA, 0.4 ether);
        assertEq(token.balanceOf(b) - beforeB, 1.6 ether);
        assertEq(token.balanceOf(stranger), 0, "stranger never touches the funds");
    }

    /// A stranger CANNOT cancel, reclaim a top-up, or open a dispute — only settle/
    /// respondWithState were opened up; the direct-action paths stay seat-gated.
    function test_permissionless_doesNotExtendToCancelReclaimOrOpenDispute() public {
        address stranger = address(0xDEAD);

        // A distinct buyIn (2 ether, vs. _createJoin's 1/1 below) so the two create() calls from
        // the same signer never collide on an identical createNonce (same params => same nonce).
        bytes32 created = _createAuthAndCreate(a, PK_A, 2 ether);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.cancel(created);

        bytes32 live = _createJoin(1 ether, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.disputeSetup(live);

        vm.prank(a);
        zk.topUp(live, 0.1 ether, _authFor(PK_A, a, 0.1 ether, zk.topUpNonce(live, a, 0.1 ether, bytes32(0))));
        vm.roll(block.number + CLOCK + 1);
        vm.prank(stranger);
        vm.expectRevert(ChannelTableBase.NotPlayer.selector);
        zk.reclaimTopUp(live);
    }

    function _createAuthAndCreate(address from, uint256 pk, uint256 buyIn) internal returns (bytes32 tableId) {
        IGameRules r = IGameRules(address(rules));
        ZkTable.DepositAuth memory auth = _createAuth(from, buyIn, r, 1 ether, CLOCK, address(0), ZERO_DECK, pk);
        tableId = zk.create(IX402Token(address(token)), buyIn, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Factory clone-check
    // ═══════════════════════════════════════════════════════════════════════

    function test_factoryCloneCheck_revertsBadToken_wrongWrapper() public {
        MockWrapperFactory factory = new MockWrapperFactory();
        ZkTable zkChecked = new ZkTable(address(factory));
        MockX402 fakeToken = new MockX402();
        address underlying = address(0x1234);
        fakeToken.setUnderlying(underlying);
        // The factory's canonical wrapper for `underlying` is some OTHER address, not fakeToken.
        factory.register(underlying, address(0x9999));
        fakeToken.mint(a, 10 ether);

        IGameRules r = IGameRules(address(rules));
        bytes32 nonce = zkChecked.createNonce(a, IX402Token(address(fakeToken)), r, 1 ether, 1 ether, CLOCK, address(0), ZERO_DECK, bytes32(0));
        bytes32 digest = X402AuthLib.receiveDigest(fakeToken.DOMAIN_SEPARATOR(), a, address(zkChecked), 1 ether, VALID_BEFORE, nonce);
        ZkTable.DepositAuth memory auth =
            ZkTable.DepositAuth({from: a, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(PK_A, digest)});

        vm.prank(relayer);
        vm.expectRevert(ZkTable.BadToken.selector);
        zkChecked.create(IX402Token(address(fakeToken)), 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);
    }

    function test_factoryCloneCheck_succeedsForGenuineWrapper() public {
        MockWrapperFactory factory = new MockWrapperFactory();
        ZkTable zkChecked = new ZkTable(address(factory));
        MockX402 realToken = new MockX402();
        address underlying = address(0x1234);
        realToken.setUnderlying(underlying);
        // The factory's canonical wrapper for `underlying` IS realToken itself.
        factory.register(underlying, address(realToken));
        realToken.mint(a, 10 ether);

        IGameRules r = IGameRules(address(rules));
        bytes32 nonce = zkChecked.createNonce(a, IX402Token(address(realToken)), r, 1 ether, 1 ether, CLOCK, address(0), ZERO_DECK, bytes32(0));
        bytes32 digest = X402AuthLib.receiveDigest(realToken.DOMAIN_SEPARATOR(), a, address(zkChecked), 1 ether, VALID_BEFORE, nonce);
        ZkTable.DepositAuth memory auth =
            ZkTable.DepositAuth({from: a, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(PK_A, digest)});

        vm.prank(relayer);
        bytes32 tableId = zkChecked.create(IX402Token(address(realToken)), 1 ether, r, 1 ether, CLOCK, address(0), ZERO_DECK, auth);
        // NOTE: reads from `zkChecked` (this test's own instance), NOT the shared `_players`
        // helper (which is hardcoded to the outer `zk` from setUp — a different contract/storage).
        (address pA, , , , , , , , , , , , , , , , , , ) = zkChecked.tables(tableId);
        assertEq(pA, a, "genuine wrapper clone passes the check");
    }
}

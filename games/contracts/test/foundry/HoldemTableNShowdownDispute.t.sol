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
import {EllipticCurve} from "../../contracts/zk/lib/EllipticCurve.sol";
import {RevealShareDLEQ} from "../../contracts/zk/lib/RevealShareDLEQ.sol";
import {LibString} from "solady/src/utils/LibString.sol";
import {X402AuthLib} from "./X402AuthLib.sol";

/// @notice Smoke suite for the C1 (disputeSetup) + C2 (DEMAND_SHOWDOWN) fund-safety hardening
/// pass. Proves the machine COMPILES and its basic paths behave per the blueprint's adversarial
/// checklist: (1) a Live table with no co-signed state ever refunds via disputeSetup ->
/// resolveTimeout; (2) disputeSetup is closed off once a checkpoint exists (mid-game abuse
/// guard); (3) openShowdownDispute records the demand + fires its event; (4) resolveTimeout's
/// EXHAUSTIVE dispatch is really exhaustive — a SHOWDOWN dispute routes to `ShowdownDataRequired`
/// (never silently mis-resolved), and a corrupted/impossible demandKind routes to `BadDemand`
/// (H1 — no implicit fall-through bucket). Comprehensive C2 reveal/finalize/timeout coverage
/// (real secp256k1 shares) is a LATER ffi-backed wave — see HoldemShareDispute.t.sol for the
/// existing precedent this will follow.
contract HoldemTableNShowdownDisputeTest is Test {
    HoldemTableN internal zk;
    MockGameRulesN internal rules;
    MockX402 internal token;
    address internal treasury = address(0x7);

    uint64 internal constant CLOCK = 30; // MIN_CLOCK_BLOCKS
    uint8 internal constant DEMAND_MOVE = 1;
    uint8 internal constant DEMAND_SHOWDOWN = 3;
    uint64 internal constant VALID_BEFORE = type(uint64).max;

    uint256 internal constant GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 internal constant GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;

    function _pk(uint256 i) internal pure returns (uint256) { return 0xA11CE + i * 0x1000 + 1; }

    function setUp() public {
        zk = new HoldemTableN(treasury, address(0)); // factory=0 skips the clone-check
        rules = new MockGameRulesN();
        token = new MockX402();
        for (uint256 i = 0; i <= 9; i++) {
            token.mint(vm.addr(_pk(i)), 10_000_000 ether);
        }
    }

    // ── x402 deposit-auth helpers (mirrors HoldemTableNUnit.t.sol's idiom) ──────────────────────

    function _authFor(uint256 pk, address from, uint256 value, bytes32 nonce) internal returns (HoldemTableN.DepositAuth memory) {
        bytes32 digest = X402AuthLib.receiveDigest(token.DOMAIN_SEPARATOR(), from, address(zk), value, VALID_BEFORE, nonce);
        return HoldemTableN.DepositAuth({from: from, validBefore: VALID_BEFORE, salt: bytes32(0), sig: X402AuthLib.sign65(pk, digest)});
    }

    function _create(uint256 pk, address from, uint256 buyIn, uint256 maxSeats, uint64 clock) internal returns (bytes32 tableId) {
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), IGameRulesN(address(rules)), buyIn, maxSeats, 0, 0, clock, from, [GX, GY], bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(pk, from, buyIn, nonce);
        vm.prank(from);
        tableId = zk.create(IX402Token(address(token)), IGameRulesN(address(rules)), buyIn, maxSeats, 0, 0, clock, from, [GX, GY], auth);
    }

    function _join(uint256 pk, address from, bytes32 tableId, uint256 stake) internal {
        bytes32 nonce = zk.joinNonce(tableId, from, from, [GX, GY], bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(pk, from, stake, nonce);
        vm.prank(from);
        zk.join(tableId, from, [GX, GY], auth);
    }

    /// `n`-seat table, joined + started (Live), no co-signed state ever pinned.
    function _liveTable(uint256 n, uint256 buyIn) internal returns (bytes32 tableId) {
        address a0 = vm.addr(_pk(0));
        tableId = _create(_pk(0), a0, buyIn, n, CLOCK);
        for (uint256 i = 1; i < n; i++) {
            _join(_pk(i), vm.addr(_pk(i)), tableId, buyIn);
        }
        vm.prank(a0);
        zk.start(tableId);
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

    // ══════════════════════════════════════════════════════════════════════════════════
    // C1 — disputeSetup
    // ══════════════════════════════════════════════════════════════════════════════════

    /// The Live-with-no-co-signed-state freeze: opened by disputeSetup, resolved (after the
    /// clock) by a permissionless resolveTimeout that refunds every seat's escrow in full.
    function test_disputeSetup_resolveTimeout_refundsEscrow() public {
        uint256 n = 3;
        uint256 buyIn = 5 ether;
        bytes32 tableId = _liveTable(n, buyIn);

        vm.prank(vm.addr(_pk(1)));
        zk.disputeSetup(tableId);
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Disputed), "setup dispute opened");

        vm.roll(block.number + CLOCK + 1);

        uint256[] memory before = new uint256[](n);
        for (uint256 i = 0; i < n; i++) before[i] = token.balanceOf(vm.addr(_pk(i)));

        // Permissionless: a total stranger can trigger the refund.
        vm.prank(address(0xBEEF));
        zk.resolveTimeout(tableId);

        for (uint256 i = 0; i < n; i++) {
            assertEq(token.balanceOf(vm.addr(_pk(i))) - before[i], buyIn, "seat refunded its exact buy-in");
        }
        assertEq(token.balanceOf(address(zk)), 0, "no residue");
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Settled), "settled");
    }

    /// Mid-game-abuse guard: once a state has been co-signed and accepted (hasCheckpoint), a
    /// losing seat cannot open a bogus setup dispute to force a refund at initial buy-ins.
    function test_disputeSetup_revertsOnceHasCheckpoint() public {
        uint256 n = 2;
        uint256 buyIn = 4 ether;
        bytes32 tableId = _liveTable(n, buyIn);

        // Establish a checkpoint via the generic MOVE dispute -> respondWithState round-trip.
        // (Conservation: balances must sum to the escrowed total, buyIn per seat.)
        ChannelStateN memory s0 = _emptyState(tableId, n);
        s0.nonce = 1;
        s0.balances[0] = buyIn;
        s0.balances[1] = buyIn;
        s0.phase = 4;
        s0.gameStateHash = keccak256("g");
        bytes[] memory sigs0 = _coSign(n, s0);
        vm.prank(vm.addr(_pk(0)));
        zk.openDispute(tableId, s0, sigs0, "g", 0, DEMAND_MOVE, 0);

        ChannelStateN memory s1 = _emptyState(tableId, n);
        s1.nonce = 2;
        s1.balances[0] = buyIn;
        s1.balances[1] = buyIn;
        s1.phase = 4;
        s1.gameStateHash = keccak256("g2");
        bytes[] memory sigs1 = _coSign(n, s1);
        zk.respondWithState(tableId, s1, sigs1);
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "back to Live via newer state");

        vm.prank(vm.addr(_pk(0)));
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.disputeSetup(tableId);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // C2 — openShowdownDispute
    // ══════════════════════════════════════════════════════════════════════════════════

    /// A co-signed SHOWDOWN-phase state (self-authenticating N-of-N signatures) opens a
    /// DEMAND_SHOWDOWN dispute permissionlessly — proves the demand + cycle parameters are
    /// actually recorded (the emitted event) and that the machine correctly routes a NON-
    /// showdown-aware `resolveTimeout` to `ShowdownDataRequired` rather than silently
    /// mis-resolving it as a MOVE/SHARE force-fold (exhaustive dispatch, H1).
    function test_openShowdownDispute_recordsState() public {
        uint256 n = 2;
        uint256 buyIn = 3 ether;
        bytes32 tableId = _liveTable(n, buyIn);

        uint256 liveMask = (1 << n) - 1; // both seats live
        rules.setShowdownEligible(true, uint8(n), liveMask, false);

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = buyIn;
        s.balances[1] = buyIn;
        s.deckCommitment = keccak256("deck");
        s.phase = 10; // SHOWDOWN
        s.gameStateHash = keccak256("gs");
        bytes[] memory sigs = _coSign(n, s);

        // requiredCount = 2*popcount(liveMask) + 5 = 2*2 + 5 = 9; deadline = block + CLOCK.
        vm.expectEmit(true, false, false, true, address(zk));
        emit ShowdownDisputeOpened(tableId, 1, liveMask, 9, uint64(block.number) + CLOCK);

        vm.prank(address(0xBEEF)); // permissionless open — a stranger with the co-signed state
        zk.openShowdownDispute(tableId, s, sigs, "gs");

        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Disputed), "showdown dispute opened");

        vm.roll(block.number + CLOCK + 1);
        vm.expectRevert(HoldemTableN.ShowdownDataRequired.selector);
        zk.resolveTimeout(tableId);
    }

    /// Mirror of HoldemTableN's `ShowdownDisputeOpened(bytes32 indexed tableId, uint64 epoch,
    /// uint256 liveMask, uint32 requiredCount, uint64 deadline)` — declared locally, SAME name
    /// and parameter shape (a custom event's topic0 is purely `keccak256("EventName(types...)")`,
    /// independent of which contract declares it), so `vm.expectEmit` matches the real emission.
    event ShowdownDisputeOpened(bytes32 indexed tableId, uint64 epoch, uint256 liveMask, uint32 requiredCount, uint64 deadline);

    /// `openShowdownDispute` rejects a co-signed state the rules contract does not consider
    /// showdown-eligible (MockGameRulesN defaults to ineligible) — no dispute opens, table stays
    /// Live.
    function test_openShowdownDispute_revertsBadDemand_whenNotEligible() public {
        uint256 n = 2;
        uint256 buyIn = 2 ether;
        bytes32 tableId = _liveTable(n, buyIn);
        // rules.showdownEligible defaults to (false, 0, 0, false) — ineligible.

        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = buyIn;
        s.balances[1] = buyIn;
        s.deckCommitment = keccak256("deck");
        s.phase = 10;
        s.gameStateHash = keccak256("gs");
        bytes[] memory sigs = _coSign(n, s);

        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.openShowdownDispute(tableId, s, sigs, "gs");
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Live), "rejected dispute must not open");
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // resolveTimeout — exhaustive dispatch (H1)
    // ══════════════════════════════════════════════════════════════════════════════════

    /// A `demandKind` value outside the four real ones (0 / MOVE / SHARE / SHOWDOWN) can never
    /// arise through the public API — `_disputeSetup`/`_openDispute`/`openShowdownDispute` are
    /// the only writers, and each writes one of those four. This pins the exhaustive dispatch's
    /// final `else` by directly corrupting the packed storage slot (`Table.demandKind`, slot
    /// `keccak256(tableId, 2) + 9`, byte offset 9 — see `forge inspect HoldemTableN
    /// storage-layout`) to an impossible value, proving `resolveTimeout` reverts `BadDemand`
    /// rather than silently falling through to the MOVE/SHARE force-fold branch.
    function test_resolveTimeout_revertsBadDemand_onImpossibleDemandKind() public {
        uint256 n = 2;
        bytes32 tableId = _liveTable(n, 2 ether);

        vm.prank(vm.addr(_pk(0)));
        zk.disputeSetup(tableId); // status=Disputed, demandKind=0, a real deadline set

        bytes32 base = keccak256(abi.encode(tableId, uint256(2)));
        bytes32 slot = bytes32(uint256(base) + 9);
        bytes32 word = vm.load(address(zk), slot);
        uint256 w = uint256(word);
        w &= ~(uint256(0xFF) << (9 * 8)); // clear demandKind's byte
        w |= (uint256(99) << (9 * 8)); // an impossible demandKind
        vm.store(address(zk), slot, bytes32(w));

        vm.roll(block.number + CLOCK + 1);
        vm.expectRevert(ChannelTableBase.BadDemand.selector);
        zk.resolveTimeout(tableId);
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // F2 (2026-08 griefing fix) — postShowdownReveals: expiry gate + completion-gated
    // deadline extension. Pure-Solidity DLEQ construction (mirrors HoldemTableNRelay.t.sol's
    // `_makeShareProof` — no ffi needed): postShowdownReveals never decodes cards (that only
    // happens in finalizeShowdownN/resolveShowdownTimeout), so an arbitrary on-curve deck is
    // sufficient to exercise its reveal-bookkeeping in isolation from card semantics.
    // ══════════════════════════════════════════════════════════════════════════════════

    /// Mirrors HoldemTableNRelay.t.sol's identical helper — see that file's header for the
    /// construction rationale (pk=G*sk, c1=G*c1Scalar, honest {t1,t2,z}) — no off-chain
    /// prover / ffi needed.
    function _makeShareProof(uint256 sk, uint256 c1Scalar, uint256 w, string memory ctx)
        internal
        pure
        returns (uint256[2] memory pk, uint256[4] memory deckWord, uint256[2] memory share, uint256[5] memory proof)
    {
        (uint256 pkX, uint256 pkY) = EllipticCurve.ecMul(sk, EllipticCurve.GX, EllipticCurve.GY);
        (uint256 c1X, uint256 c1Y) = EllipticCurve.ecMul(c1Scalar, EllipticCurve.GX, EllipticCurve.GY);
        // c2 only feeds the Fiat-Shamir challenge (never used in the two verify equations) — any
        // on-curve point works; reuse G itself (mirrors HoldemTableNRelay.t.sol).
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
    /// HoldemTableNRelay.t.sol duplicates it).
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

    /// `create()`/`join()` with an EXPLICIT deck key (this file's own `_create`/`_join`
    /// hardcode `[GX, GY]`) — needed so seat 0 can register a REAL secp256k1 keypair with a
    /// known secret, letting these tests build genuine DLEQ proofs against it.
    function _createDK(uint256 pk, address from, uint256 buyIn, uint256 maxSeats, uint64 clock, uint256[2] memory deckKey)
        internal
        returns (bytes32 tableId)
    {
        bytes32 nonce = zk.createNonce(from, IX402Token(address(token)), IGameRulesN(address(rules)), buyIn, maxSeats, 0, 0, clock, from, deckKey, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(pk, from, buyIn, nonce);
        vm.prank(from);
        tableId = zk.create(IX402Token(address(token)), IGameRulesN(address(rules)), buyIn, maxSeats, 0, 0, clock, from, deckKey, auth);
    }

    function _joinDK(uint256 pk, address from, bytes32 tableId, uint256 stake, uint256[2] memory deckKey) internal {
        bytes32 nonce = zk.joinNonce(tableId, from, from, deckKey, bytes32(0));
        HoldemTableN.DepositAuth memory auth = _authFor(pk, from, stake, nonce);
        vm.prank(from);
        zk.join(tableId, from, deckKey, auth);
    }

    /// Reads `Table.disputeDeadline` directly out of storage: `uint64` at slot
    /// `keccak256(tableId, 2) + 9`, byte offset 0 (see `forge inspect HoldemTableN
    /// storage-layout`) — `demandKind`'s neighboring byte-9 read in
    /// `test_resolveTimeout_revertsBadDemand_onImpossibleDemandKind` above is this file's own
    /// precedent for reaching into this packed slot; HoldemTableN has no public getter for it.
    function _disputeDeadline(bytes32 tableId) internal view returns (uint64) {
        bytes32 base = keccak256(abi.encode(tableId, uint256(2)));
        bytes32 word = vm.load(address(zk), bytes32(uint256(base) + 9));
        return uint64(uint256(word));
    }

    /// Sets up a Live 2-seat table with an open DEMAND_SHOWDOWN dispute (liveMask = both seats,
    /// non-stub -> requiredCount = 9), seat 0 registered with a REAL secp256k1 deck key (secret
    /// `sk0`), and a fully-populated 9-slot arbitrary-but-on-curve `deck` whose commitment
    /// matches the co-signed state. Returns everything a caller needs to post shares for seat 0.
    function _openShowdownForF2(uint256 sk0, uint256 buyIn)
        internal
        returns (bytes32 tableId, uint256[] memory deck, uint256[] memory c1Scalars, uint64 openDeadline)
    {
        uint256 n = 2;
        (uint256 pk0X, uint256 pk0Y) = EllipticCurve.ecMul(sk0, EllipticCurve.GX, EllipticCurve.GY);
        address a0 = vm.addr(_pk(0));
        address a1 = vm.addr(_pk(1));
        tableId = _createDK(_pk(0), a0, buyIn, n, CLOCK, [pk0X, pk0Y]);
        _joinDK(_pk(1), a1, tableId, buyIn, [GX, GY]);
        vm.prank(a0);
        zk.start(tableId);

        rules.setShowdownEligible(true, uint8(n), 3, false); // liveMask=3 (both live), non-stub

        uint256 numSlots = 2 * n + 5; // 9
        deck = new uint256[](numSlots * 4);
        c1Scalars = new uint256[](numSlots);
        for (uint256 i = 0; i < numSlots; i++) {
            c1Scalars[i] = 0x3000 + i;
            (uint256 c1X, uint256 c1Y) = EllipticCurve.ecMul(c1Scalars[i], EllipticCurve.GX, EllipticCurve.GY);
            deck[i * 4] = c1X;
            deck[i * 4 + 1] = c1Y;
            deck[i * 4 + 2] = EllipticCurve.GX;
            deck[i * 4 + 3] = EllipticCurve.GY;
        }
        bytes32 deckCommitment = _deckHash(deck);

        bytes memory gameState = abi.encode("gs-f2", tableId);
        ChannelStateN memory s = _emptyState(tableId, n);
        s.nonce = 1;
        s.balances[0] = buyIn;
        s.balances[1] = buyIn;
        s.deckCommitment = deckCommitment;
        s.phase = 10; // SHOWDOWN
        s.gameStateHash = keccak256(gameState);
        bytes[] memory sigs = _coSign(n, s);
        zk.openShowdownDispute(tableId, s, sigs, gameState);
        openDeadline = _disputeDeadline(tableId);
    }

    /// Gate 1: once `block.number > disputeDeadline`, `postShowdownReveals` reverts
    /// `ShowdownWindowExpired` — no more posts, period. Only `resolveShowdownTimeout` may
    /// terminate the dispute past this point (mutually exclusive terminals, no boundary race).
    function test_postShowdownReveals_revertsShowdownWindowExpired_afterDeadline() public {
        uint256 sk0 = 0xAAA1;
        (bytes32 tableId, uint256[] memory deck, uint256[] memory c1Scalars, uint64 openDeadline) =
            _openShowdownForF2(sk0, 2 ether);

        vm.roll(uint256(openDeadline) + 1);

        (, , uint256[2] memory share, uint256[5] memory proof) =
            _makeShareProof(sk0, c1Scalars[0], 0xF00D, _ctxFor(tableId, 0));
        uint32[] memory slots = new uint32[](1);
        slots[0] = 0;
        uint256[2][] memory shares = new uint256[2][](1);
        shares[0] = share;
        uint256[5][] memory proofs = new uint256[5][](1);
        proofs[0] = proof;

        vm.expectRevert(HoldemTableN.ShowdownWindowExpired.selector);
        zk.postShowdownReveals(tableId, 0, deck, slots, shares, proofs);
    }

    /// Gate 2: a partial post (fewer than `requiredCount` shares for the posting seat) must NOT
    /// extend `disputeDeadline` — closing the drip-feed grief where a withholding seat rides the
    /// clock out to `deadlineCeil` one legitimate-but-incomplete share at a time. A post that
    /// DOES complete the seat's full batch still refreshes the group clock exactly as before,
    /// preserving liveness for the documented single-call path.
    function test_postShowdownReveals_extendsDeadlineOnlyOnCompletion() public {
        uint256 sk0 = 0xBBB1;
        (bytes32 tableId, uint256[] memory deck, uint256[] memory c1Scalars, uint64 openDeadline) =
            _openShowdownForF2(sk0, 2 ether);
        assertEq(openDeadline, uint64(block.number) + CLOCK, "initial deadline == open block + clockBlocks");

        // Roll partway toward the deadline so any (incorrect) extension is observable, then post
        // ONE of the 9 required shares — genuine, DLEQ-proven, non-duplicate, but incomplete.
        vm.roll(block.number + CLOCK - 2);
        (, , uint256[2] memory share0, uint256[5] memory proof0) =
            _makeShareProof(sk0, c1Scalars[0], 0x1111, _ctxFor(tableId, 0));
        uint32[] memory slots0 = new uint32[](1);
        slots0[0] = 0;
        uint256[2][] memory shares0 = new uint256[2][](1);
        shares0[0] = share0;
        uint256[5][] memory proofs0 = new uint256[5][](1);
        proofs0[0] = proof0;
        zk.postShowdownReveals(tableId, 0, deck, slots0, shares0, proofs0);

        assertEq(_disputeDeadline(tableId), openDeadline, "partial post must NOT extend the deadline (F2)");

        // seat0 now posts its remaining 8 required shares in one batch, completing its full
        // requiredCount -> THIS post refreshes the group clock.
        uint256 numSlots = c1Scalars.length;
        uint32[] memory slotsRest = new uint32[](numSlots - 1);
        uint256[2][] memory sharesRest = new uint256[2][](numSlots - 1);
        uint256[5][] memory proofsRest = new uint256[5][](numSlots - 1);
        for (uint256 i = 1; i < numSlots; i++) {
            (, , uint256[2] memory sh, uint256[5] memory pr) =
                _makeShareProof(sk0, c1Scalars[i], 0x2222 + i, _ctxFor(tableId, uint32(i)));
            slotsRest[i - 1] = uint32(i);
            sharesRest[i - 1] = sh;
            proofsRest[i - 1] = pr;
        }
        zk.postShowdownReveals(tableId, 0, deck, slotsRest, sharesRest, proofsRest);

        uint64 afterComplete = _disputeDeadline(tableId);
        assertEq(afterComplete, uint64(block.number) + CLOCK, "completing post DOES extend the deadline (F2)");
        assertGt(afterComplete, openDeadline, "extension actually moved the deadline forward");
    }

    /// End-to-end: a withholding seat's post-expiry front-run attempt (one more share, purely to
    /// re-extend the clock and dodge `resolveShowdownTimeout`) is rejected outright by Gate 1;
    /// `resolveShowdownTimeout` then terminates the dispute permissionlessly. Nobody ever
    /// answered here (seat1 posts nothing), so `rankable` is false regardless (the joint-key
    /// decode needs EVERY seat's share for the board, which seat1 withheld entirely) and the
    /// guaranteed-terminal split fires — refunding each seat's co-signed balance and splitting
    /// the pot evenly among the live seats (`_splitShowdownPots`/`HoldemShowdownLib.splitPots`,
    /// `prefer=0`). The full asymmetric "one seat fully answers, the other forfeits its OWN pot
    /// eligibility and the answerer sweeps the pot" case is proven with real settle math under
    /// the ffi profile (see `HoldemTableNShowdownC2.t.sol`'s
    /// `test_postShowdownReveals_frontRunAfterDeadlineReverts_thenAnswererSweepsPot`).
    function test_postShowdownReveals_frontRunAfterDeadlineReverts_thenResolveSplits() public {
        uint256 sk0 = 0xCCC1;
        uint256 buyIn = 2 ether;
        (bytes32 tableId, uint256[] memory deck, uint256[] memory c1Scalars, uint64 openDeadline) =
            _openShowdownForF2(sk0, buyIn);

        // seat0 posts a single share pre-expiry (never completes; irrelevant to the split
        // outcome, just proves a genuine partial post coexists fine with the eventual split).
        (, , uint256[2] memory share0, uint256[5] memory proof0) =
            _makeShareProof(sk0, c1Scalars[0], 0x1234, _ctxFor(tableId, 0));
        uint32[] memory slots0 = new uint32[](1);
        slots0[0] = 0;
        uint256[2][] memory shares0 = new uint256[2][](1);
        shares0[0] = share0;
        uint256[5][] memory proofs0 = new uint256[5][](1);
        proofs0[0] = proof0;
        zk.postShowdownReveals(tableId, 0, deck, slots0, shares0, proofs0);

        vm.roll(uint256(openDeadline) + 1);

        // Front-run attempt: one more (otherwise perfectly valid) share, purely to push the
        // deadline forward and dodge the honest resolve below. Gate 1 rejects it outright.
        (, , uint256[2] memory share1, uint256[5] memory proof1) =
            _makeShareProof(sk0, c1Scalars[1], 0x5678, _ctxFor(tableId, 1));
        uint32[] memory slots1 = new uint32[](1);
        slots1[0] = 1;
        uint256[2][] memory shares1 = new uint256[2][](1);
        shares1[0] = share1;
        uint256[5][] memory proofs1 = new uint256[5][](1);
        proofs1[0] = proof1;
        vm.expectRevert(HoldemTableN.ShowdownWindowExpired.selector);
        zk.postShowdownReveals(tableId, 0, deck, slots1, shares1, proofs1);

        address a0 = zk.seatAt(tableId, 0);
        address a1 = zk.seatAt(tableId, 1);
        uint256 before0 = token.balanceOf(a0);
        uint256 before1 = token.balanceOf(a1);

        vm.prank(address(0xBEEF)); // permissionless resolve
        zk.resolveShowdownTimeout(tableId, deck, abi.encode("gs-f2", tableId));

        // No pot was ever placed in this fixture (balances = [buyIn, buyIn], pot = 0) — the
        // resolve is a pure liveness proof (front-run rejected, table unfreezes) rather than a
        // payout-shape assertion; conservation + settled status are the load-bearing checks.
        assertEq(token.balanceOf(a0) - before0, buyIn, "seat0 gets back its co-signed balance");
        assertEq(token.balanceOf(a1) - before1, buyIn, "seat1 gets back its co-signed balance");
        assertEq(token.balanceOf(address(zk)), 0, "conservation: no residue");
        assertEq(uint8(zk.status(tableId)), uint8(ChannelTableBase.Status.Settled), "settled, not frozen");
    }
}

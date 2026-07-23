// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ZkTable} from "../../contracts/zk/ZkTable.sol";
import {ChannelState} from "../../contracts/zk/ChannelState.sol";
import {IGameRules} from "../../contracts/zk/IGameRules.sol";
import {MockGameRules} from "../../contracts/test/MockGameRules.sol";

/// @notice Drives a single ZkTable through randomized interleavings of create / join /
/// top-up / settle / dispute / respond / timeout / cancel, with every co-signed state
/// signed for real via `vm.sign` over the EIP-712 digest. Payout recipients are a small
/// pool of handler-owned EOAs whose private keys the handler holds, so it can both prank
/// as them (creates/joins land their escrow) AND co-sign channel states as their channel
/// keys (the EOA address IS the channel key). Funds in and out are tracked with ghosts:
///
///   ghostIn  += msg.value on every successful create / join / topUp
///   ghostOut += the actual balance delta of the player EOAs after every successful
///               settle / resolveTimeout / cancel (sum over the pool)
///
/// Invalid orderings revert and are absorbed (fail_on_revert = false); ghosts only move on
/// the success path, so `address(zk).balance == ghostIn - ghostOut` must always hold.
contract ZkTableHandler is Test {
    ZkTable public zk;
    MockGameRules public rules;

    uint256 public ghostIn;
    uint256 public ghostOut;

    // Player pool: fixed pk/addr pairs. The address doubles as the channel key, so the
    // same pk that owns the wallet also co-signs that seat's channel states.
    uint256 internal constant POOL = 4;
    uint256[POOL] internal pks;
    address[POOL] internal addrs;

    uint64 internal constant CLOCK = 30; // fixed across all tables => one global roll resolves deadlines
    uint256[2] internal ZERO_DECK = [uint256(0), uint256(0)];

    struct Seat { uint256 pk; address who; uint256 escrow; }

    struct TableRec {
        bytes32 id;
        Seat A;
        Seat B;
        uint64 nonce;        // highest co-signed nonce the handler has produced
        bool live;           // joined and not yet terminal/disputed
        bool disputed;
        bool terminal;       // settled or cancelled
        uint8 demandKind;    // 0 = none / setup, 1 = move, 2 = share (when disputed)
    }

    bytes32[] public allTableIds;
    mapping(bytes32 => TableRec) internal recs;
    bytes32[] public terminalIds; // tables the handler observed reach Settled/Cancelled

    constructor(ZkTable _zk, MockGameRules _rules) {
        zk = _zk;
        rules = _rules;
        for (uint256 i = 0; i < POOL; i++) {
            pks[i] = 0xC0FFEE + i;
            addrs[i] = vm.addr(pks[i]);
            vm.deal(addrs[i], 1_000_000 ether);
        }
    }

    // ── ghost / view helpers ───────────────────────────────────────────────────

    function allTablesLength() external view returns (uint256) { return allTableIds.length; }
    function terminalIdsLength() external view returns (uint256) { return terminalIds.length; }
    function terminalIdAt(uint256 i) external view returns (bytes32) { return terminalIds[i]; }

    function _poolBalance() internal view returns (uint256 sum) {
        for (uint256 i = 0; i < POOL; i++) sum += addrs[i].balance;
    }

    function _seatState(bytes32 id) internal view returns (uint256 escA, uint256 escB, ZkTable.Status status) {
        (, , , , escA, escB, , , , status, , , , , , , ) = zk.tables(id);
    }

    function _coSign(uint256 pkA, uint256 pkB, ChannelState memory s)
        internal
        view
        returns (bytes memory sigA, bytes memory sigB)
    {
        bytes32 digest = zk.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pkA, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(pkB, digest);
        sigA = abi.encodePacked(r1, s1, v1);
        sigB = abi.encodePacked(r2, s2, v2);
    }

    /// Conserving final/contested state for a table, splitting the CURRENT total escrow.
    function _stateFor(bytes32 id, uint64 nonce, uint256 cutA, uint256 pot, uint8 phase, bytes32 gsHash)
        internal
        view
        returns (ChannelState memory s)
    {
        (uint256 escA, uint256 escB, ) = _seatState(id);
        uint256 total = escA + escB;
        uint256 p = pot > total ? total : pot;
        uint256 rem = total - p;
        uint256 balA = cutA > rem ? rem : cutA;
        s.tableId = id;
        s.nonce = nonce;
        s.balanceA = balA;
        s.balanceB = rem - balA;
        s.pot = p;
        s.deckCommitment = bytes32(0);
        s.phase = phase;
        s.gameStateHash = gsHash;
    }

    // ── actions ────────────────────────────────────────────────────────────────

    /// Create a Created table owned by pool seat `seatA`, with stake bounded.
    function createTable(uint256 seatSeed, uint96 escrow, uint96 stake) public {
        uint256 ia = bound(seatSeed, 0, POOL - 1);
        uint256 e = bound(uint256(escrow), 1, 10_000 ether);
        uint256 st = bound(uint256(stake), 1, 10_000 ether);
        address who = addrs[ia];
        vm.prank(who);
        try zk.create{value: e}(IGameRules(address(rules)), st, CLOCK, who, ZERO_DECK) returns (bytes32 id) {
            ghostIn += e;
            TableRec storage r = recs[id];
            r.id = id;
            r.A = Seat({pk: pks[ia], who: who, escrow: e});
            r.B = Seat({pk: 0, who: address(0), escrow: 0});
            allTableIds.push(id);
        } catch {}
    }

    /// Join a Created table as a DIFFERENT pool seat (keyB must not collide with A).
    function joinTable(uint256 idxSeed, uint256 seatSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[bound(idxSeed, 0, allTableIds.length - 1)];
        TableRec storage r = recs[id];
        (, , ZkTable.Status status) = _seatState(id);
        if (status != ZkTable.Status.Created) return;
        (, , , , , , uint256 stake, , , , , , , , , , ) = zk.tables(id);
        // pick a seat distinct from A
        uint256 ib = bound(seatSeed, 0, POOL - 1);
        if (addrs[ib] == r.A.who) ib = (ib + 1) % POOL;
        address who = addrs[ib];
        vm.prank(who);
        try zk.join{value: stake}(id, who, ZERO_DECK) {
            ghostIn += stake;
            r.B = Seat({pk: pks[ib], who: who, escrow: stake});
            r.live = true;
        } catch {}
    }

    /// Top up one seat of a Live table.
    function topUpTable(uint256 idxSeed, uint96 amount, bool seatA) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[bound(idxSeed, 0, allTableIds.length - 1)];
        TableRec storage r = recs[id];
        (, , ZkTable.Status status) = _seatState(id);
        if (status != ZkTable.Status.Live) return;
        uint256 amt = bound(uint256(amount), 1, 10_000 ether);
        address who = seatA ? r.A.who : r.B.who;
        if (who == address(0)) return;
        vm.prank(who);
        try zk.topUp{value: amt}(id) {
            ghostIn += amt;
            if (seatA) r.A.escrow += amt; else r.B.escrow += amt;
        } catch {}
    }

    /// Co-sign a conserving final state (pot == 0, final phase) and settle.
    function settleTable(uint256 idxSeed, uint96 cutA) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[bound(idxSeed, 0, allTableIds.length - 1)];
        TableRec storage r = recs[id];
        (, , ZkTable.Status status) = _seatState(id);
        if (status != ZkTable.Status.Live) return;
        uint64 n = r.nonce + 1;
        ChannelState memory s = _stateFor(id, n, uint256(cutA), 0, 1, bytes32(0)); // pot 0, phase final
        (bytes memory sigA, bytes memory sigB) = _coSign(r.A.pk, r.B.pk, s);

        uint256 before = _poolBalance();
        vm.prank(r.A.who);
        try zk.settle(id, s, sigA, sigB) {
            ghostOut += _poolBalance() - before;
            r.nonce = n;
            _markTerminal(id);
        } catch {}
    }

    /// Open a MOVE dispute with a conserving contested state (pot may be > 0).
    function disputeTable(uint256 idxSeed, uint96 cutA, uint96 pot) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[bound(idxSeed, 0, allTableIds.length - 1)];
        TableRec storage r = recs[id];
        (, , ZkTable.Status status) = _seatState(id);
        if (status != ZkTable.Status.Live) return;
        bytes memory gameState = abi.encode("gs", id, r.nonce);
        bytes32 gsHash = keccak256(gameState);
        uint64 n = r.nonce + 1;
        ChannelState memory s = _stateFor(id, n, uint256(cutA), uint256(pot), 0, gsHash);
        (bytes memory sigA, bytes memory sigB) = _coSign(r.A.pk, r.B.pk, s);

        vm.prank(r.A.who);
        try zk.openDispute(id, s, sigA, sigB, gameState, 1, 0) {
            r.nonce = n;
            r.disputed = true;
            r.live = false;
            r.demandKind = 1;
        } catch {}
    }

    /// Answer an open dispute with a strictly-newer co-signed state (back to Live).
    function respondState(uint256 idxSeed, uint96 cutA) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[bound(idxSeed, 0, allTableIds.length - 1)];
        TableRec storage r = recs[id];
        (, , ZkTable.Status status) = _seatState(id);
        if (status != ZkTable.Status.Disputed) return;
        uint64 n = r.nonce + 1;
        ChannelState memory s = _stateFor(id, n, uint256(cutA), 0, 1, bytes32(0));
        (bytes memory sigA, bytes memory sigB) = _coSign(r.A.pk, r.B.pk, s);

        vm.prank(r.B.who);
        try zk.respondWithState(id, s, sigA, sigB) {
            r.nonce = n;
            r.disputed = false;
            r.live = true;
            r.demandKind = 0;
        } catch {}
    }

    /// Roll past the (fixed) clock and resolve a stale dispute by forfeit.
    function timeoutTable(uint256 idxSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[bound(idxSeed, 0, allTableIds.length - 1)];
        (, , ZkTable.Status status) = _seatState(id);
        if (status != ZkTable.Status.Disputed) return;
        vm.roll(block.number + CLOCK + 1); // CLOCK is global; +CLOCK+1 clears every live deadline

        uint256 before = _poolBalance();
        try zk.resolveTimeout(id) {
            ghostOut += _poolBalance() - before;
            _markTerminal(id);
        } catch {}
    }

    /// Cancel a Created (never-joined) table; refunds A.
    function cancelTable(uint256 idxSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[bound(idxSeed, 0, allTableIds.length - 1)];
        TableRec storage r = recs[id];
        (, , ZkTable.Status status) = _seatState(id);
        if (status != ZkTable.Status.Created) return;
        uint256 before = _poolBalance();
        vm.prank(r.A.who);
        try zk.cancel(id) {
            ghostOut += _poolBalance() - before;
            _markTerminal(id);
        } catch {}
    }

    function _markTerminal(bytes32 id) internal {
        TableRec storage r = recs[id];
        if (r.terminal) return;
        r.terminal = true;
        r.live = false;
        r.disputed = false;
        terminalIds.push(id);
    }
}

contract ZkTableInvariantTest is StdInvariant, Test {
    ZkTable internal zk;
    MockGameRules internal rules;
    ZkTableHandler internal handler;

    function setUp() public {
        zk = new ZkTable();
        rules = new MockGameRules();
        handler = new ZkTableHandler(zk, rules);

        bytes4[] memory sels = new bytes4[](8);
        sels[0] = ZkTableHandler.createTable.selector;
        sels[1] = ZkTableHandler.joinTable.selector;
        sels[2] = ZkTableHandler.topUpTable.selector;
        sels[3] = ZkTableHandler.settleTable.selector;
        sels[4] = ZkTableHandler.disputeTable.selector;
        sels[5] = ZkTableHandler.respondState.selector;
        sels[6] = ZkTableHandler.timeoutTable.selector;
        sels[7] = ZkTableHandler.cancelTable.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// No wei stuck or conjured: the contract holds exactly what came in minus what left.
    function invariant_noWeiStuck() public view {
        assertEq(address(zk).balance, handler.ghostIn() - handler.ghostOut(), "balance == in - out");
    }

    /// Payouts never exceed total escrow received.
    function invariant_payoutNeverExceedsEscrow() public view {
        assertGe(handler.ghostIn(), handler.ghostOut(), "out never exceeds in");
    }

    /// Every table the handler observed reach a terminal state holds nothing.
    function invariant_terminalTablesHoldNothing() public view {
        uint256 n = handler.terminalIdsLength();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.terminalIdAt(i);
            ( , , , , uint256 escA, uint256 escB, , , , ZkTable.Status status, , , , , , , ) = zk.tables(id);
            assertTrue(
                status == ZkTable.Status.Settled || status == ZkTable.Status.Cancelled,
                "terminal status"
            );
            assertEq(escA, 0, "terminal escrowA == 0");
            assertEq(escB, 0, "terminal escrowB == 0");
        }
    }
}

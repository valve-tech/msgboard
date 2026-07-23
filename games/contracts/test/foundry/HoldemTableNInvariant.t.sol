// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {HoldemTableN} from "../../contracts/zk/HoldemTableN.sol";
import {ChannelStateN, SidePot} from "../../contracts/zk/ChannelStateN.sol";
import {IGameRulesN} from "../../contracts/zk/IGameRulesN.sol";
import {MockGameRulesN} from "../../contracts/test/MockGameRulesN.sol";

/// @notice Drives HoldemTableN tables through randomized create / join / start / settle /
/// dispute / respond / timeout / cancel interleavings, every co-signed state signed for real
/// via vm.sign over the EIP-712 digest. A small pool of handler-owned EOAs both prank as
/// seats (so escrow lands) AND co-sign as their channel keys (the EOA IS the channel key).
/// Ghost accounting:
///   ghostIn  += msg.value on every successful create / join
///   ghostOut += the pool's actual balance delta after every successful settle / timeout / cancel
/// so address(zk).balance == ghostIn - ghostOut must always hold (solvency).
contract HoldemTableNHandler is Test {
    HoldemTableN public zk;
    MockGameRulesN public rules;

    uint256 public ghostIn;
    uint256 public ghostOut;

    uint256 internal constant POOL = 6;
    uint256[POOL] internal pks;
    address[POOL] internal addrs;

    uint64 internal constant CLOCK = 30;

    struct TableRec {
        bytes32 id;
        uint256 n;            // seat count
        uint256[POOL] seatPk; // pk per seat (only first n used)
        uint256 buyIn;
        uint64 nonce;
        bool forming;
        bool live;
        bool disputed;
        bool terminal;
    }

    bytes32[] public allTableIds;
    mapping(bytes32 => TableRec) internal recs;
    bytes32[] public terminalIds;

    constructor(HoldemTableN _zk, MockGameRulesN _rules) {
        zk = _zk;
        rules = _rules;
        for (uint256 i = 0; i < POOL; i++) {
            pks[i] = 0xC0FFEE + i;
            addrs[i] = vm.addr(pks[i]);
            vm.deal(addrs[i], 1_000_000 ether);
        }
    }

    function allTablesLength() external view returns (uint256) { return allTableIds.length; }
    function terminalIdsLength() external view returns (uint256) { return terminalIds.length; }
    function terminalIdAt(uint256 i) external view returns (bytes32) { return terminalIds[i]; }

    function _poolBalance() internal view returns (uint256 sum) {
        for (uint256 i = 0; i < POOL; i++) sum += addrs[i].balance;
    }

    function _coSign(TableRec storage r, ChannelStateN memory s) internal view returns (bytes[] memory sigs) {
        bytes32 digest = zk.stateDigest(s);
        sigs = new bytes[](r.n);
        for (uint256 i = 0; i < r.n; i++) {
            (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(r.seatPk[i], digest);
            sigs[i] = abi.encodePacked(rr, ss, v);
        }
    }

    /// A conserving state splitting the table's total escrow across balances + pot.
    function _stateFor(TableRec storage r, uint64 nonce, uint256 potSeed, uint8 phase, bytes32 gsHash)
        internal
        view
        returns (ChannelStateN memory s)
    {
        uint256 total = r.n * r.buyIn;
        uint256 pot = potSeed % (total + 1);
        uint256 rem = total - pot;
        s.tableId = r.id;
        s.nonce = nonce;
        s.balances = new uint256[](r.n);
        // spread `rem` across seats deterministically
        uint256 left = rem;
        for (uint256 i = 0; i < r.n - 1; i++) {
            uint256 cut = uint256(keccak256(abi.encode(potSeed, i))) % (left + 1);
            s.balances[i] = cut;
            left -= cut;
        }
        s.balances[r.n - 1] = left;
        s.pot = pot;
        s.sidePots = new SidePot[](0);
        s.phase = phase;
        s.gameStateHash = gsHash;
    }

    // ── actions ────────────────────────────────────────────────────────────────

    function createTable(uint256 nSeed, uint96 buySeed, uint256 seatSeed) public {
        uint256 n = 2 + (nSeed % (POOL - 1)); // 2..POOL
        uint256 buyIn = bound(uint256(buySeed), 1, 1_000 ether);
        uint256 ia = seatSeed % POOL;
        address who = addrs[ia];
        vm.prank(who);
        try zk.create{value: buyIn}(IGameRulesN(address(rules)), buyIn, n, 0, 0, CLOCK, who) returns (bytes32 id) {
            ghostIn += buyIn;
            TableRec storage r = recs[id];
            r.id = id;
            r.n = n;
            r.buyIn = buyIn;
            r.seatPk[0] = pks[ia];
            r.forming = true;
            allTableIds.push(id);
        } catch {}
    }

    /// Join the next free seat of a Forming table with a not-yet-seated pool member.
    function joinTable(uint256 idxSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[idxSeed % allTableIds.length];
        TableRec storage r = recs[id];
        if (!r.forming) return;
        uint256 seated = zk.seatCount(id);
        if (seated >= r.n) return;
        // pick a pool member not already seated at this table
        for (uint256 j = 0; j < POOL; j++) {
            address cand = addrs[j];
            bool used;
            for (uint256 k = 0; k < seated; k++) if (zk.seatAt(id, k) == cand) { used = true; break; }
            if (used) continue;
            vm.prank(cand);
            try zk.join{value: r.buyIn}(id, cand) {
                ghostIn += r.buyIn;
                r.seatPk[seated] = pks[j];
            } catch {}
            return;
        }
    }

    function startTable(uint256 idxSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[idxSeed % allTableIds.length];
        TableRec storage r = recs[id];
        if (!r.forming) return;
        if (zk.seatCount(id) < r.n) return; // only start full tables (keeps seatPk complete)
        vm.prank(zk.seatAt(id, 0));
        try zk.start(id) {
            r.forming = false;
            r.live = true;
        } catch {}
    }

    function settleTable(uint256 idxSeed, uint96 potSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[idxSeed % allTableIds.length];
        TableRec storage r = recs[id];
        if (!r.live) return;
        uint64 nn = r.nonce + 1;
        ChannelStateN memory s = _stateFor(r, nn, 0, 11, bytes32(0)); // pot 0, final
        bytes[] memory sigs = _coSign(r, s);
        uint256 before = _poolBalance();
        vm.prank(zk.seatAt(id, 0));
        try zk.settle(id, s, sigs) {
            ghostOut += _poolBalance() - before;
            r.nonce = nn;
            _markTerminal(id);
        } catch {}
    }

    function disputeTable(uint256 idxSeed, uint96 potSeed, uint256 seatSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[idxSeed % allTableIds.length];
        TableRec storage r = recs[id];
        if (!r.live) return;
        bytes memory gs = abi.encode("gs", id, r.nonce);
        bytes32 gsHash = keccak256(gs);
        uint64 nn = r.nonce + 1;
        ChannelStateN memory s = _stateFor(r, nn, uint256(potSeed), 4, gsHash);
        bytes[] memory sigs = _coSign(r, s);
        uint8 demandSeat = uint8(seatSeed % r.n);
        vm.prank(zk.seatAt(id, 0));
        try zk.openDispute(id, s, sigs, gs, demandSeat, 1, 0) {
            r.nonce = nn;
            r.live = false;
            r.disputed = true;
        } catch {}
    }

    function respondState(uint256 idxSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[idxSeed % allTableIds.length];
        TableRec storage r = recs[id];
        if (!r.disputed) return;
        uint64 nn = r.nonce + 1;
        ChannelStateN memory s = _stateFor(r, nn, 0, 4, bytes32(0));
        bytes[] memory sigs = _coSign(r, s);
        vm.prank(zk.seatAt(id, 0));
        try zk.respondWithState(id, s, sigs) {
            r.nonce = nn;
            r.disputed = false;
            r.live = true;
        } catch {}
    }

    function timeoutTable(uint256 idxSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[idxSeed % allTableIds.length];
        TableRec storage r = recs[id];
        if (!r.disputed) return;
        vm.roll(block.number + CLOCK + 1);
        uint256 before = _poolBalance();
        try zk.resolveTimeout(id) {
            ghostOut += _poolBalance() - before;
            _markTerminal(id);
        } catch {}
    }

    function cancelTable(uint256 idxSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = allTableIds[idxSeed % allTableIds.length];
        TableRec storage r = recs[id];
        if (!r.forming) return;
        if (zk.seatCount(id) != 1) return;
        uint256 before = _poolBalance();
        vm.prank(zk.seatAt(id, 0));
        try zk.cancel(id) {
            ghostOut += _poolBalance() - before;
            _markTerminal(id);
        } catch {}
    }

    function _markTerminal(bytes32 id) internal {
        TableRec storage r = recs[id];
        if (r.terminal) return;
        r.terminal = true;
        r.forming = false;
        r.live = false;
        r.disputed = false;
        terminalIds.push(id);
    }
}

contract HoldemTableNInvariantTest is StdInvariant, Test {
    HoldemTableN internal zk;
    MockGameRulesN internal rules;
    HoldemTableNHandler internal handler;

    function setUp() public {
        zk = new HoldemTableN(address(0xBEEF));
        rules = new MockGameRulesN();
        handler = new HoldemTableNHandler(zk, rules);

        bytes4[] memory sels = new bytes4[](8);
        sels[0] = HoldemTableNHandler.createTable.selector;
        sels[1] = HoldemTableNHandler.joinTable.selector;
        sels[2] = HoldemTableNHandler.startTable.selector;
        sels[3] = HoldemTableNHandler.settleTable.selector;
        sels[4] = HoldemTableNHandler.disputeTable.selector;
        sels[5] = HoldemTableNHandler.respondState.selector;
        sels[6] = HoldemTableNHandler.timeoutTable.selector;
        sels[7] = HoldemTableNHandler.cancelTable.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// Solvency: the contract holds exactly what came in minus what left.
    function invariant_solvent() public view {
        assertEq(address(zk).balance, handler.ghostIn() - handler.ghostOut(), "balance == in - out");
    }

    /// Payouts never exceed total escrow received.
    function invariant_payoutNeverExceedsEscrow() public view {
        assertGe(handler.ghostIn(), handler.ghostOut(), "out never exceeds in");
    }

    /// Every terminal table holds nothing.
    function invariant_terminalTablesHoldNothing() public view {
        uint256 n = handler.terminalIdsLength();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.terminalIdAt(i);
            HoldemTableN.Status st = zk.status(id);
            assertTrue(
                st == HoldemTableN.Status.Settled || st == HoldemTableN.Status.Cancelled,
                "terminal status"
            );
            assertEq(zk.totalEscrow(id), 0, "terminal escrow == 0");
        }
    }
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {CoinFlipTables} from "../../contracts/games/CoinFlipTables.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {MockRandom} from "./MockRandom.sol";

/// @notice Drives CoinFlipTables through randomized interleavings of the full operator/player
/// surface — createTable, setParams, setOpen, fundHot/fundCold, withdrawHot/withdrawCold,
/// promote/demote, refillHot, stakeForRank/unstake, open, settle (push via MockRandom.pushCast),
/// claim (pull fallback via a seed set without delivery), and refundStale — across multiple
/// operators, multiple tables per operator, and a small player pool. Every table-admin action
/// pranks as the table's REAL operator (read from chain state) so onlyOperator gates are exercised
/// honestly rather than being dodged. Invalid orderings revert and are absorbed
/// (fail_on_revert = false); ghosts only move on the success path. Chip accounting:
///   chipsIn  += amount on a successful fundHot / fundCold / stakeForRank
///   chipsIn  += stake  on a successful open (the player's own stake enters escrow)
///   chipsOut += amount on a successful withdrawHot / withdrawCold / unstake
///   chipsOut += payout on a settle (push or pull) that resolves in the player's favor
///   chipsOut += stake  on a successful refundStale (the player reclaims their own stake)
/// promote/demote/refillHot never move ghosts — they only reshuffle hot<->cold internally.
contract CoinFlipTablesHandler is Test {
    CoinFlipTables public tables;
    MockRandom public rnd;
    Chips public chips;

    address[] internal subset;
    PreimageLocation.Info[] internal locs;

    uint256 internal constant OPERATORS = 3;
    uint256 internal constant PLAYERS = 3;
    address[] internal operators;
    address[] internal players;
    address[] internal actors; // operators ++ players, for permissionless callers (fund/open/claim/refund)

    uint256 public chipsIn;
    uint256 public chipsOut;

    bytes32[] public allTableIds;
    bytes32[] public allRoundIds;

    /// @dev Actor addresses and their Chips balances are set up by the caller (the InvariantTest
    /// contract, which is the ONLY account Chips.mint (onlyOwner) will accept) before this handler
    /// is constructed. The handler itself only needs to grant its own allowance from each actor.
    constructor(
        CoinFlipTables _tables,
        MockRandom _rnd,
        Chips _chips,
        address[] memory _subset,
        PreimageLocation.Info[] memory _locs,
        address[] memory _operators,
        address[] memory _players
    ) {
        tables = _tables;
        rnd = _rnd;
        chips = _chips;
        for (uint256 i = 0; i < _subset.length; i++) {
            subset.push(_subset[i]);
            locs.push(_locs[i]);
        }

        for (uint256 i = 0; i < _operators.length; i++) {
            operators.push(_operators[i]);
            actors.push(_operators[i]);
        }
        for (uint256 i = 0; i < _players.length; i++) {
            players.push(_players[i]);
            actors.push(_players[i]);
        }
        for (uint256 i = 0; i < actors.length; i++) {
            vm.prank(actors[i]);
            chips.approve(address(tables), type(uint256).max);
        }
    }

    function allTableIdsLength() external view returns (uint256) { return allTableIds.length; }
    function allRoundIdsLength() external view returns (uint256) { return allRoundIds.length; }

    // ── internal helpers (never fuzzed — not public/external) ─────────────────

    function _operator(uint256 idx) internal view returns (address) {
        return operators[idx % operators.length];
    }

    function _actor(uint256 idx) internal view returns (address) {
        return actors[idx % actors.length];
    }

    function _tableIdAt(uint256 idx) internal view returns (bytes32) {
        return allTableIds[idx % allTableIds.length];
    }

    function _roundIdAt(uint256 idx) internal view returns (bytes32) {
        return allRoundIds[idx % allRoundIds.length];
    }

    function _tableOperator(bytes32 id) internal view returns (address op) {
        (op,,,,,,,,) = tables.tables(id);
    }

    // ── actions ─────────────────────────────────────────────────────────────

    function createTable(uint256 opIdx, uint16 multSeed, uint256 maxStakeSeed, uint256 hotTargetSeed) public {
        address op = _operator(opIdx);
        uint16 mult = uint16(bound(uint256(multSeed), 150, 200));
        uint256 maxStake = bound(maxStakeSeed, 1, 1000 ether);
        uint256 hotTarget = bound(hotTargetSeed, 0, 1000 ether);
        vm.prank(op);
        try tables.createTable(mult, maxStake, hotTarget) returns (bytes32 id) {
            allTableIds.push(id);
        } catch {}
    }

    function setParams(uint256 tblIdx, uint16 multSeed, uint256 maxStakeSeed, uint256 hotTargetSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address op = _tableOperator(id);
        uint16 mult = uint16(bound(uint256(multSeed), 150, 200));
        uint256 maxStake = bound(maxStakeSeed, 1, 1000 ether);
        uint256 hotTarget = bound(hotTargetSeed, 0, 1000 ether);
        vm.prank(op);
        try tables.setParams(id, mult, maxStake, hotTarget) {} catch {}
    }

    function setOpen(uint256 tblIdx, bool isOpen) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address op = _tableOperator(id);
        vm.prank(op);
        try tables.setOpen(id, isOpen) {} catch {}
    }

    function fundHot(uint256 tblIdx, uint256 actorIdx, uint256 amtSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address who = _actor(actorIdx);
        uint256 amount = bound(amtSeed, 0, 1000 ether);
        vm.prank(who);
        try tables.fundHot(id, amount) { chipsIn += amount; } catch {}
    }

    function fundCold(uint256 tblIdx, uint256 actorIdx, uint256 amtSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address who = _actor(actorIdx);
        uint256 amount = bound(amtSeed, 0, 1000 ether);
        vm.prank(who);
        try tables.fundCold(id, amount) { chipsIn += amount; } catch {}
    }

    function withdrawHot(uint256 tblIdx, uint256 amtSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address op = _tableOperator(id);
        uint256 amount = bound(amtSeed, 0, 1000 ether);
        vm.prank(op);
        try tables.withdrawHot(id, amount) { chipsOut += amount; } catch {}
    }

    function withdrawCold(uint256 tblIdx, uint256 amtSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address op = _tableOperator(id);
        uint256 amount = bound(amtSeed, 0, 1000 ether);
        vm.prank(op);
        try tables.withdrawCold(id, amount) { chipsOut += amount; } catch {}
    }

    function promote(uint256 tblIdx, uint256 amtSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address op = _tableOperator(id);
        uint256 amount = bound(amtSeed, 0, 1000 ether);
        vm.prank(op);
        try tables.promote(id, amount) {} catch {}
    }

    function demote(uint256 tblIdx, uint256 amtSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address op = _tableOperator(id);
        uint256 amount = bound(amtSeed, 0, 1000 ether);
        vm.prank(op);
        try tables.demote(id, amount) {} catch {}
    }

    function refillHot(uint256 tblIdx) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        try tables.refillHot(id) {} catch {}
    }

    function stakeForRank(uint256 tblIdx, uint256 amtSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address op = _tableOperator(id);
        uint256 amount = bound(amtSeed, 0, 1000 ether);
        vm.prank(op);
        try tables.stakeForRank(id, amount) { chipsIn += amount; } catch {}
    }

    function unstake(uint256 tblIdx, uint256 amtSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        address op = _tableOperator(id);
        uint256 amount = bound(amtSeed, 0, 1000 ether);
        vm.prank(op);
        try tables.unstake(id, amount) { chipsOut += amount; } catch {}
    }

    function open(uint256 tblIdx, uint256 playerIdx, uint256 sideSeed, uint256 stakeSeed) public {
        if (allTableIds.length == 0) return;
        bytes32 id = _tableIdAt(tblIdx);
        // Feasibility-aware: bound the stake to the table's REAL maxStake (tuple index 6) instead
        // of a fixed range unrelated to the table's own params. Without this, a table created with
        // a small maxStake makes almost every open() attempt revert StakeTooHigh — the corpus was
        // mostly wasted on a guaranteed-revert path instead of exercising open/settle/claim/refund.
        (, , , , , , uint256 maxStake, ,) = tables.tables(id);
        if (maxStake == 0) return;
        address player = players[playerIdx % players.length];
        uint8 side = uint8(bound(sideSeed, 0, 1));
        uint256 stake = bound(stakeSeed, 1, maxStake);
        vm.prank(player);
        // InsufficientBankroll is left as a real, reachable revert — hot is never force-funded here.
        try tables.open(id, side, stake, subset, locs) returns (bytes32 roundId) {
            chipsIn += stake;
            allRoundIds.push(roundId);
        } catch {}
    }

    /// @notice Push settlement path: drive a finalized seed straight through MockRandom.pushCast,
    /// which delivers onCast synchronously (mirrors what Random does on a live cast).
    function settle(uint256 roundIdx, uint256 seedWord) public {
        if (allRoundIds.length == 0) return;
        bytes32 roundId = _roundIdAt(roundIdx);
        (, , uint8 side, , uint256 payout, bytes32 key, , CoinFlipTables.Status status) = tables.rounds(roundId);
        if (status != CoinFlipTables.Status.Pending) return;
        bytes32 seed = bytes32(seedWord);
        bool won = uint8(uint256(seed) & 1) == side;
        try rnd.pushCast(address(tables), key, seed) {
            if (won) chipsOut += payout;
        } catch {}
    }

    /// @notice Pull-fallback path: set the seed WITHOUT delivering the push (setSeed, not
    /// pushCast), then call claim() so the pull branch of _settle is actually exercised.
    function claim(uint256 roundIdx, uint256 seedWord) public {
        if (allRoundIds.length == 0) return;
        bytes32 roundId = _roundIdAt(roundIdx);
        (, , uint8 side, , uint256 payout, bytes32 key, , CoinFlipTables.Status status) = tables.rounds(roundId);
        if (status != CoinFlipTables.Status.Pending) return;
        bytes32 seed = bytes32(seedWord);
        bool won = uint8(uint256(seed) & 1) == side;
        rnd.setSeed(key, seed);
        try tables.claim(roundId) {
            if (won) chipsOut += payout;
        } catch {}
    }

    /// @notice Drives the liveness-failure (chop) callback for a still-pending round's request key,
    /// mirroring what core Random does when a heat expires unfulfilled. This flips
    /// `choppedInstance[roundId]` to true via GameBase.onChop, which unlocks refundStale's early
    /// (pre-STALE_BLOCKS) branch (CoinFlipTables.sol:337) — otherwise unreachable in this corpus
    /// since every other path to a finalized/missing seed goes through settle/claim or the 200-block
    /// timeout. Moves no tokens — chop is a pure liveness marker.
    function chop(uint256 roundIdx) public {
        if (allRoundIds.length == 0) return;
        bytes32 roundId = _roundIdAt(roundIdx);
        (, , , , , bytes32 key, , CoinFlipTables.Status status) = tables.rounds(roundId);
        if (status != CoinFlipTables.Status.Pending) return;
        try rnd.pushChop(address(tables), key) {} catch {}
    }

    /// @notice Refund path for a round whose seed never finalized. Rolls past the 200-block stale
    /// window on the caller's request so the fuzz corpus doesn't rely on accumulating real block
    /// advances from other actions alone. A round the `chop` action already marked can also refund
    /// immediately (the chopped branch), so this exercises both refundStale gates.
    function refundStale(uint256 roundIdx, bool rollPastStale) public {
        if (allRoundIds.length == 0) return;
        bytes32 roundId = _roundIdAt(roundIdx);
        if (rollPastStale) vm.roll(block.number + 201);
        (, , , uint256 stake, , , , CoinFlipTables.Status status) = tables.rounds(roundId);
        if (status != CoinFlipTables.Status.Pending) return;
        try tables.refundStale(roundId) { chipsOut += stake; } catch {}
    }
}

contract CoinFlipTablesInvariantTest is StdInvariant, Test {
    CoinFlipTables internal tables;
    MockRandom internal rnd;
    Chips internal chips;
    CoinFlipTablesHandler internal handler;

    function setUp() public {
        rnd = new MockRandom();
        chips = new Chips();
        tables = new CoinFlipTables(address(rnd), address(chips));

        address[] memory subset = new address[](3);
        PreimageLocation.Info[] memory locs = new PreimageLocation.Info[](3);
        for (uint256 i = 0; i < 3; i++) {
            address v = address(uint160(0x9000 + i));
            tables.addValidator(v);
            subset[i] = v;
            locs[i] = PreimageLocation.Info({
                provider: v, callAtChange: true, durationIsTimestamp: false,
                duration: 12, token: address(0), price: 0, offset: 0, index: 0
            });
        }

        // Deterministic actor pools: 3 operators, 3 players. Chips.mint is onlyOwner and this
        // contract IS the owner (it deployed Chips above), so pre-fund here before the handler
        // exists — the handler only needs to approve its own allowance from each actor.
        uint256 operatorCount = 3;
        uint256 playerCount = 3;
        address[] memory operators = new address[](operatorCount);
        address[] memory players = new address[](playerCount);
        uint256 stash = 1_000_000_000 ether;
        for (uint256 i = 0; i < operatorCount; i++) {
            operators[i] = address(uint160(0x7000 + i));
            chips.mint(operators[i], stash);
        }
        for (uint256 i = 0; i < playerCount; i++) {
            players[i] = address(uint160(0x8000 + i));
            chips.mint(players[i], stash);
        }

        handler = new CoinFlipTablesHandler(tables, rnd, chips, subset, locs, operators, players);
        targetContract(address(handler));
    }

    /// Every chip the contract holds is exactly what came in minus what went out — nothing
    /// conjured, nothing stuck unaccounted.
    function invariant_chipsConserved() public view {
        assertEq(chips.balanceOf(address(tables)), handler.chipsIn() - handler.chipsOut(), "chips conserved");
    }

    /// Summed across every table ever created, hot+cold+escrowed+stake must equal the contract's
    /// entire chip balance — no pool leaks into (or out of) the aggregate.
    function invariant_poolsSumToBalance() public view {
        uint256 n = handler.allTableIdsLength();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.allTableIds(i);
            (, uint256 hot, uint256 cold, uint256 escrowed, uint256 stake,,,,) = tables.tables(id);
            sum += hot + cold + escrowed + stake;
        }
        assertEq(sum, chips.balanceOf(address(tables)), "pools sum to the contract's chip balance");
    }

    /// Per table, escrowed must equal the sum of payouts for that table's rounds still Pending —
    /// no phantom escrow left behind by a settle/refund, and no leaked escrow never accounted for.
    function invariant_escrowMatchesPendingPayouts() public view {
        uint256 nTables = handler.allTableIdsLength();
        uint256 nRounds = handler.allRoundIdsLength();
        for (uint256 t = 0; t < nTables; t++) {
            bytes32 tableId = handler.allTableIds(t);
            (, , , uint256 escrowed, , , , ,) = tables.tables(tableId);
            uint256 pendingSum;
            for (uint256 r = 0; r < nRounds; r++) {
                bytes32 roundId = handler.allRoundIds(r);
                (bytes32 rTableId, , , , uint256 payout, , , CoinFlipTables.Status status) = tables.rounds(roundId);
                if (rTableId == tableId && status == CoinFlipTables.Status.Pending) {
                    pendingSum += payout;
                }
            }
            assertEq(escrowed, pendingSum, "escrow matches sum of pending payouts for this table");
        }
    }
}

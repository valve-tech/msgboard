// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {SkillSettle} from "../../contracts/games/SkillSettle.sol";
import {SkillPayouts} from "../../contracts/games/SkillPayouts.sol";
import {HousePoolBase} from "../../contracts/games/HousePoolBase.sol";
import {WordleRules} from "../../contracts/zk/WordleRules.sol";
import {WordleCluePlonkVerifier} from "../../contracts/zk/generated/WordleCluePlonkVerifier.sol";
import {WordleSolvePlonkVerifier} from "../../contracts/zk/generated/WordleSolvePlonkVerifier.sol";

/// @notice Coverage-only unit suite for SkillSettle.sol (default profile, no contract changes).
///
/// SkillSettle.t.sol already covers the happy-path permissionless Wordle settle, the escrow-ceiling
/// funds-safety check (EscrowTooSmall), a forged house signature (BadSig), and the three BadProof
/// sad paths (understated guesses / tampered proof / stale dict root) plus the reclaim-after-deadline
/// loss path (DeadlineNotPassed). It leaves untested: BadGame (both the `open` ceiling-lookup site and
/// the `settleWordle` game-id guard), every flavour of BadStatus (bad clock window, duplicate open,
/// settle/reclaim on an unopened or already-settled table), NotPlayer, Expired, and BadGuesses
/// (out-of-range guesses-used). This file sweeps those.
///
/// Per the task's scope, SkillSettle inherits its house-pool trio (fundHouse/withdrawHouse/housePool/
/// InsufficientPool/HouseFunded/HouseWithdrawn) from HousePoolBase, which is already covered by
/// HouseBankrollUnit.t.sol / HouseBankroll.t.sol against the same shared code — so this file does not
/// re-test fundHouse/withdrawHouse/setHouseKey/InsufficientPool.
///
/// One SkillSettle branch is NOT exercised here because it is unreachable through the public API (see
/// the bottom of this file for the full explanation): `settleWordle`'s
/// `if (t.gameId != SkillPayouts.WORDLE_GAME_ID) revert BadGame();` guard. `open` is the only path
/// that can move a table to `Status.Live`, and `open` itself reverts BadGame via `_maxMultX100` for
/// any gameId other than WORDLE_GAME_ID — so a Live table's `gameId` is always WORDLE_GAME_ID by the
/// time `settleWordle` re-checks it.
contract SkillSettleUnitTest is Test {
    Chips internal chips;
    SkillSettle internal skill;
    WordleRules internal wordleRules;

    uint256 internal pkHouse = 0xB0B;
    address internal house;
    address internal player = address(uint160(uint256(keccak256("skill-unit-player"))));

    // wordle_solve fixture (4 signals: commit, guessesCommit, dictRoot, guessesUsed) — an ALL-GREEN
    // solve at guess #2 — reused read-only from the existing SkillSettle.t.sol fixture.
    uint256[24] internal wProof;
    uint256 internal wordleCommit;
    uint256 internal wordleGuessesCommit;
    uint256 internal wordleDictRoot;
    uint256 internal wordleGuessesUsed;

    uint64 internal constant CLOCK = 30;

    function setUp() public {
        chips = new Chips();
        wordleRules = new WordleRules(address(new WordleCluePlonkVerifier()), address(new WordleSolvePlonkVerifier()));
        skill = new SkillSettle(address(chips), address(wordleRules));

        house = vm.addr(pkHouse);
        skill.setHouseKey(house);

        chips.mint(address(this), 1_000_000);
        chips.approve(address(skill), type(uint256).max);
        skill.fundHouse(1_000_000);
        chips.mint(player, 100_000);
        vm.prank(player);
        chips.approve(address(skill), type(uint256).max);

        _loadWordle();
        skill.setWordleDictRoot(wordleDictRoot);

        // Anchor block.timestamp/block.number away from 0/1 so "before deadline"/"before expiry"
        // arithmetic below can't accidentally underflow.
        vm.warp(10_000);
        vm.roll(10_000);
    }

    function _loadWordle() internal {
        string memory json = vm.readFile("test/foundry/fixtures/wordleSolveProof.json");
        uint256[] memory pf = vm.parseJsonUintArray(json, ".proof");
        uint256[] memory ps = vm.parseJsonUintArray(json, ".pubSignals");
        for (uint256 i = 0; i < 24; i++) wProof[i] = pf[i];
        wordleCommit = ps[0];
        wordleGuessesCommit = ps[1];
        wordleDictRoot = ps[2];
        wordleGuessesUsed = ps[3];
    }

    // ---- open helpers ----------------------------------------------------------------------------

    function _termsFull(bytes32 tableId, uint256 stake, uint256 escrowHouse, uint8 gameId, uint64 clockBlocks, uint64 expiry)
        internal view returns (SkillSettle.SkillOpenTerms memory t)
    {
        t.tableId = tableId;
        t.player = player;
        t.escrowPlayer = stake;
        t.escrowHouse = escrowHouse;
        t.gameId = gameId;
        t.commit = wordleCommit;
        t.puzzleHash = bytes32(wordleGuessesCommit);
        t.clockBlocks = clockBlocks;
        t.expiry = expiry;
    }

    function _wordleTerms(bytes32 tableId, uint256 stake, uint256 escrowHouse)
        internal view returns (SkillSettle.SkillOpenTerms memory t)
    {
        return _termsFull(tableId, stake, escrowHouse, SkillPayouts.WORDLE_GAME_ID, CLOCK, uint64(block.timestamp + 1 hours));
    }

    function _sign(SkillSettle.SkillOpenTerms memory t) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkHouse, skill.openDigest(t));
        return abi.encodePacked(r, s, v);
    }

    function _open(SkillSettle.SkillOpenTerms memory t) internal {
        bytes memory sig = _sign(t);
        vm.prank(player);
        skill.open(t, sig);
    }

    // ============================ BadGame (open ceiling-lookup site) ===============================

    function test_open_rejects_badGameId() public {
        bytes32 tid = keccak256("unit-badgame");
        // A gameId other than WORDLE_GAME_ID (30) has no entry in _maxMultX100 → BadGame, even
        // though every other field (player/expiry/clock/sig) is otherwise valid.
        SkillSettle.SkillOpenTerms memory t = _termsFull(tid, 100, 2400, 7, CLOCK, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(t);
        vm.prank(player);
        vm.expectRevert(SkillSettle.BadGame.selector);
        skill.open(t, sig);
    }

    // ============================ InsufficientPool at open (SkillSettle's OWN escrow-reservation
    // check in `_openTable` — a distinct call site from the shared HousePoolBase fundHouse/
    // withdrawHouse mechanism the task scopes out; this one guards `open`'s own pool reservation
    // and is written directly in SkillSettle.sol, so it's in-scope for this file). ====================

    function test_open_rejects_insufficientHousePool() public {
        bytes32 tid = keccak256("unit-insufficient-pool");
        // escrowHouse clears the EscrowTooSmall ceiling check (>= maxProfit for a 1000 stake, 24000)
        // but exceeds the funded housePool (1_000_000 from setUp), so the *pool* check must fire.
        uint256 stake = 1_000;
        uint256 escrowHouse = skill.housePool() + 1;
        SkillSettle.SkillOpenTerms memory t = _termsFull(tid, stake, escrowHouse, SkillPayouts.WORDLE_GAME_ID, CLOCK, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(t);
        vm.prank(player);
        vm.expectRevert(HousePoolBase.InsufficientPool.selector);
        skill.open(t, sig);
    }

    // ============================ NotPlayer =========================================================

    function test_open_rejects_notPlayer() public {
        bytes32 tid = keccak256("unit-notplayer");
        SkillSettle.SkillOpenTerms memory t = _wordleTerms(tid, 100, 2400); // t.player == `player`
        bytes memory sig = _sign(t);
        // Called from the default test-contract sender, which is NOT `player`.
        vm.expectRevert(SkillSettle.NotPlayer.selector);
        skill.open(t, sig);
    }

    // ============================ Expired ===========================================================

    function test_open_rejects_expiredTerms() public {
        bytes32 tid = keccak256("unit-expired");
        SkillSettle.SkillOpenTerms memory t = _termsFull(tid, 100, 2400, SkillPayouts.WORDLE_GAME_ID, CLOCK, uint64(block.timestamp - 1));
        bytes memory sig = _sign(t);
        vm.prank(player);
        vm.expectRevert(SkillSettle.Expired.selector);
        skill.open(t, sig);
    }

    // ============================ BadStatus — bad clock window ======================================

    function test_open_rejects_clockBlocksTooShort() public {
        bytes32 tid = keccak256("unit-clock-short");
        uint64 tooShort = skill.MIN_CLOCK_BLOCKS() - 1;
        SkillSettle.SkillOpenTerms memory t = _termsFull(tid, 100, 2400, SkillPayouts.WORDLE_GAME_ID, tooShort, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(t);
        vm.prank(player);
        vm.expectRevert(SkillSettle.BadStatus.selector);
        skill.open(t, sig);
    }

    function test_open_rejects_clockBlocksTooLong() public {
        bytes32 tid = keccak256("unit-clock-long");
        uint64 tooLong = skill.MAX_CLOCK_BLOCKS() + 1;
        SkillSettle.SkillOpenTerms memory t = _termsFull(tid, 100, 2400, SkillPayouts.WORDLE_GAME_ID, tooLong, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(t);
        vm.prank(player);
        vm.expectRevert(SkillSettle.BadStatus.selector);
        skill.open(t, sig);
    }

    // ============================ BadStatus — duplicate open ========================================

    function test_open_rejects_duplicateTableId() public {
        bytes32 tid = keccak256("unit-dup");
        SkillSettle.SkillOpenTerms memory t = _wordleTerms(tid, 100, 2400);
        _open(t); // first open succeeds, table is now Live

        SkillSettle.SkillOpenTerms memory t2 = _wordleTerms(tid, 100, 2400); // same tableId
        bytes memory sig2 = _sign(t2);
        vm.prank(player);
        vm.expectRevert(SkillSettle.BadStatus.selector);
        skill.open(t2, sig2);
    }

    // ============================ BadStatus — settleWordle on a non-Live table ======================

    function test_settleWordle_rejects_unopenedTable() public {
        bytes32 tid = keccak256("unit-settle-unopened");
        vm.expectRevert(SkillSettle.BadStatus.selector);
        skill.settleWordle(tid, wProof, wordleGuessesUsed);
    }

    function test_settleWordle_rejects_alreadySettledTable() public {
        bytes32 tid = keccak256("unit-settle-twice");
        _open(_wordleTerms(tid, 100, 2400));
        skill.settleWordle(tid, wProof, wordleGuessesUsed); // first settle wins, table -> Settled

        vm.expectRevert(SkillSettle.BadStatus.selector);
        skill.settleWordle(tid, wProof, wordleGuessesUsed); // second settle on the same table
    }

    // ============================ BadStatus — reclaim on a non-Live table ===========================

    function test_reclaim_rejects_unopenedTable() public {
        bytes32 tid = keccak256("unit-reclaim-unopened");
        vm.expectRevert(SkillSettle.BadStatus.selector);
        skill.reclaim(tid);
    }

    function test_reclaim_rejects_alreadySettledTable() public {
        bytes32 tid = keccak256("unit-reclaim-twice");
        _open(_wordleTerms(tid, 100, 2400));
        skill.settleWordle(tid, wProof, wordleGuessesUsed); // wins -> Settled

        vm.expectRevert(SkillSettle.BadStatus.selector);
        skill.reclaim(tid); // reclaim on an already-Settled table
    }

    // ============================ BadGuesses ========================================================

    function test_settleWordle_rejects_guessesUsed_zero() public {
        bytes32 tid = keccak256("unit-guesses-zero");
        _open(_wordleTerms(tid, 100, 2400));
        vm.expectRevert(SkillSettle.BadGuesses.selector);
        skill.settleWordle(tid, wProof, 0);
    }

    function test_settleWordle_rejects_guessesUsed_tooHigh() public {
        bytes32 tid = keccak256("unit-guesses-high");
        _open(_wordleTerms(tid, 100, 2400));
        vm.expectRevert(SkillSettle.BadGuesses.selector);
        skill.settleWordle(tid, wProof, SkillPayouts.WORDLE_MAX_GUESSES + 1);
    }

    // ============================ permissionless settle: anyone (not the player) may call ===========

    function test_settleWordle_callableByNonPlayer() public {
        bytes32 tid = keccak256("unit-permissionless");
        _open(_wordleTerms(tid, 100, 2400));
        address rando = address(0xC0FFEE);
        vm.prank(rando);
        skill.settleWordle(tid, wProof, wordleGuessesUsed); // does not revert; permissionless by design
        assertEq(chips.balanceOf(player), 100_000 - 100 + 350, "player still gets paid though a stranger called settle");
    }

    // ============================ reclaim is also permissionless =====================================

    function test_reclaim_callableByNonPlayer() public {
        bytes32 tid = keccak256("unit-reclaim-permissionless");
        _open(_wordleTerms(tid, 100, 2400));
        vm.roll(block.number + CLOCK + 1);
        address rando = address(0xC0FFEE);
        vm.prank(rando);
        skill.reclaim(tid);
        assertEq(chips.balanceOf(player), 100_000 - 100, "player lost the stake to the house pool");
    }
}

/// ---------------------------------------------------------------------------------------------------
/// Uncoverable-branch note (kept out of the main suite so it reads as documentation, not a test):
///
/// `settleWordle`'s `if (t.gameId != SkillPayouts.WORDLE_GAME_ID) revert BadGame();` is dead code
/// through the public API. The ONLY way a table reaches `Status.Live` is `open` -> `_openTable`,
/// which computes `_maxMultX100(terms.gameId)` before ever writing `t.gameId` — and `_maxMultX100`
/// itself reverts BadGame for any gameId other than `SkillPayouts.WORDLE_GAME_ID`. So by construction
/// every Live table's `gameId` already equals `WORDLE_GAME_ID`, and `settleWordle`'s own re-check of
/// the same condition can never observe the `true` (revert) arm without directly manipulating storage
/// to force an inconsistent state that `open` itself could never produce. Left unexercised rather than
/// forced via `vm.store`, since doing so would test a state the contract cannot actually reach.
contract SkillSettleUnreachableBranchNotes {}

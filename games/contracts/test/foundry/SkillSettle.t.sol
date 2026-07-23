// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {SkillSettle} from "../../contracts/games/SkillSettle.sol";
import {SkillPayouts} from "../../contracts/games/SkillPayouts.sol";
import {WordleRules} from "../../contracts/zk/WordleRules.sol";
import {WordleCluePlonkVerifier} from "../../contracts/zk/generated/WordleCluePlonkVerifier.sol";
import {WordleSolvePlonkVerifier} from "../../contracts/zk/generated/WordleSolvePlonkVerifier.sol";

/// Thin harness exposing SkillPayouts' pure funcs so the foundry suite can assert TS↔Solidity parity
/// of the published payout curves directly (library internals aren't externally callable).
contract SkillPayoutsHarness {
    function wordleMultX100(uint256 g) external pure returns (uint256) { return SkillPayouts.wordleMultX100(g); }
    function payout(uint256 stake, uint256 m) external pure returns (uint256) { return SkillPayouts.payout(stake, m); }
    function isAllGreen(uint256[5] calldata c) external pure returns (bool) {
        uint256[5] memory m = c;
        return SkillPayouts.isAllGreen(m);
    }
}

/// M3: the on-chain SKILL settle, now WORDLE-ONLY. Wordle settles FULLY TRUSTLESSLY + permissionlessly
/// from a real wordle_solve PLONK proof that binds the committed guess SEQUENCE to a proven first
/// all-green position + a dictionary answer — so the happy-path Wordle solve→payout is exercised
/// end-to-end on-chain (no house co-signature). (Sudoku moved to the Chips-free SudokuLog timed
/// leaderboard; its tests live in SudokuLog.t.sol.)
contract SkillSettleTest is Test {
    Chips internal chips;
    SkillSettle internal skill;
    WordleRules internal wordleRules;
    SkillPayoutsHarness internal pay;

    uint256 internal pkHouse = 0xB0B;
    address internal house;
    address internal player = address(uint160(uint256(keccak256("skill-player"))));

    // wordle_solve fixture (4 signals: commit, guessesCommit, dictRoot, guessesUsed) — an ALL-GREEN
    // solve at guess #2 (→ 3.50x). The permissionless settle needs no house co-sign.
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
        pay = new SkillPayoutsHarness();

        house = vm.addr(pkHouse);
        skill.setHouseKey(house);

        chips.mint(address(this), 100_000);
        chips.approve(address(skill), type(uint256).max);
        skill.fundHouse(100_000);
        chips.mint(player, 10_000);
        vm.prank(player);
        chips.approve(address(skill), type(uint256).max);

        _loadWordle();

        skill.setWordleDictRoot(wordleDictRoot);
    }

    function _loadWordle() internal {
        string memory json = vm.readFile("test/foundry/fixtures/wordleSolveProof.json");
        uint256[] memory pf = vm.parseJsonUintArray(json, ".proof");
        uint256[] memory ps = vm.parseJsonUintArray(json, ".pubSignals");
        assertEq(pf.length, 24, "wordle_solve fixture must have 24 plonk proof fields");
        assertEq(ps.length, 4, "wordle_solve fixture must have 4 signals");
        for (uint256 i = 0; i < 24; i++) wProof[i] = pf[i];
        wordleCommit = ps[0];
        wordleGuessesCommit = ps[1];
        wordleDictRoot = ps[2];
        wordleGuessesUsed = ps[3];
    }

    // ---- open helpers ----------------------------------------------------------------------------

    function _wordleTerms(bytes32 tableId, uint256 stake, uint256 escrowHouse)
        internal view returns (SkillSettle.SkillOpenTerms memory t)
    {
        t.tableId = tableId;
        t.player = player;
        t.escrowPlayer = stake;
        t.escrowHouse = escrowHouse;
        t.gameId = SkillPayouts.WORDLE_GAME_ID;
        t.commit = wordleCommit;
        t.puzzleHash = bytes32(wordleGuessesCommit); // second commitment slot = guessesCommit for wordle
        t.clockBlocks = CLOCK;
        t.expiry = uint64(block.timestamp + 1 hours);
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

    // ============================ PARITY: on-chain curves == TS reference ==========================

    function test_wordlePayoutParity() public view {
        assertEq(pay.wordleMultX100(1), 2500);
        assertEq(pay.wordleMultX100(2), 350);
        assertEq(pay.wordleMultX100(3), 130);
        assertEq(pay.wordleMultX100(4), 80);
        assertEq(pay.wordleMultX100(5), 55);
        assertEq(pay.wordleMultX100(6), 25);
        assertEq(pay.wordleMultX100(0), 0); // out of range → miss
        assertEq(pay.wordleMultX100(7), 0);
    }

    function test_isAllGreen() public view {
        assertTrue(pay.isAllGreen([uint256(2), 2, 2, 2, 2]));
        assertFalse(pay.isAllGreen([uint256(2), 2, 1, 2, 2]));
        assertFalse(pay.isAllGreen([uint256(0), 0, 0, 0, 0]));
    }

    // ============================ escrow ceiling (funds-safety) ====================================

    function test_open_rejects_escrowHouse_below_ceiling() public {
        bytes32 tid = keccak256("thin-escrow");
        // wordle profit ceiling for stake 100 is stake*(25-1) = 2400; 2399 must be rejected.
        SkillSettle.SkillOpenTerms memory t = _wordleTerms(tid, 100, 2399);
        bytes memory sig = _sign(t);
        vm.prank(player);
        vm.expectRevert(SkillSettle.EscrowTooSmall.selector);
        skill.open(t, sig);
    }

    function test_open_rejects_forgedHouseSig() public {
        bytes32 tid = keccak256("forged");
        SkillSettle.SkillOpenTerms memory t = _wordleTerms(tid, 100, 2400);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBADBAD), skill.openDigest(t));
        vm.prank(player);
        vm.expectRevert(SkillSettle.BadSig.selector);
        skill.open(t, abi.encodePacked(r, s, v));
    }

    // ==================== WORDLE — full trustless permissionless round (M3) ========================

    function test_wordle_fullRound_realProof_pays3_50x() public {
        bytes32 tid = keccak256("wordle-win");
        uint256 stake = 100;
        uint256 escrowHouse = 2400; // ceiling: profit at solve-in-1 = stake*(25-1) = 2400
        _open(_wordleTerms(tid, stake, escrowHouse));

        assertEq(chips.balanceOf(player), 10_000 - stake, "stake escrowed");
        assertEq(skill.housePool(), 100_000 - escrowHouse, "house escrow reserved");
        assertEq(wordleGuessesUsed, 2, "fixture solves at guess 2");

        // ANYONE submits the real wordle_solve proof — no house co-signature, no house involvement.
        // guessesUsed=2 is forced by the proof; the payout is 3.50x.
        vm.prank(player);
        skill.settleWordle(tid, wProof, wordleGuessesUsed);

        // payout = stake * 3.50 = 350; player net +250
        assertEq(chips.balanceOf(player), 10_000 - stake + 350, "player paid 3.50x");
        assertEq(skill.housePool(), 100_000 - 250, "house pool down exactly the profit");
    }

    // Understate guesses-used to grab the 25x solve-in-1 multiplier: the public signal no longer
    // matches the proof (which proves first-solve at guess 2) → PLONK verify fails. This is the
    // whole point of the M3 sequence binding — permissionless settle cannot be gamed.
    function test_wordle_understatedGuesses_failsClosed() public {
        bytes32 tid = keccak256("wordle-understate");
        _open(_wordleTerms(tid, 100, 2400));
        vm.prank(player);
        vm.expectRevert(SkillSettle.BadProof.selector);
        skill.settleWordle(tid, wProof, 1); // claim solve-in-1 with a solve-in-2 proof
    }

    function test_wordle_tamperedProof_failsClosed() public {
        bytes32 tid = keccak256("wordle-tamper");
        _open(_wordleTerms(tid, 100, 2400));
        uint256[24] memory badProof = wProof;
        badProof[0] = wProof[0] ^ 0xff;
        vm.prank(player);
        vm.expectRevert(SkillSettle.BadProof.selector);
        skill.settleWordle(tid, badProof, wordleGuessesUsed);
    }

    // A proof against a DIFFERENT dictionary root than the one committed on-chain fails: swapping the
    // owner-set root out from under a live table invalidates the answer's membership.
    function test_wordle_wrongDictRoot_failsClosed() public {
        bytes32 tid = keccak256("wordle-dict");
        _open(_wordleTerms(tid, 100, 2400));
        skill.setWordleDictRoot(wordleDictRoot + 1);
        vm.prank(player);
        vm.expectRevert(SkillSettle.BadProof.selector);
        skill.settleWordle(tid, wProof, wordleGuessesUsed);
    }

    function test_wordle_reclaimAfterDeadline_houseKeepsStake() public {
        bytes32 tid = keccak256("wordle-loss");
        _open(_wordleTerms(tid, 100, 2400));
        vm.expectRevert(SkillSettle.DeadlineNotPassed.selector);
        skill.reclaim(tid);
        vm.roll(block.number + CLOCK + 1);
        skill.reclaim(tid);
        assertEq(chips.balanceOf(player), 10_000 - 100, "player loses the stake");
        assertEq(skill.housePool(), 100_000 + 100, "house keeps the lost stake");
    }
}

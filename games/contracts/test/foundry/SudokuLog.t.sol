// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SudokuLog} from "../../contracts/games/SudokuLog.sol";
import {SudokuRules} from "../../contracts/zk/SudokuRules.sol";
import {SudokuSolvePlonkVerifier} from "../../contracts/zk/generated/SudokuSolvePlonkVerifier.sol";

/// The Chips-free ZK-Sudoku TIMED LEADERBOARD. Sudoku is no longer a wagered game (a flat-multiplier
/// bet on a public, trivially-automatable solve is strictly -EV and unable to tell a human from a bot);
/// it is a speedrun with a cryptographic finish line. SudokuLog logs, fully on-chain and trustlessly,
/// WHO solved a published puzzle and HOW LONG it took — no escrow, no payout.
///
/// It reuses the EXISTING SudokuRules verifier wrapper untouched. Fixture loading mirrors
/// SudokuRules.t.sol / SkillSettle.t.sol: the 81 unpacked cells come from `.vector.puzzle`, and the
/// packed public signals are [nullifier, puzzlePacked[0], puzzlePacked[1], player] (ps[0]=nullifier,
/// ps[3]=player). The proof is bound to the fixed fixture player 0xabab..ab.
contract SudokuLogTest is Test {
    SudokuRules internal rules;
    SudokuLog internal sudokuLog;

    uint256[24] internal sProof;
    uint256[81] internal puzzle;
    uint256 internal nullifier;
    uint256 internal player; // the fixture's public `player` signal (the proof is bound to it)

    uint256 internal constant PUZZLE_ID = 42;

    // Re-declared here so vm.expectEmit can match on the event signature.
    event PuzzleOpened(uint256 indexed puzzleId, uint256 openedAt);
    event Solved(
        uint256 indexed puzzleId,
        uint256 indexed player,
        uint256 nullifier,
        uint256 solvedAt,
        uint256 elapsed
    );

    function setUp() public {
        rules = new SudokuRules(address(new SudokuSolvePlonkVerifier()));
        sudokuLog = new SudokuLog(address(rules));

        string memory json = vm.readFile("test/foundry/fixtures/sudokuSolveProof.json");
        uint256[] memory pf = vm.parseJsonUintArray(json, ".proof");
        uint256[] memory ps = vm.parseJsonUintArray(json, ".pubSignals");
        assertEq(pf.length, 24, "sudoku fixture must have 24 plonk proof fields");
        assertEq(ps.length, 4, "sudoku fixture must have 4 signals");
        for (uint256 i = 0; i < 24; i++) sProof[i] = pf[i];
        nullifier = ps[0];
        player = ps[3];
        uint256[] memory cells = vm.parseJsonUintArray(json, ".vector.puzzle");
        assertEq(cells.length, 81, "sudoku fixture vector.puzzle must have 81 cells");
        for (uint256 i = 0; i < 81; i++) puzzle[i] = cells[i];
    }

    // ---- positive ---------------------------------------------------------------------------------

    function test_openThenLogSolve_emitsSolvedWithElapsed() public {
        vm.warp(1_000_000);
        vm.expectEmit(true, false, false, true, address(sudokuLog));
        emit PuzzleOpened(PUZZLE_ID, 1_000_000);
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);

        (bytes32 storedHash, uint256 openedAt) = sudokuLog.puzzles(PUZZLE_ID);
        assertEq(storedHash, keccak256(abi.encode(puzzle)), "puzzle hash stored");
        assertEq(openedAt, 1_000_000, "openedAt stamped");

        // advance time so the solve time is non-trivial and deterministic
        uint256 elapsed = 137;
        vm.warp(1_000_000 + elapsed);

        // ANYONE may relay the real proof (permissionless); the entry credits the bound player.
        vm.expectEmit(true, true, false, true, address(sudokuLog));
        emit Solved(PUZZLE_ID, player, nullifier, 1_000_000 + elapsed, elapsed);
        vm.prank(address(0xBEEF)); // a stranger relays — front-run resistance
        sudokuLog.logSolve(PUZZLE_ID, sProof, puzzle, player, nullifier);

        assertTrue(sudokuLog.spentNullifier(nullifier), "nullifier recorded spent");
    }

    // ---- negatives --------------------------------------------------------------------------------

    function test_logSolve_beforeOpen_reverts() public {
        vm.expectRevert(SudokuLog.NotOpened.selector);
        sudokuLog.logSolve(PUZZLE_ID, sProof, puzzle, player, nullifier);
    }

    function test_logSolve_puzzleMismatch_reverts() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        uint256[81] memory badPuzzle = puzzle;
        badPuzzle[0] = puzzle[0] == 9 ? 8 : 9; // a different board than the one opened
        vm.expectRevert(SudokuLog.BadPuzzle.selector);
        sudokuLog.logSolve(PUZZLE_ID, sProof, badPuzzle, player, nullifier);
    }

    function test_logSolve_nullifierReplay_reverts() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        // a second puzzle id with the SAME board → same solve proof/nullifier
        uint256 otherId = PUZZLE_ID + 1;
        sudokuLog.openPuzzle(otherId, puzzle);
        sudokuLog.logSolve(PUZZLE_ID, sProof, puzzle, player, nullifier);
        vm.expectRevert(SudokuLog.NullifierSpent.selector);
        sudokuLog.logSolve(otherId, sProof, puzzle, player, nullifier);
    }

    function test_logSolve_tamperedProof_reverts() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        uint256[24] memory badProof = sProof;
        badProof[0] = sProof[0] ^ 0xff;
        vm.expectRevert(SudokuLog.BadProof.selector);
        sudokuLog.logSolve(PUZZLE_ID, badProof, puzzle, player, nullifier);
    }

    function test_logSolve_wrongPlayerBinding_reverts() public {
        // The proof is bound to `player`; passing a different player fails the PLONK verify. This is
        // the anti-front-run binding: a copied proof cannot be re-aimed at another address.
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        vm.expectRevert(SudokuLog.BadProof.selector);
        sudokuLog.logSolve(PUZZLE_ID, sProof, puzzle, player + 1, nullifier);
    }

    function test_openPuzzle_nonOwner_reverts() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(); // Solady Ownable.Unauthorized()
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
    }

    function test_openPuzzle_twice_reverts() public {
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
        vm.expectRevert(SudokuLog.AlreadyOpened.selector);
        sudokuLog.openPuzzle(PUZZLE_ID, puzzle);
    }
}

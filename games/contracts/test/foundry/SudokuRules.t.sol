// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SudokuRules} from "../../contracts/zk/SudokuRules.sol";
import {SudokuSolvePlonkVerifier} from "../../contracts/zk/generated/SudokuSolvePlonkVerifier.sol";

/// On-chain PLONK verification of the ZK-Sudoku skill circuit (M3 role-flip). Deploys the generated
/// SudokuSolvePlonkVerifier + the SudokuRules wrapper, then feeds a REAL proof fixture produced by
/// examples/games/zk-skill/scripts/genProofFixtures.ts (the band-rotation solution/puzzle vector the
/// vitest suite uses, bound to a fixed fixture player 0xabab..ab).
///
/// The verifier and the fixture are exported from the SAME zkey in one pass by that script — a desync
/// there is silent and is exactly what broke M1.
///
/// Public-signal order (asserted here, enforced by SudokuRules.checkSolve's packing):
///   circuits/sudoku_solve.circom  `component main {public [puzzlePacked, player]}` + `signal output nullifier`
///   snarkjs emits outputs first => pub = [nullifier, puzzlePacked[0], puzzlePacked[1], player]  (4 signals).
///
/// The 81-cell puzzle is PACKED into 2 field elements (4 bits/cell) because a PLONK zkey stores one
/// Lagrange polynomial per PUBLIC input — at 83 signals the proving key was 960 MB (vs 66 MB packed),
/// unshippable to the browser where the PLAYER must prove. So the puzzle is no longer readable
/// straight off `pubSignals`: the 81 cells come from the fixture's `vector.puzzle`, and
/// test_packPuzzle_matchesTheCircuitsPublicSignals below pins the on-chain packing to the packed
/// signals the circuit actually proved over.
contract SudokuRulesTest is Test {
    SudokuRules internal rules;

    uint256[24] internal proof;
    uint256[4] internal pub;

    uint256[81] internal puzzle;
    uint256 internal player;
    uint256 internal nullifier;

    function setUp() public {
        SudokuSolvePlonkVerifier verifier = new SudokuSolvePlonkVerifier();
        rules = new SudokuRules(address(verifier));

        string memory json = vm.readFile("test/foundry/fixtures/sudokuSolveProof.json");
        uint256[] memory pf = vm.parseJsonUintArray(json, ".proof");
        uint256[] memory ps = vm.parseJsonUintArray(json, ".pubSignals");
        assertEq(pf.length, 24, "fixture must have 24 plonk proof fields");
        assertEq(ps.length, 4, "fixture must have 4 public signals");

        for (uint256 i = 0; i < 24; i++) proof[i] = pf[i];
        for (uint256 i = 0; i < 4; i++) pub[i] = ps[i];

        // Decompose: [nullifier, puzzlePacked[0], puzzlePacked[1], player].
        nullifier = ps[0];
        player = ps[3];

        // The unpacked 81 cells live in the fixture's vector, not in pubSignals.
        uint256[] memory cells = vm.parseJsonUintArray(json, ".vector.puzzle");
        assertEq(cells.length, 81, "fixture vector.puzzle must have 81 cells");
        for (uint256 i = 0; i < 81; i++) puzzle[i] = cells[i];
    }

    /// THE packing-parity guard. The circuit proved over pub[1..2]; SudokuRules packs the same 81
    /// cells on-chain. If those two ever disagree — a different split, endianness, or bit width —
    /// every proof silently stops verifying (or, far worse, a DIFFERENT puzzle verifies). This
    /// asserts the on-chain packer reproduces the exact field elements the circuit was proved over.
    function test_packPuzzle_matchesTheCircuitsPublicSignals() public view {
        (uint256 lo, uint256 hi) = rules.packPuzzle(puzzle);
        assertEq(lo, pub[1], "on-chain packing != puzzlePacked[0] the circuit proved over");
        assertEq(hi, pub[2], "on-chain packing != puzzlePacked[1] the circuit proved over");
    }

    /// The packing must be injective over the legal cell range: changing any ONE cell must change
    /// the packed words. A silent collision here would let a different puzzle reuse a proof.
    function test_packPuzzle_isSensitiveToEveryCell() public view {
        (uint256 lo0, uint256 hi0) = rules.packPuzzle(puzzle);
        for (uint256 i = 0; i < 81; i++) {
            uint256[81] memory p = puzzle;
            p[i] = p[i] == 9 ? 8 : p[i] + 1; // stay inside [0,9]
            (uint256 lo, uint256 hi) = rules.packPuzzle(p);
            assertTrue(lo != lo0 || hi != hi0, string.concat("cell ", vm.toString(i), " does not affect the packing"));
        }
    }

    /// A cell >= 16 would overflow its 4-bit slot and corrupt its neighbour, so the packer rejects
    /// anything above 9 rather than silently mis-encoding it.
    function test_packPuzzle_rejectsOutOfRangeCell() public {
        uint256[81] memory p = puzzle;
        p[5] = 10;
        vm.expectRevert(bytes("SudokuRules: cell > 9"));
        rules.packPuzzle(p);
    }

    // --- positive: a real proof verifies through both entrypoints ---
    function test_verifySolve_realProof() public view {
        assertTrue(rules.verifySolve(proof, pub), "verifySolve rejected a valid proof");
    }

    function test_checkSolve_realProof() public view {
        assertTrue(rules.checkSolve(proof, puzzle, player, nullifier), "checkSolve rejected a valid proof");
    }

    // --- the typed helper packs pub in the SAME order the raw path expects ---
    function test_checkSolve_matches_verifySolve_packing() public view {
        assertEq(
            rules.checkSolve(proof, puzzle, player, nullifier),
            rules.verifySolve(proof, pub),
            "checkSolve and verifySolve disagree - packing order mismatch"
        );
    }

    // --- negative: flip one byte of the proof (A.x) => PLONK verify fails, fail-closed ---
    function test_tamperedProof_failsClosed() public view {
        uint256[24] memory badProof = proof;
        badProof[0] = proof[0] ^ 0xff;
        assertFalse(rules.verifySolve(badProof, pub), "tampered proof must not verify");
    }

    // --- negative: valid proof but a MISMATCHED public input (wrong puzzle clue) => fails ---
    function test_wrongPuzzle_failsClosed() public view {
        uint256[81] memory badPuzzle = puzzle;
        // puzzle[0] is a revealed clue (value 1); change it to a different digit the proof
        // was NOT made for.
        badPuzzle[0] = puzzle[0] == 9 ? 8 : 9;
        assertFalse(rules.checkSolve(proof, badPuzzle, player, nullifier), "mismatched puzzle must not verify");
    }

    // --- negative: wrong player binding (the anti-front-run binding) => fails ---
    function test_wrongPlayer_failsClosed() public view {
        assertFalse(rules.checkSolve(proof, puzzle, player + 1, nullifier), "mismatched player must not verify");
    }

    // --- negative: wrong nullifier (the solution binding) => fails ---
    function test_wrongNullifier_failsClosed() public view {
        assertFalse(rules.checkSolve(proof, puzzle, player, nullifier + 1), "mismatched nullifier must not verify");
    }
}

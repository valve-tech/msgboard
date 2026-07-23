// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SudokuSolvePlonkVerifier} from "../../contracts/zk/generated/SudokuSolvePlonkVerifier.sol";
import {WordleCluePlonkVerifier} from "../../contracts/zk/generated/WordleCluePlonkVerifier.sol";
import {WordleSolvePlonkVerifier} from "../../contracts/zk/generated/WordleSolvePlonkVerifier.sol";

/// EXHAUSTIVE fail-closed coverage for the three ZK-skill PLONK verifiers, against the same committed
/// fixtures the functional suites use.
///
/// WHY THIS EXISTS (what the per-circuit suites do NOT cover): those suites tamper a single proof word
/// (`proof[0]`) and perturb a handful of public signals. That is a real check, but it leaves two gaps
/// that matter for a house-draining forgery:
///
///   1. `proof[0]` is the x-coord of commitment A, so mutating it trips the verifier's CHEAP
///      on-curve precheck (`checkPointBelongsToBN128Curve`) and returns false without the pairing ever
///      running. A verifier that ignored a later word — or whose pairing was broken outright — would
///      still pass that test. The generated verifier's layout is:
///        proof[0..17]  = 9 commitment points (A, B, C, Z, T1, T2, T3, Wxi, Wxiw) as (x, y) pairs
///                        -> guarded by the on-curve precheck
///        proof[18..23] = the field evaluations (eval_a, eval_b, eval_c, eval_s1, eval_s2, eval_zw)
///                        -> only range-checked; a mutation here is caught ONLY by the pairing, i.e.
///                           the actual SOUNDNESS path.
///      So the tests below mutate EVERY word, which forces the soundness path for 18..23 and proves
///      no word is ignored.
///   2. Only a few public signals were perturbed. Sudoku binds 83 of them (81 puzzle cells +
///      nullifier + player); if any single cell were unconstrained, a player could swap that cell for
///      an easier board. The tests below perturb EVERY signal of every circuit, which is the
///      packing-order/binding discipline verified empirically rather than by reading the code.
///
/// Plus a PLONK-specific risk the groth16 suites never had to think about: every PLONK proof is the
/// same `uint256[24]` shape regardless of circuit, so a proof from one circuit is TYPE-COMPATIBLE with
/// another circuit's verifier. Cross-feeding must fail — see the cross-circuit tests.
contract PlonkSoundnessTest is Test {
    SudokuSolvePlonkVerifier internal sudoku;
    WordleCluePlonkVerifier internal wordleClue;
    WordleSolvePlonkVerifier internal wordleSolve;

    uint256[24] internal sudokuProof;
    uint256[4] internal sudokuPub;

    uint256[24] internal clueProof;
    uint256[11] internal cluePub;

    uint256[24] internal solveProof;
    uint256[4] internal solvePub;

    /// BN254 scalar field modulus (`q` in the generated verifier) — the bound `checkField` enforces.
    uint256 internal constant Q =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// Index of the first field EVALUATION in the proof; words below this are curve-point coords.
    uint256 internal constant FIRST_EVAL = 18;

    function setUp() public {
        sudoku = new SudokuSolvePlonkVerifier();
        wordleClue = new WordleCluePlonkVerifier();
        wordleSolve = new WordleSolvePlonkVerifier();

        uint256[] memory ps;

        ps = _loadProof("test/foundry/fixtures/sudokuSolveProof.json", sudokuProof);
        assertEq(ps.length, 4, "sudoku_solve: expected 4 public signals");
        for (uint256 i = 0; i < 4; i++) sudokuPub[i] = ps[i];

        ps = _loadProof("test/foundry/fixtures/wordleClueProof.json", clueProof);
        assertEq(ps.length, 11, "wordle_clue: expected 11 public signals");
        for (uint256 i = 0; i < 11; i++) cluePub[i] = ps[i];

        ps = _loadProof("test/foundry/fixtures/wordleSolveProof.json", solveProof);
        assertEq(ps.length, 4, "wordle_solve: expected 4 public signals");
        for (uint256 i = 0; i < 4; i++) solvePub[i] = ps[i];
    }

    function _loadProof(string memory path, uint256[24] storage proof) internal returns (uint256[] memory) {
        string memory json = vm.readFile(path);
        uint256[] memory pf = vm.parseJsonUintArray(json, ".proof");
        assertEq(pf.length, 24, "expected 24 plonk proof fields");
        for (uint256 i = 0; i < 24; i++) proof[i] = pf[i];
        return vm.parseJsonUintArray(json, ".pubSignals");
    }

    // ================== baseline: the untouched fixtures verify (guards against vacuity) ==========
    // Every negative below is a mutation of these. If a fixture did NOT verify to begin with, every
    // "must not verify" assertion would pass for the wrong reason and this whole file would be inert.

    function test_baseline_allThreeFixturesVerify() public view {
        assertTrue(sudoku.verifyProof(sudokuProof, sudokuPub), "sudoku_solve fixture must verify");
        assertTrue(wordleClue.verifyProof(clueProof, cluePub), "wordle_clue fixture must verify");
        assertTrue(wordleSolve.verifyProof(solveProof, solvePub), "wordle_solve fixture must verify");
    }

    // ================== every proof word is load-bearing ==========================================
    // Flip the low bit of each of the 24 words in turn; each mutation alone must break the proof.
    // Words 18..23 are evaluations: they pass the on-curve/range prechecks, so only the pairing can
    // reject them — these cases exercise the real soundness path.

    function test_everyProofWord_isLoadBearing_sudokuSolve() public view {
        for (uint256 i = 0; i < 24; i++) {
            uint256[24] memory bad = sudokuProof;
            bad[i] = bad[i] ^ 1;
            assertFalse(
                sudoku.verifyProof(bad, sudokuPub),
                string.concat("sudoku_solve: mutating proof word ", vm.toString(i), " still verified")
            );
        }
    }

    function test_everyProofWord_isLoadBearing_wordleClue() public view {
        for (uint256 i = 0; i < 24; i++) {
            uint256[24] memory bad = clueProof;
            bad[i] = bad[i] ^ 1;
            assertFalse(
                wordleClue.verifyProof(bad, cluePub),
                string.concat("wordle_clue: mutating proof word ", vm.toString(i), " still verified")
            );
        }
    }

    function test_everyProofWord_isLoadBearing_wordleSolve() public view {
        for (uint256 i = 0; i < 24; i++) {
            uint256[24] memory bad = solveProof;
            bad[i] = bad[i] ^ 1;
            assertFalse(
                wordleSolve.verifyProof(bad, solvePub),
                string.concat("wordle_solve: mutating proof word ", vm.toString(i), " still verified")
            );
        }
    }

    /// Explicitly pin the SOUNDNESS path: mutate only the evaluations (18..23), which are structurally
    /// valid field elements and therefore survive every cheap precheck. If the pairing check were
    /// broken or omitted, this is the test that would notice — the `proof[0]` tamper tests would not.
    function test_evaluationTamper_isCaughtByThePairing_notThePrechecks() public view {
        for (uint256 i = FIRST_EVAL; i < 24; i++) {
            uint256[24] memory bad = solveProof;
            bad[i] = bad[i] ^ 1;
            // still a valid field element => prechecks pass => only the pairing can reject it
            assertLt(bad[i], Q, "mutated evaluation should remain in-field");
            assertFalse(
                wordleSolve.verifyProof(bad, solvePub),
                string.concat("wordle_solve: tampered evaluation ", vm.toString(i), " still verified")
            );
        }
    }

    // ================== every public signal is bound ==============================================
    // Perturb each public signal in turn; each alone must break the proof. For sudoku this is the
    // strong claim: all 81 puzzle cells are constrained, so no cell can be swapped for an easier one.

    /// NOTE sudoku's puzzle is PACKED into pub[1..2] (4 bits/cell), so perturbing those two signals
    /// is what proves all 81 cells are bound — SudokuRules.t.sol's packing-parity + per-cell
    /// sensitivity tests carry that back to the individual cells.
    function test_everyPublicSignal_isBound_sudokuSolve() public view {
        for (uint256 i = 0; i < 4; i++) {
            uint256[4] memory bad = sudokuPub;
            bad[i] = bad[i] + 1;
            assertFalse(
                sudoku.verifyProof(sudokuProof, bad),
                string.concat("sudoku_solve: public signal ", vm.toString(i), " is NOT bound")
            );
        }
    }

    function test_everyPublicSignal_isBound_wordleClue() public view {
        for (uint256 i = 0; i < 11; i++) {
            uint256[11] memory bad = cluePub;
            bad[i] = bad[i] + 1;
            assertFalse(
                wordleClue.verifyProof(clueProof, bad),
                string.concat("wordle_clue: public signal ", vm.toString(i), " is NOT bound")
            );
        }
    }

    function test_everyPublicSignal_isBound_wordleSolve() public view {
        for (uint256 i = 0; i < 4; i++) {
            uint256[4] memory bad = solvePub;
            bad[i] = bad[i] + 1;
            assertFalse(
                wordleSolve.verifyProof(solveProof, bad),
                string.concat("wordle_solve: public signal ", vm.toString(i), " is NOT bound")
            );
        }
    }

    // ================== cross-circuit proof confusion =============================================
    // Every PLONK proof is uint256[24] regardless of circuit, so a proof for circuit A is
    // TYPE-COMPATIBLE with circuit B's verifier. Each verifier embeds its own circuit's verifying key,
    // so a foreign proof must be rejected — otherwise a cheap circuit's proof could settle an
    // expensive one.

    function test_crossCircuit_wordleSolveProof_rejectedBy_wordleClueVerifier() public view {
        assertFalse(
            wordleClue.verifyProof(solveProof, cluePub),
            "a wordle_solve proof must not verify on the wordle_clue verifier"
        );
    }

    function test_crossCircuit_wordleClueProof_rejectedBy_wordleSolveVerifier() public view {
        assertFalse(
            wordleSolve.verifyProof(clueProof, solvePub),
            "a wordle_clue proof must not verify on the wordle_solve verifier"
        );
    }

    function test_crossCircuit_sudokuProof_rejectedBy_wordleClueVerifier() public view {
        assertFalse(
            wordleClue.verifyProof(sudokuProof, cluePub),
            "a sudoku_solve proof must not verify on the wordle_clue verifier"
        );
    }

    function test_crossCircuit_wordleClueProof_rejectedBy_sudokuVerifier() public view {
        assertFalse(
            sudoku.verifyProof(clueProof, sudokuPub),
            "a wordle_clue proof must not verify on the sudoku_solve verifier"
        );
    }

    // ================== malformed / out-of-field input ============================================

    /// An evaluation at or above the scalar field modulus must be rejected by `checkField` rather than
    /// wrapping into a valid-looking element.
    function test_outOfFieldEvaluation_rejected() public view {
        uint256[24] memory bad = solveProof;
        bad[FIRST_EVAL] = Q; // exactly the modulus — the first invalid value
        assertFalse(wordleSolve.verifyProof(bad, solvePub), "evaluation == q must be rejected");

        bad[FIRST_EVAL] = type(uint256).max;
        assertFalse(wordleSolve.verifyProof(bad, solvePub), "evaluation == 2^256-1 must be rejected");
    }

    /// An all-zero proof is the trivial forgery attempt; the point (0,0) is not on the curve.
    function test_zeroProof_rejected() public view {
        uint256[24] memory zero;
        assertFalse(wordleSolve.verifyProof(zero, solvePub), "an all-zero proof must not verify");
        assertFalse(wordleClue.verifyProof(zero, cluePub), "an all-zero proof must not verify");
        assertFalse(sudoku.verifyProof(zero, sudokuPub), "an all-zero proof must not verify");
    }

    /// Reusing a valid proof against ALL-ZERO public signals must fail — i.e. the public inputs really
    /// are part of the verified statement, not decoration.
    function test_zeroPublicSignals_rejected() public view {
        uint256[4] memory zero4;
        assertFalse(wordleSolve.verifyProof(solveProof, zero4), "zeroed public signals must not verify");
        uint256[4] memory zero4b;
        assertFalse(sudoku.verifyProof(sudokuProof, zero4b), "zeroed public signals must not verify");
    }
}

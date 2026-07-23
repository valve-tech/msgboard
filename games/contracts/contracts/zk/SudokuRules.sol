// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SudokuSolvePlonkVerifier} from "./generated/SudokuSolvePlonkVerifier.sol";

/// On-chain PLONK verification for the ZK-Sudoku skill game (M3 "role-flip"). This is
/// NOT an IGameRules implementation — that interface is for turn-based channel games
/// (ZkTable disputes) and does not fit a single-shot skill-game proof.
///
/// Proves: the prover knows a VALID solution to a committed public `puzzle`
/// (rows/columns/3x3 boxes each a permutation of 1..9, agreeing with every non-blank
/// puzzle clue), WITHOUT revealing the solution. The proof no longer references any
/// house secret (M2's `Poseidon(solution‖salt)==commit` was unprovable for the player
/// and house-griefable); instead it is bound to a public `player` via a `nullifier`,
/// so a mempool watcher cannot replay/front-run a solve in a timed race.
///
/// CONSUMER: this wrapper is used by SudokuLog (contracts/games/SudokuLog.sol), the Chips-free
/// timed leaderboard — Sudoku is a speedrun with a cryptographic finish line, not a wagered game.
/// (It is intentionally NOT wired into SkillSettle: a flat-multiplier bet on a public,
/// trivially-automatable solve is strictly -EV for the house, and the proof cannot distinguish a
/// fast human from a bot. See SudokuLog's header.)
///
/// nullifier = Poseidon(rowDigest[0..8], player), rowDigest[r] = Poseidon(solution row r).
///
/// PROOF SYSTEM: PLONK over the universal Hermez ptau. PLONK has NO per-circuit trusted
/// setup, so a circuit change no longer requires a phase-2 ceremony (the groth16 zkeys this
/// replaced had ZERO contributions, i.e. were forgeable). It is also ~59% CHEAPER to verify
/// (~305k vs 743,449 gas measured on the pre-packing 83-signal circuit): groth16 costs one EC
/// scalar-mul (~6k gas) per public input, whereas PLONK evaluates public inputs in the field.
/// See test/foundry/ProofSystemGas.t.sol for the live numbers + the measurement method.
///
/// THE PUZZLE IS PACKED into 2 field elements (4 bits per cell) rather than passed as 81
/// separate public signals. That is a PROVING-side requirement, not an on-chain one: a PLONK
/// zkey stores one Lagrange polynomial per PUBLIC input (5n field elements each), so at 83
/// signals the sudoku proving key was 960 MB — 90.7% of it that one section — which cannot be
/// shipped to a browser. Browser proving is mandatory here because the PLAYER is the one who
/// knows the solution. Packed, the key is 66 MB. It is cheaper on-chain too: 79 fewer calldata
/// words (~40k gas) per settle.
///
/// Callers are UNAFFECTED — `checkSolve` still takes the puzzle as 81 plain cells and packs it
/// here, so SkillSettle never handles the encoding. `_packPuzzle` must stay bit-for-bit
/// identical to circuits/sudoku_solve.circom's Num2Bits unpacking and to packPuzzle() in
/// examples/games/zk-skill/src/sudoku.ts; a packing-parity test pins all three together.
///
/// Public-signal ORDER (snarkjs emits OUTPUTS first, then public inputs in declaration
/// order) — must match the circuit's `main` declaration exactly:
///   circuits/sudoku_solve.circom
///     component main {public [puzzlePacked, player]} = SudokuSolve()  with `signal output nullifier`
///   => pub = [nullifier, puzzlePacked[0], puzzlePacked[1], player]  (4 signals).
contract SudokuRules {
    SudokuSolvePlonkVerifier public immutable verifier;

    /// Cells 0..62 pack into word 0 (63 x 4 = 252 bits); cells 63..80 into word 1 (18 x 4 = 72).
    /// 252 < 254, so each word is a valid BN254 field element and the circuit's non-strict
    /// Num2Bits decomposition of it is sound (no field wraparound).
    uint256 private constant PACK_SPLIT = 63;

    constructor(address verifier_) {
        verifier = SudokuSolvePlonkVerifier(verifier_);
    }

    /// Pack 81 cells (each 0..9) into 2 field elements, 4 bits per cell, little-endian by cell
    /// index — the exact inverse of the circuit's unpacking. Reverts on an out-of-range cell:
    /// a cell >= 16 would silently corrupt its neighbour's bits, so this is a real encoding
    /// guard, not a redundant range check.
    function _packPuzzle(uint256[81] calldata puzzle) internal pure returns (uint256 lo, uint256 hi) {
        for (uint256 i = 0; i < 81; i++) {
            uint256 cell = puzzle[i];
            require(cell <= 9, "SudokuRules: cell > 9");
            if (i < PACK_SPLIT) {
                lo |= cell << (4 * i);
            } else {
                hi |= cell << (4 * (i - PACK_SPLIT));
            }
        }
    }

    /// Exposed so tests (and off-chain callers) can pin the on-chain packing against the
    /// circuit's and the TS mirror's without reaching through `checkSolve`.
    function packPuzzle(uint256[81] calldata puzzle) external pure returns (uint256 lo, uint256 hi) {
        return _packPuzzle(puzzle);
    }

    /// Raw verify: caller supplies `pub` already packed in circuit order. Prefer
    /// `checkSolve` below unless the packed array is already on hand (e.g. read
    /// verbatim from an off-chain fixture) — packing it by hand here is exactly the
    /// mistake `checkSolve` exists to prevent.
    function verifySolve(uint256[24] calldata proof, uint256[4] calldata pub) public view returns (bool) {
        return verifier.verifyProof(proof, pub);
    }

    /// Typed helper: packs the puzzle and lays `pub` out in the circuit's exact public-signal
    /// order [nullifier, puzzlePacked[0], puzzlePacked[1], player] so callers cannot misorder
    /// it. The proof verifies only for the exact (puzzle, player, nullifier) triple it was made
    /// for, so passing the table's `player` binds the proof to that player.
    function checkSolve(
        uint256[24] calldata proof,
        uint256[81] calldata puzzle,
        uint256 player,
        uint256 nullifier
    ) external view returns (bool) {
        (uint256 lo, uint256 hi) = _packPuzzle(puzzle);
        uint256[4] memory pub;
        pub[0] = nullifier;
        pub[1] = lo;
        pub[2] = hi;
        pub[3] = player;
        return verifier.verifyProof(proof, pub);
    }
}

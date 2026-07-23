// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// Pure on-chain reproduction of the ZK skill games' PUBLISHED payout curves — the proof-driven
/// analog of GamePayouts (which mirrors the RNG games). Mirrors, bit-for-bit:
///   examples/games/msgboard-games/src/games/wordle.ts  (WORDLE_MULT_X100 by guesses-used)
/// Parity with the TS reference is pinned by test/foundry/SkillSettle.t.sol.
///
/// Covers ONLY Wordle: Sudoku is no longer a wagered game (it moved to the Chips-free SudokuLog timed
/// leaderboard — no payout curve), so its flat multiplier was removed from here.
///
/// Unlike GamePayouts these take no round-random `r`: a skill game's payout is a function of the
/// VERIFIED result (Wordle: guesses used to reach all-green), which the caller establishes with a
/// PLONK proof before trusting this math with chips.
library SkillPayouts {
    uint256 internal constant HUNDREDTHS = 100; // 1.00x == 100

    // --- ZK-Wordle (gameId 30) — mirror WORDLE_MULT_X100 ---
    uint8 internal constant WORDLE_GAME_ID = 30;
    uint256 internal constant WORDLE_MAX_GUESSES = 6;

    /// Wordle payout multiplier (×100) by guesses-used [1..6]; 0 for a miss or out-of-range. Fast
    /// solves pay a premium; the modal 4-guess solve returns 0.80x; slow solves a fraction. MUST match
    /// WORDLE_MULT_X100 in wordle.ts.
    function wordleMultX100(uint256 guessesUsed) internal pure returns (uint256) {
        if (guessesUsed == 1) return 2500;
        if (guessesUsed == 2) return 350;
        if (guessesUsed == 3) return 130;
        if (guessesUsed == 4) return 80;
        if (guessesUsed == 5) return 55;
        if (guessesUsed == 6) return 25;
        return 0;
    }

    /// The escrow ceiling (×100) for a Wordle round — the richest payout (solve-in-1). A round's
    /// house escrow is sized from this, so it MUST be >= every reachable wordleMultX100.
    function wordleMaxMultX100() internal pure returns (uint256) {
        return 2500;
    }

    /// win payout (chip units) for a `stake` at `multX100`.
    function payout(uint256 stake, uint256 multX100) internal pure returns (uint256) {
        return stake * multX100 / HUNDREDTHS;
    }

    /// True iff a 5-trit Wordle clue is all-green (every letter == 2) — i.e. the guess SOLVED the
    /// hidden word. The trustless "player won" predicate: paired with a WordleRules proof that the
    /// clue was scored honestly against the committed word, an all-green clue is a proven solve.
    function isAllGreen(uint256[5] memory clue) internal pure returns (bool) {
        for (uint256 i = 0; i < 5; i++) {
            if (clue[i] != 2) return false;
        }
        return true;
    }
}

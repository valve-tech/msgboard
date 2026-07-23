pragma circom 2.1.6;

// ZK-Wordle SETTLEMENT proof — trustless guess-sequence binding + dictionary membership (M3).
//
// This is the proof that makes on-chain settleWordle PERMISSIONLESS (no house co-signature over
// guesses-used). Where wordle_clue.circom proves one clue is honest, this circuit proves the WHOLE
// round outcome: given the player's committed ordered guess sequence and the house's committed word,
// it proves the FIRST all-green position (= guesses-used, the payout scale) and that the answer is a
// real dictionary word.
//
// Public-signal ORDER (must match `component main` below and WordleRules.checkSolve packing):
//   [ commit, guessesCommit, dictRoot, guessesUsed ]   (4 signals)
//     commit        = Poseidon(word[0..4], salt)                    — the house's hidden-word commitment
//     guessesCommit = Poseidon(packedGuess[0..maxGuesses-1])        — the player's ordered-guess commitment
//     dictRoot      = Merkle root (Poseidon(2) nodes) of valid words — committed dictionary
//     guessesUsed   = the first all-green position, 1..maxGuesses    — FORCED in-circuit, not claimed
//
// Private: word[5], salt, guess[maxGuesses][5], and the Merkle path (pathElements/pathIndices) for
// the winning word's leaf.
//
// Packing: packedWord = Σ_j word[j]·26^j (base-26, little-endian; every letter range-checked <26), so
// two 5-letter words are equal iff their packed values are equal — this lets one field comparison
// stand in for the 5-letter all-green test, and lets the dictionary leaf be `packedWord` directly.
//
// Soundness of the guesses-used binding: `notPrefix[i]` = Π_{k<i}(1-isSolved[k]) is 1 iff no earlier
// guess solved; `firstAt[i] = notPrefix[i]·isSolved[i]` is 1 only at the FIRST solve. Exactly one
// firstAt is enforced to be 1 (so this is a WIN proof) and guessesUsed is pinned to Σ (i+1)·firstAt[i].
// A player cannot claim a smaller guesses-used (the earlier committed guesses are proven non-solving)
// nor fake a solve (some committed guess must equal the committed word).

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

// Merkle inclusion for a leaf under `root`, Poseidon(2) internal nodes. pathIndices[i] == 1 means the
// running node is the RIGHT child at level i (its sibling pathElements[i] is on the left).
template WordleMerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input root;

    component hashers[depth];
    signal cur[depth + 1];
    signal left[depth];
    signal right[depth];
    cur[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0; // boolean
        left[i]  <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        cur[i + 1] <== hashers[i].out;
    }
    root === cur[depth];
}

template WordleSolve(maxGuesses, dictDepth) {
    // --- public ---
    signal input commit;
    signal input guessesCommit;
    signal input dictRoot;
    signal input guessesUsed;

    // --- private ---
    signal input word[5];
    signal input salt;
    signal input guess[maxGuesses][5];
    signal input pathElements[dictDepth];
    signal input pathIndices[dictDepth];

    // 1. range-check the word letters (so base-26 packing is injective) + commitment binding.
    component wordRange[5];
    for (var j = 0; j < 5; j++) {
        wordRange[j] = LessThan(5);
        wordRange[j].in[0] <== word[j];
        wordRange[j].in[1] <== 26;
        wordRange[j].out === 1;
    }
    component commitHash = Poseidon(6);
    for (var j = 0; j < 5; j++) commitHash.inputs[j] <== word[j];
    commitHash.inputs[5] <== salt;
    commitHash.out === commit;

    // packedWord = Σ_j word[j]·26^j (Horner over j = 4..0).
    signal wacc[6];
    wacc[5] <== 0;
    for (var j = 4; j >= 0; j--) {
        wacc[j] <== wacc[j + 1] * 26 + word[j];
    }
    signal packedWord;
    packedWord <== wacc[0];

    // 2. range-check + pack every committed guess, then bind the sequence commitment.
    component guessRange[maxGuesses][5];
    signal gacc[maxGuesses][6];
    signal packedGuess[maxGuesses];
    for (var i = 0; i < maxGuesses; i++) {
        for (var j = 0; j < 5; j++) {
            guessRange[i][j] = LessThan(5);
            guessRange[i][j].in[0] <== guess[i][j];
            guessRange[i][j].in[1] <== 26;
            guessRange[i][j].out === 1;
        }
        gacc[i][5] <== 0;
        for (var j = 4; j >= 0; j--) {
            gacc[i][j] <== gacc[i][j + 1] * 26 + guess[i][j];
        }
        packedGuess[i] <== gacc[i][0];
    }
    component gCommit = Poseidon(maxGuesses);
    for (var i = 0; i < maxGuesses; i++) gCommit.inputs[i] <== packedGuess[i];
    gCommit.out === guessesCommit;

    // 3. isSolved[i] = (packedGuess[i] == packedWord)  (all-green ⟺ packed equal, given the ranges).
    component solvedEq[maxGuesses];
    signal isSolved[maxGuesses];
    for (var i = 0; i < maxGuesses; i++) {
        solvedEq[i] = IsEqual();
        solvedEq[i].in[0] <== packedGuess[i];
        solvedEq[i].in[1] <== packedWord;
        isSolved[i] <== solvedEq[i].out;
    }

    // 4. first-solve binding: guessesUsed == 1-based index of the FIRST all-green guess.
    signal notPrefix[maxGuesses + 1]; // Π_{k<i}(1 - isSolved[k])
    signal firstAt[maxGuesses];
    signal weighted[maxGuesses + 1];
    signal counted[maxGuesses + 1];
    notPrefix[0] <== 1;
    weighted[0] <== 0;
    counted[0] <== 0;
    for (var i = 0; i < maxGuesses; i++) {
        firstAt[i] <== notPrefix[i] * isSolved[i];
        notPrefix[i + 1] <== notPrefix[i] * (1 - isSolved[i]);
        weighted[i + 1] <== weighted[i] + firstAt[i] * (i + 1);
        counted[i + 1] <== counted[i] + firstAt[i];
    }
    counted[maxGuesses] === 1;              // exactly one first-solve ⇒ this is a WIN proof
    weighted[maxGuesses] === guessesUsed;   // and guesses-used is that position — not a free claim

    // 5. dictionary membership: the winning word (== the winning guess) is in the committed dictionary.
    component dict = WordleMerkleInclusion(dictDepth);
    dict.leaf <== packedWord;
    dict.root <== dictRoot;
    for (var i = 0; i < dictDepth; i++) {
        dict.pathElements[i] <== pathElements[i];
        dict.pathIndices[i] <== pathIndices[i];
    }
}

// dictDepth = 14 → up to 2^14 = 16,384 dictionary leaves, enough for the full 12,972-word canonical
// original-Wordle valid-guess list (see src/dictionaries/wordle-valid-guesses.ts + PROD_DICT_DEPTH).
component main {public [commit, guessesCommit, dictRoot, guessesUsed]} = WordleSolve(6, 14);

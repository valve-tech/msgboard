pragma circom 2.1.6;

// ZK-Wordle: proves the house scored `guess` against a committed hidden
// `word` (+ `salt`) honestly, including correct duplicate-letter handling.
//
// Public:  commit, guess[5] (0..25), clue[5] (0=grey,1=yellow,2=green)
// Private: word[5] (0..25), salt
//
// See docs/superpowers/specs/2026-07-02-zk-skill-games-design.md and the M0
// task spec for the exact scoring formulation implemented below.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template WordleClue() {
    signal input commit;
    signal input guess[5];
    signal input clue[5];

    signal input word[5];
    signal input salt;

    // --- 1. commitment: Poseidon(word[0..4], salt) == commit ---
    component hasher = Poseidon(6);
    for (var i = 0; i < 5; i++) {
        hasher.inputs[i] <== word[i];
    }
    hasher.inputs[5] <== salt;
    hasher.out === commit;

    // --- 2. range checks ---
    component wordRange[5];
    component guessRange[5];
    component clueRange[5];
    for (var i = 0; i < 5; i++) {
        wordRange[i] = LessThan(5);
        wordRange[i].in[0] <== word[i];
        wordRange[i].in[1] <== 26;
        wordRange[i].out === 1;

        guessRange[i] = LessThan(5);
        guessRange[i].in[0] <== guess[i];
        guessRange[i].in[1] <== 26;
        guessRange[i].out === 1;

        clueRange[i] = LessThan(2);
        clueRange[i].in[0] <== clue[i];
        clueRange[i].in[1] <== 3;
        clueRange[i].out === 1;
    }

    // --- 3. green[i] = (guess[i] == word[i]) ---
    component greenEq[5];
    signal green[5];
    for (var i = 0; i < 5; i++) {
        greenEq[i] = IsEqual();
        greenEq[i].in[0] <== guess[i];
        greenEq[i].in[1] <== word[i];
        green[i] <== greenEq[i].out;
    }

    // --- 4. avail_i = # occurrences of guess[i] in word at non-green positions ---
    component availEq[5][5];
    signal availTerm[5][5];
    signal availAcc[5][6];
    signal avail[5];
    for (var i = 0; i < 5; i++) {
        availAcc[i][0] <== 0;
        for (var j = 0; j < 5; j++) {
            availEq[i][j] = IsEqual();
            availEq[i][j].in[0] <== word[j];
            availEq[i][j].in[1] <== guess[i];
            availTerm[i][j] <== availEq[i][j].out * (1 - green[j]);
            availAcc[i][j + 1] <== availAcc[i][j] + availTerm[i][j];
        }
        avail[i] <== availAcc[i][5];
    }

    // --- 5. usedBefore_i = # earlier non-green guess positions with same letter ---
    component usedEq[5][5];
    signal usedTerm[5][5];
    signal usedAcc[5][6];
    signal usedBefore[5];
    for (var i = 0; i < 5; i++) {
        usedAcc[i][0] <== 0;
        for (var k = 0; k < 5; k++) {
            if (k < i) {
                usedEq[i][k] = IsEqual();
                usedEq[i][k].in[0] <== guess[k];
                usedEq[i][k].in[1] <== guess[i];
                usedTerm[i][k] <== usedEq[i][k].out * (1 - green[k]);
            } else {
                usedTerm[i][k] <== 0;
            }
            usedAcc[i][k + 1] <== usedAcc[i][k] + usedTerm[i][k];
        }
        usedBefore[i] <== usedAcc[i][5];
    }

    // --- 6. yellow_i = !green[i] AND usedBefore_i < avail_i ---
    component ltAvail[5];
    signal yellow[5];
    for (var i = 0; i < 5; i++) {
        ltAvail[i] = LessThan(4);
        ltAvail[i].in[0] <== usedBefore[i];
        ltAvail[i].in[1] <== avail[i];
        yellow[i] <== (1 - green[i]) * ltAvail[i].out;
    }

    // --- 7. clue[i] == 2*green[i] + yellow[i] (green/yellow mutually exclusive) ---
    for (var i = 0; i < 5; i++) {
        clue[i] === 2 * green[i] + yellow[i];
    }
}

component main {public [commit, guess, clue]} = WordleClue();

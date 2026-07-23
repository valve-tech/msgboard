pragma circom 2.1.6;

// ZK-Sudoku solve (M3 "role-flip"). Proves the prover knows a VALID solution to a
// committed PUBLIC puzzle, WITHOUT revealing the solution, and binds the proof to a
// public `player` via a nullifier so it cannot be replayed or front-run in a timed
// race.
//
// Public inputs:  puzzlePacked[2] (the 81-cell puzzle, 4 bits/cell), player
// Public output:  nullifier
// Private inputs: solution[81]
//
// WHY THIS SHAPE (see docs/superpowers/plans + the design spec):
//   M2's circuit required Poseidon(solution‖salt) == commit for a HOUSE-committed
//   `salt`. That was house-exploitable: (a) an honest player cannot reproduce the
//   house's secret salt, so as specified they literally could not prove; and (b) a
//   malicious house could commit a value matching no real / an ambiguous / unsolvable
//   puzzle, so an honest solver forfeited the stake at the deadline. Fix: the win
//   proof no longer references any house secret. It proves ONLY "solution ⊨ public
//   puzzle" and any valid solution wins. Solvability is guaranteed separately by the
//   HOUSE proving a solve of the same puzzle at open (same circuit), so the player is
//   protected without a uniqueness proof.
//
// ---------------------------------------------------------------------------------
// WHY THE PUZZLE IS PACKED (2 signals, not 81)
//
// A snarkjs PLONK zkey stores ONE Lagrange polynomial per PUBLIC INPUT, each 5n field
// elements (n = domain size). With the puzzle as 81 separate public inputs the proving
// key was 960 MB — 90.7% of it was that one section (83 x 10,485,760 B) — which is
// unshippable to a browser, and browser proving is REQUIRED here because the PLAYER is
// the one who knows the solution. The cost was the public-input COUNT, not circuit
// complexity (this circuit is only ~23k constraints).
//
// This is the mirror image of the on-chain cost: groth16 charged ~6k gas per public
// input (which is why PLONK verifies ~59% cheaper here), while PLONK charges ~10.5 MB
// of proving key per public input. Packing wins on BOTH sides — it also drops 79 words
// of calldata (~40k gas) per settle.
//
// Each cell is 0..9 => 4 bits. 81 cells = 324 bits, which needs 2 BN254 field elements
// (a cell has TEN states — 0=blank plus 1..9 — so 81*log2(10) = 269.1 bits is the
// information-theoretic floor; the largest base fitting one 253-bit element is 8, so
// ONE element is impossible for any encoding). Layout, little-endian by cell index,
// mirrored bit-for-bit in SudokuRules.sol (_packPuzzle) and src/sudoku.ts (packPuzzle):
//   puzzlePacked[0] = sum over i in [0,62]  of puzzle[i] * 16^i        (63 cells = 252 bits)
//   puzzlePacked[1] = sum over i in [63,80] of puzzle[i] * 16^(i-63)   (18 cells =  72 bits)
// 252 < 254, so Num2Bits (non-strict) is sound: it constrains the input below 2^252 < q,
// so there is exactly one valid bit representation and no field wraparound.
//
// Cell VALIDITY needs no extra constraint: an unpacked cell is 4 bits, so 0..15. A cell
// in 10..15 forces isZero=0, hence isEq=1, hence solution[i] = that cell — but the
// one-hot encoding below forces solution[i] in [1,9], so such a witness is unsatisfiable.
//
// ---------------------------------------------------------------------------------
// WHY THE SOLUTION IS ONE-HOT
//
// PLONK's zkey scales with the DOMAIN, the next power of two >= the constraint count.
// The obvious encoding (27 groups x 9 values x 9 cells = 2,187 IsEqual components) put
// this at 35,055 PLONK constraints — just 2,287 over the 2^15 = 32,768 cliff, forcing
// n = 65536 and DOUBLING every section of the key. One-hot lands it at 28,332, which
// clears the cliff and halves the zkey (131 MB -> 66 MB).
//
// sel[i][v] = 1 iff solution[i] == v+1 (nine slots, indices 0..8 — a solution cell is
// never 0; blanks exist only in the PUZZLE, handled by the clue-agreement check). The
// prover supplies sel (<--) and these constraints force it to be the honest encoding:
//   (a) sel[i][v] is boolean                    -> sel*(sel-1) === 0
//   (b) exactly one v is set                    -> sum_v sel[i][v] === 1
//   (c) the set index IS the value              -> sum_v (v+1)*sel[i][v] === solution[i]
// (b)+(c) also FORCE solution[i] in [1,9] with no separate range check: exactly one v in
// 0..8 is set, so the weighted sum lands in {1..9} by construction. This SUBSUMES the
// old Num2Bits(4)/LessThan(4) range check (verified: a solution containing 0 or 10 is
// unsatisfiable). A group is then a permutation of 1..9 iff each value appears exactly
// once in it — now a pure LINEAR sum over sel, with no non-linear constraint at all.
//
// ---------------------------------------------------------------------------------
// nullifier scheme (mirror bit-for-bit in src/sudoku.ts) — UNCHANGED by the above, and
// pinned by a test asserting this circuit's nullifier equals the pre-packing circuit's:
//   rowDigest[r] = Poseidon(solution[r*9 .. r*9+8])     (9 inputs)  for r = 0..8
//   nullifier    = Poseidon(rowDigest[0..8], player)    (10 inputs)
// Every Poseidon call is <= 16 inputs (circomlib's limit) via a two-level sponge.
// The nullifier is preimage-resistant in `solution` (a watcher who cannot solve the
// puzzle cannot compute it) and is bound to `player`, so copying the proof for a
// different player is impossible and the contract can record it to block replay.
//
// Public-signal order (snarkjs emits OUTPUTS first, then public inputs in declaration
// order): pub = [nullifier, puzzlePacked[0], puzzlePacked[1], player]  (4 signals).
// SudokuRules.sol packs exactly this order.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

template SudokuSolve() {
    signal input puzzlePacked[2];
    signal input player;

    signal input solution[81];

    signal output nullifier;

    // --- 0. unpack puzzlePacked[2] -> puzzle[81] (4 bits per cell, little-endian) ---
    component pb0 = Num2Bits(252);
    pb0.in <== puzzlePacked[0];
    component pb1 = Num2Bits(72);
    pb1.in <== puzzlePacked[1];

    signal puzzle[81];
    for (var i = 0; i < 63; i++) {
        puzzle[i] <== pb0.out[4 * i] + 2 * pb0.out[4 * i + 1] + 4 * pb0.out[4 * i + 2] + 8 * pb0.out[4 * i + 3];
    }
    for (var i = 63; i < 81; i++) {
        var j = i - 63;
        puzzle[i] <== pb1.out[4 * j] + 2 * pb1.out[4 * j + 1] + 4 * pb1.out[4 * j + 2] + 8 * pb1.out[4 * j + 3];
    }

    // --- 1. one-hot encode the solution: forces each cell into [1,9] (see header) ---
    signal sel[81][9];
    for (var i = 0; i < 81; i++) {
        var acc = 0;
        var vacc = 0;
        for (var v = 0; v < 9; v++) {
            sel[i][v] <-- (solution[i] == v + 1) ? 1 : 0;
            sel[i][v] * (sel[i][v] - 1) === 0;
            acc += sel[i][v];
            vacc += (v + 1) * sel[i][v];
        }
        acc === 1;
        vacc === solution[i];
    }

    // --- 2. puzzle[i] != 0 => solution[i] == puzzle[i] ---
    // encoded as: IsZero(puzzle[i]) OR IsEqual(solution[i], puzzle[i])
    component isZero[81];
    component isEq[81];
    signal agreeOr[81];
    for (var i = 0; i < 81; i++) {
        isZero[i] = IsZero();
        isZero[i].in <== puzzle[i];

        isEq[i] = IsEqual();
        isEq[i].in[0] <== solution[i];
        isEq[i].in[1] <== puzzle[i];

        agreeOr[i] <== isZero[i].out + isEq[i].out - isZero[i].out * isEq[i].out;
        agreeOr[i] === 1;
    }

    // --- 3. rows / cols / 3x3 boxes are each a permutation of 1..9 ---
    // With the one-hot encoding this is exactly "each value appears once per group",
    // i.e. a LINEAR sum over sel — no IsEqual, no non-linear constraint.
    var groups[27][9];
    var g = 0;

    // rows
    for (var r = 0; r < 9; r++) {
        for (var c = 0; c < 9; c++) {
            groups[g][c] = r * 9 + c;
        }
        g++;
    }
    // columns
    for (var c = 0; c < 9; c++) {
        for (var r = 0; r < 9; r++) {
            groups[g][r] = r * 9 + c;
        }
        g++;
    }
    // 3x3 boxes
    for (var br = 0; br < 3; br++) {
        for (var bc = 0; bc < 3; bc++) {
            var k = 0;
            for (var dr = 0; dr < 3; dr++) {
                for (var dc = 0; dc < 3; dc++) {
                    groups[g][k] = (br * 3 + dr) * 9 + (bc * 3 + dc);
                    k++;
                }
            }
            g++;
        }
    }

    for (var gi = 0; gi < 27; gi++) {
        for (var v = 0; v < 9; v++) {
            var s = 0;
            for (var ci = 0; ci < 9; ci++) {
                s += sel[groups[gi][ci]][v];
            }
            s === 1;
        }
    }

    // --- 4. nullifier: row-wise Poseidon(9) sponge, then Poseidon(10) with `player` ---
    // rowDigest[r] = Poseidon(solution row r); nullifier = Poseidon(rowDigest[0..8], player).
    // Binds all 81 cells + the player into one field element. No house salt/commit here.
    component rowHash[9];
    signal rowDigest[9];
    for (var r = 0; r < 9; r++) {
        rowHash[r] = Poseidon(9);
        for (var c = 0; c < 9; c++) {
            rowHash[r].inputs[c] <== solution[r * 9 + c];
        }
        rowDigest[r] <== rowHash[r].out;
    }

    component nullHash = Poseidon(10);
    for (var r = 0; r < 9; r++) {
        nullHash.inputs[r] <== rowDigest[r];
    }
    nullHash.inputs[9] <== player;
    nullifier <== nullHash.out;
}

component main {public [puzzlePacked, player]} = SudokuSolve();

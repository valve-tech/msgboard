// Task 1 GATE - trivial circuit.
// Proves knowledge of a private `x` such that x + 1 == y (public).
// This is the smallest non-trivial statement that exercises the full
// pure-JS Noir pipeline: noir_wasm compile -> noir_js execute -> bb.js
// UltraHonk prove/verify, including a real public input.
fn main(x: Field, y: pub Field) {
    assert(x + 1 == y);
}

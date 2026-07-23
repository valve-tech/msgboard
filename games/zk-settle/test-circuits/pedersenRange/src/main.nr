// Pedersen commitment to a hidden bet amount, plus a range proof bounding it.
// ASCII-only comments (Noir requires it).
//
// Privacy model: the bet `amount` is a PRIVATE witness. Its Pedersen commitment
// (a Grumpkin point) is the only PUBLIC output, so a verifier learns nothing
// about the amount beyond "the prover knows an opening (amount, blinding) of
// this commitment, and that amount is in range".
//
// The range proof is the soundness-critical part: without it a prover could
// commit to a negative or astronomically large amount (a Field wraps mod the
// bn254 prime, so "negative" amounts and overflow are the same attack). We
// pass `amount` as a `u64`, which the constraint system already forces into
// [0, 2^64), then assert `1 <= amount <= MAX_AMOUNT`. A `u64` cannot represent
// a negative value, and the explicit upper bound caps the wager.
//
// Parity: `std::hash::pedersen_commitment([amount as Field, blinding])` uses the
// same Grumpkin generator set (hash_index 0) as bb.js's `pedersenCommit`, so the
// TS side can rebuild the exact same commitment from bb.js. Verified empirically.

// Max bet, in the smallest unit. 1e15 (well under u64 max ~1.8e19); a wager over
// this fails to prove. Chosen as a representative on-chain wager cap.
global MAX_AMOUNT: u64 = 1_000_000_000_000_000;

fn main(amount: u64, blinding: Field) -> pub (Field, Field) {
    // Range proof: amount is a positive wager no greater than MAX_AMOUNT.
    // `amount: u64` already constrains amount < 2^64 (so it can never be the
    // wrap-around encoding of a negative number); these two asserts bound it to
    // a sane, non-zero wager.
    assert(amount != 0, "amount must be positive");
    assert(amount <= MAX_AMOUNT, "amount exceeds MAX_AMOUNT");

    // Pedersen commitment to (amount, blinding). The blinding factor hides the
    // amount even though the commitment is public and the amount domain is small.
    let p = std::hash::pedersen_commitment([amount as Field, blinding]);
    (p.x, p.y)
}

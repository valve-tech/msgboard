// Task 5 - the limbo PRIVACY settle circuit (hidden amounts + conservation).
// ASCII-only comments (Noir requires it).
//
// This is the limbo analogue of the Task-4 dice privacy circuit. It REUSES the
// Task-2 keccak/r machinery (seed bind + WIDE 256-bit-r reduction) and the
// Task-3 Pedersen commitment primitive verbatim. The limbo payout math
// reproduces the EXACT GamePayouts / limbo.ts operation order. The bet `stake`
// and the open/final balances are PRIVATE witnesses; only their Pedersen
// commitments are PUBLIC, so an independent verifier checks conservation between
// the committed values WITHOUT learning the amounts.
//
// Statement:
//   PUBLIC INPUTS : rngCommit, clientSeedCommit (each [u8; 32]), targetX100 (the
//                   bet odds / target multiplier in hundredths; public)
//   PRIVATE       : serverSeed, clientSeed, stake, open/final balances + blindings
//   ASSERTS       : keccak256(serverSeed) == rngCommit
//                   keccak256(clientSeed) == clientSeedCommit
//                   (nonce hardcoded 1)
//                   r = uint256(keccak256(abi.encode(serverSeed, clientSeed, 1)))
//                   u = r % 1_000_000  (WIDE reduction; modulus 1e6, NOT 10000)
//                   resultX100 = (99 * 1_000_000) / (1_000_000 - u)
//                   win  = resultX100 >= targetX100
//                   payout = win ? stake * targetX100 / 100 : 0
//                   playerDelta = win ? payout - stake : -stake (handled by case)
//                   finalBalancePlayer == openBalancePlayer + playerDelta
//                   finalBalanceHouse  == openBalanceHouse  - playerDelta
//   PUBLIC OUTPUTS: the five Pedersen commitments (x,y) to the hidden amounts.
use keccak256::keccak256;

global EDGE_BPS: u64 = 100; // 1% house edge (bps) - mirrors game.ts / GamePayouts
global HUNDREDTHS: u64 = 100; // fixed-point scale 1.00x == 100
global LIMBO_U_SPACE: u64 = 1_000_000; // u in [0, 999_999] models U in [0,1) at 1e-6
// (1 - edge) in hundredths: (10000 - 100) / 100 == 99  (i.e. 0.99x == 99).
global LIMBO_ONE_MINUS_EDGE_X100: u64 = (10_000 - EDGE_BPS) / HUNDREDTHS; // 99
global LIMBO_MIN_TARGET: u64 = 100; // 1.00x
// Max meaningful target == the largest resultX100 (u = U_SPACE - 1):
// 99 * 1_000_000 == 99_000_000 (990000.00x). Above this no roll can ever win.
global LIMBO_MAX_TARGET: u64 = LIMBO_ONE_MINUS_EDGE_X100 * LIMBO_U_SPACE; // 99_000_000
global MAX_AMOUNT: u64 = 1_000_000_000_000_000; // 1e15 wager/balance cap (Task 3)
// u64 max as u128 (2^64 - 1) - the guard bound for narrowing the wide payout back
// to u64 (Task-5 review fix). Every conserving win has payout << this.
global U64_MAX_AS_U128: u128 = 18_446_744_073_709_551_615;

// r % m on a 256-bit big-endian byte array, computed on the WIDE value (never a
// single Field, which would wrap at ~254 bits). Horner in u64; max intermediate
// 256*(m-1)+255. For m == 1_000_000 that is 256_000_255 < 2^32, so the u64
// arithmetic never overflows. Identical to keccakProbe (Task 2) / diceSettle.
fn mod_be_bytes(bytes: [u8; 32], m: u64) -> u64 {
    let mut acc: u64 = 0;
    for i in 0..32 {
        acc = (acc * 256 + bytes[i] as u64) % m;
    }
    acc
}

// Pedersen commitment to a single hidden amount + blinding (Task 3 primitive).
fn commit(amount: u64, blinding: Field) -> (Field, Field) {
    let p = std::hash::pedersen_commitment([amount as Field, blinding]);
    (p.x, p.y)
}

fn main(
    // PUBLIC INPUTS
    rngCommit: pub [u8; 32],
    clientSeedCommit: pub [u8; 32],
    targetX100: pub u64,
    // PRIVATE WITNESSES - seeds
    serverSeed: [u8; 32],
    clientSeed: [u8; 32],
    // PRIVATE WITNESSES - hidden amounts
    stake: u64,
    openBalancePlayer: u64,
    openBalanceHouse: u64,
    finalBalancePlayer: u64,
    finalBalanceHouse: u64,
    // PRIVATE WITNESSES - blindings (one per amount)
    stakeBlinding: Field,
    openBalancePlayerBlinding: Field,
    openBalanceHouseBlinding: Field,
    finalBalancePlayerBlinding: Field,
    finalBalanceHouseBlinding: Field,
) -> pub ((Field, Field), (Field, Field), (Field, Field), (Field, Field), (Field, Field)) {
    // ----- bind BOTH seeds (nonce 1) -----
    let computedRngCommit = keccak256(serverSeed, 32);
    let computedClientCommit = keccak256(clientSeed, 32);
    for i in 0..32 {
        assert(computedRngCommit[i] == rngCommit[i], "rngCommit mismatch");
        assert(computedClientCommit[i] == clientSeedCommit[i], "clientSeedCommit mismatch");
    }

    // ----- derive r = uint256(keccak256(abi.encode(serverSeed, clientSeed, 1u64))) -----
    let mut pre: [u8; 96] = [0; 96];
    for i in 0..32 {
        pre[i] = serverSeed[i];
        pre[32 + i] = clientSeed[i];
    }
    pre[95] = 1; // uint64(1) big-endian in the third 32-byte word
    let rBytes = keccak256(pre, 96);
    // limbo reduces with modulus 1_000_000 (NOT 10000) - the wide reduction is
    // high-bit-safe for m == 1e6 (see mod_be_bytes note).
    let u = mod_be_bytes(rBytes, LIMBO_U_SPACE);

    // ----- limbo payout, EXACT limbo.ts / GamePayouts op-order -----
    assert(targetX100 >= LIMBO_MIN_TARGET, "limbo: target out of range");
    assert(targetX100 <= LIMBO_MAX_TARGET, "limbo: target out of range");

    // range-bound the hidden amounts (Task 3): non-zero stake, all amounts capped.
    assert(stake != 0, "stake must be positive");
    assert(stake <= MAX_AMOUNT, "stake exceeds MAX_AMOUNT");
    assert(openBalancePlayer <= MAX_AMOUNT, "openBalancePlayer exceeds MAX_AMOUNT");
    assert(openBalanceHouse <= MAX_AMOUNT, "openBalanceHouse exceeds MAX_AMOUNT");
    assert(finalBalancePlayer <= MAX_AMOUNT, "finalBalancePlayer exceeds MAX_AMOUNT");
    assert(finalBalanceHouse <= MAX_AMOUNT, "finalBalanceHouse exceeds MAX_AMOUNT");

    // resultX100 = (99 * 1_000_000) / (1_000_000 - u). u in [0, 999_999] so the
    // denominator is in [1, 1_000_000] (never zero) - matches limboResultX100.
    let result_x100 = (LIMBO_ONE_MINUS_EDGE_X100 * LIMBO_U_SPACE) / (LIMBO_U_SPACE - u);
    let win = result_x100 >= targetX100;
    // payout on a win is stake * targetX100 / 100 (the chosen target multiplier).
    //
    // OVERFLOW-SAFE multiply (Task-5 review fix): in u64 the intermediate
    // `stake * targetX100` can reach stake_max * target_max == 1e15 * 99_000_000
    // == 9.9e22, which EXCEEDS u64 max (1.844e19). The canonical bigint limbo.ts
    // computes `(stake * targetX100) / 100` at arbitrary precision, so for an
    // in-range witness (stake <= MAX_AMOUNT, targetX100 <= LIMBO_MAX_TARGET) the
    // u64 product range-constraint aborts the proof with an opaque "multiply with
    // overflow" instead of cleanly computing the payout and letting the
    // conservation/cap asserts reject it. That is a DoS / divergence from the
    // source (dice is unaffected: its multiplier ceiling keeps the product small).
    //
    // Widen the multiply into u128 (max ~3.4e38, ample for 9.9e22), floor-divide
    // by 100 there (native integer division, EXACT same op-order as limbo.ts), then
    // narrow back to u64. The narrowing `as u64` is itself range-constrained: a
    // payout that truly exceeds u64 (only possible for a NON-conserving witness)
    // is caught here or by the downstream MAX_AMOUNT-bounded conservation asserts,
    // NOT by an arithmetic overflow. For every conserving win the payout is
    // bounded by MAX_AMOUNT, so it always fits u64. The result equals
    // limbo.settleRound's bigint payout for the SAME inputs (parity-asserted in test).
    let payout = if win {
        let wide: u128 = (stake as u128) * (targetX100 as u128) / (HUNDREDTHS as u128);
        // Narrowing back to u64 must NOT silently truncate: a payout that exceeds
        // u64 is only reachable for a NON-conserving witness (every conserving win
        // has payout <= ~2*MAX_AMOUNT == 2e15 << u64 max). Guard the narrowing so
        // such a case fails with a MEANINGFUL assert rather than a wrapped value
        // that could slip past conservation (soundness). U64_MAX as u128:
        assert(wide <= U64_MAX_AS_U128, "limbo: payout exceeds u64 (non-conserving)");
        wide as u64
    } else {
        0
    };

    // ----- conservation on the HIDDEN amounts -----
    // playerDelta is signed; handle win/loss as separate u64 updates so no
    // negative is ever formed (same construction as Task 4):
    //   win : finalP == openP + (payout - stake);  finalH == openH - (payout - stake)
    //   loss: finalP == openP - stake;              finalH == openH + stake
    // (loss has payout 0; a win pays target multiplier >= 1.00x so payout >= stake
    //  whenever targetX100 >= 100, which the range assert guarantees.)
    if win {
        assert(payout >= stake, "win payout below stake");
        let gain = payout - stake;
        assert(finalBalancePlayer == openBalancePlayer + gain, "finalP conservation (win)");
        assert(finalBalanceHouse + gain == openBalanceHouse, "finalH conservation (win)");
    } else {
        assert(openBalancePlayer >= stake, "player cannot cover stake");
        assert(finalBalancePlayer + stake == openBalancePlayer, "finalP conservation (loss)");
        assert(finalBalanceHouse == openBalanceHouse + stake, "finalH conservation (loss)");
    }

    // ----- public outputs: the five Pedersen commitments to the hidden amounts -----
    let c_stake = commit(stake, stakeBlinding);
    let c_openP = commit(openBalancePlayer, openBalancePlayerBlinding);
    let c_openH = commit(openBalanceHouse, openBalanceHouseBlinding);
    let c_finalP = commit(finalBalancePlayer, finalBalancePlayerBlinding);
    let c_finalH = commit(finalBalanceHouse, finalBalanceHouseBlinding);
    (c_stake, c_openP, c_openH, c_finalP, c_finalH)
}

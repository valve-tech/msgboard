// Task 4 - the dice PRIVACY settle circuit (hidden amounts + conservation).
// ASCII-only comments (Noir requires it).
//
// This is the privacy version of Track-1's recompute statement. It REUSES the
// Task-2 keccak/r machinery (seed bind + 256-bit-r reduction) and the Task-3
// Pedersen commitment primitive verbatim. The dice payout math reproduces the
// EXACT GamePayouts / dice.ts operation order. The bet `stake` and the open/
// final balances are PRIVATE witnesses; only their Pedersen commitments are
// PUBLIC, so an independent verifier checks conservation between the committed
// values WITHOUT learning the amounts.
//
// Statement:
//   PUBLIC INPUTS : rngCommit, clientSeedCommit (each [u8; 32]), targetX100 (the
//                   bet odds; public)
//   PRIVATE       : serverSeed, clientSeed, stake, open/final balances + blindings
//   ASSERTS       : keccak256(serverSeed) == rngCommit
//                   keccak256(clientSeed) == clientSeedCommit
//                   (nonce hardcoded 1)
//                   r = uint256(keccak256(abi.encode(serverSeed, clientSeed, 1)))
//                   roll = r % 10_000  (wide reduction; see Task 2)
//                   win  = roll < targetX100
//                   multX100 = (10000 - EDGE_BPS) * 10000 / targetX100 / 100
//                   payout   = win ? stake * multX100 / 100 : 0
//                   playerDelta = win ? payout - stake : -stake (handled by case)
//                   finalBalancePlayer == openBalancePlayer + playerDelta
//                   finalBalanceHouse  == openBalanceHouse  - playerDelta
//   PUBLIC OUTPUTS: the five Pedersen commitments (x,y) to the hidden amounts.
use keccak256::keccak256;

global EDGE_BPS: u64 = 100; // 1% house edge (bps) - mirrors game.ts / GamePayouts
global HUNDREDTHS: u64 = 100; // fixed-point scale 1.00x == 100
global DICE_ROLL_SPACE: u64 = 10_000;
global DICE_MIN_TARGET: u64 = 1;
global DICE_MAX_TARGET: u64 = 9899;
global MAX_AMOUNT: u64 = 1_000_000_000_000_000; // 1e15 wager/balance cap (Task 3)

// r % m on a 256-bit big-endian byte array, computed on the WIDE value (never a
// single Field, which would wrap at ~254 bits). Horner in u64; max intermediate
// 256*(m-1)+255 < 2^32 for m <= 1e6. Identical to keccakProbe (Task 2).
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
    let roll = mod_be_bytes(rBytes, DICE_ROLL_SPACE);

    // ----- dice payout, EXACT dice.ts / GamePayouts op-order -----
    assert(targetX100 >= DICE_MIN_TARGET, "dice: target out of range");
    assert(targetX100 <= DICE_MAX_TARGET, "dice: target out of range");

    // range-bound the hidden amounts (Task 3): non-zero stake, all amounts capped.
    assert(stake != 0, "stake must be positive");
    assert(stake <= MAX_AMOUNT, "stake exceeds MAX_AMOUNT");
    assert(openBalancePlayer <= MAX_AMOUNT, "openBalancePlayer exceeds MAX_AMOUNT");
    assert(openBalanceHouse <= MAX_AMOUNT, "openBalanceHouse exceeds MAX_AMOUNT");
    assert(finalBalancePlayer <= MAX_AMOUNT, "finalBalancePlayer exceeds MAX_AMOUNT");
    assert(finalBalanceHouse <= MAX_AMOUNT, "finalBalanceHouse exceeds MAX_AMOUNT");

    let win = roll < targetX100;
    let mult_x100 = (DICE_ROLL_SPACE - EDGE_BPS) * DICE_ROLL_SPACE / targetX100 / HUNDREDTHS;
    let payout = if win { stake * mult_x100 / HUNDREDTHS } else { 0 };

    // ----- conservation on the HIDDEN amounts -----
    // playerDelta is signed; handle win/loss as separate u64 updates so no
    // negative is ever formed:
    //   win : finalP == openP + (payout - stake);  finalH == openH - (payout - stake)
    //   loss: finalP == openP - stake;              finalH == openH + stake
    // (loss has payout 0, so payout < stake here; dice payout on a win is always
    //  > stake since multX100 > 100 for target <= 9899.)
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

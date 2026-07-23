// M2 (Track-2, Milestone 2) - the ON-CHAIN dice settle circuit.
// ASCII-only comments (Noir requires it).
//
// This is the on-chain counterpart of the Task-4 off-chain dice privacy circuit
// (test-circuits/diceSettle). The statement and game math are IDENTICAL to that
// circuit and to the on-chain Solidity GamePayouts._dice, so the proof attests
// EXACTLY what `settleWithSeeds` recomputes - but WITHOUT revealing the seeds
// on-chain. mode-1 (settleWithSeeds) publishes serverSeed + clientSeed in
// calldata; mode-2 keeps both as PRIVATE witnesses and proves, in zero
// knowledge, that they hash to the house-signed commits and produce this payout.
//
// Why the balances are PUBLIC here (and hidden in the off-chain M1 circuit):
// on-chain settlement moves real ERC20 chips, which are public on the ledger, so
// the contract must learn the actual payout split to transfer it. The privacy
// won on-chain is SEED privacy (the seeds never hit calldata) - the bet odds
// (targetX100) and the chip amounts are already public on any escrow ledger. The
// off-chain M1 circuit additionally hides the amounts via Pedersen commitments;
// that is a stronger statement that only makes sense off-chain where no chips
// move. Reusing the off-chain circuit on-chain would force the contract to do
// Grumpkin Pedersen openings in Solidity (not available), so M2 uses this
// public-balance variant - same seed-binding + payout + conservation core.
//
// Statement:
//   PUBLIC INPUTS : rngCommit, clientSeedCommit (each [u8; 32])
//                   targetX100      (bet odds; public)
//                   escrowPlayer    (== stake; the player's locked escrow)
//                   escrowHouse     (the house's locked escrow)
//                   payoutPlayer    (chips the contract pays the player)
//   PRIVATE       : serverSeed, clientSeed
//   ASSERTS       : keccak256(serverSeed) == rngCommit
//                   keccak256(clientSeed) == clientSeedCommit  (nonce hardcoded 1)
//                   r = uint256(keccak256(abi.encode(serverSeed, clientSeed, 1)))
//                   roll = r % 10_000  (WIDE reduction; see Task 2)
//                   win  = roll < targetX100
//                   multX100 = (10000 - EDGE_BPS) * 10000 / targetX100 / 100
//                   payout   = win ? stake * multX100 / 100 : 0
//                   payoutPlayer == payout   (the conserved player payout)
//                   payout <= escrowPlayer + escrowHouse  (escrow ceiling)
//   The conserved house payout is (escrowPlayer + escrowHouse - payoutPlayer),
//   recomputed by the contract; binding payoutPlayer is sufficient because the
//   pot is fixed and public.
use keccak256::keccak256;

global EDGE_BPS: u64 = 100; // 1% house edge (bps) - mirrors game.ts / GamePayouts
global HUNDREDTHS: u64 = 100; // fixed-point scale 1.00x == 100
global DICE_ROLL_SPACE: u64 = 10_000;
global DICE_MIN_TARGET: u64 = 1;
global DICE_MAX_TARGET: u64 = 9899;
global MAX_AMOUNT: u64 = 1_000_000_000_000_000; // 1e15 wager/balance cap (Task 3)

// r % m on a 256-bit big-endian byte array, computed on the WIDE value (never a
// single Field, which would wrap at ~254 bits). Identical to keccakProbe (Task 2)
// and diceSettle (Task 4).
fn mod_be_bytes(bytes: [u8; 32], m: u64) -> u64 {
    let mut acc: u64 = 0;
    for i in 0..32 {
        acc = (acc * 256 + bytes[i] as u64) % m;
    }
    acc
}

fn main(
    // PUBLIC INPUTS
    rngCommit: pub [u8; 32],
    clientSeedCommit: pub [u8; 32],
    targetX100: pub u64,
    escrowPlayer: pub u64,
    escrowHouse: pub u64,
    payoutPlayer: pub u64,
    // PRIVATE WITNESSES - the seeds (never revealed on-chain)
    serverSeed: [u8; 32],
    clientSeed: [u8; 32],
) {
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

    // range-bound the public amounts (Task 3 cap): non-zero stake, all capped.
    let stake = escrowPlayer; // escrowFor: escrowPlayer == stake
    assert(stake != 0, "stake must be positive");
    assert(stake <= MAX_AMOUNT, "stake exceeds MAX_AMOUNT");
    assert(escrowHouse <= MAX_AMOUNT, "escrowHouse exceeds MAX_AMOUNT");

    let win = roll < targetX100;
    let mult_x100 = (DICE_ROLL_SPACE - EDGE_BPS) * DICE_ROLL_SPACE / targetX100 / HUNDREDTHS;
    let payout = if win { stake * mult_x100 / HUNDREDTHS } else { 0 };

    // ----- conservation against the PUBLIC pot -----
    // The contract pays `payoutPlayer` to the player and (pot - payoutPlayer) to
    // the house. Bind the proven payout to that public value, and assert the
    // escrow ceiling (the same `require(payout <= pot)` GamePayouts.settle makes).
    let pot = stake + escrowHouse;
    assert(payout <= pot, "payout exceeds pot");
    assert(payoutPlayer == payout, "payoutPlayer mismatch");
}

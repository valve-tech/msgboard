// The GENERIC table-driven ON-CHAIN settle circuit -- ONE circuit for the whole
// pure-RNG game family (dice, limbo, roulette, wheel, keno, plinko, monte, ...).
// ASCII-only comments (Noir requires it).
//
// WHY ONE CIRCUIT INSTEAD OF ONE PER GAME
// The existing Track-2 approach (games/zk-settle) generates a SEPARATE Noir
// circuit + Solidity UltraHonk verifier per game (diceSettleOnchain, ...). Every
// generated verifier is ~50KiB of bytecode (over EIP-170), so N games == N
// oversized verifiers to deploy/maintain. This circuit replaces the per-game
// payout ARITHMETIC with a generic PIECEWISE-CONSTANT PAYTABLE lookup: the payout
// is a step function of the round bucket `r % outcomeSpace`, expressed as an
// ascending list of (hi, multX100) segments. Every pure-RNG game whose payout is
// a function of one reduced draw is an instance of that table:
//   dice@target   -> outcomeSpace 10000, segs [(target, winMult), (10000, 0)]
//   limbo@target  -> outcomeSpace 1e6,   segs [(uWin, 0), (1e6, targetMult)]
//   roulette      -> outcomeSpace 37,    37 unit segs, mult per slot (straight/color/...)
//   wheel/keno/.. -> outcomeSpace N,     N segs, mult per bucket
// so a SINGLE deployed verifier settles all of them. dicex2 (two sub-rolls from
// keccak(r,i)) needs the sub-random extension and is out of scope for v1, but the
// paytable shape is compatible.
//
// THE KECCAK / paramsHash TRICK (mirrors settleWithProof in HouseChannel.sol)
// The paytable is NOT hashed in-circuit. On-chain, settleWithProof already binds
// the round params to the house-signed paramsHash with a CHEAP EVM keccak
// (`keccak256(params) == t.paramsHash`) and DECODES params into the verifier's
// PUBLIC inputs. So the paytable (outcomeSpace, hi[], mult[]) rides as PUBLIC
// inputs here exactly the way targetX100 does in the per-game dice circuit -- the
// ONLY in-circuit keccaks are the same three the dice circuit already pays:
// keccak256(serverSeed), keccak256(clientSeed), and the 96-byte r-derivation.
// This is the decisive point for the stack choice (see README): keccak in-circuit
// is mandatory for SEED privacy (the whole value of mode-2 over settleWithSeeds),
// and only UltraHonk makes those keccaks practical.
//
// Statement:
//   PUBLIC : rngCommit, clientSeedCommit (each [u8; 32])
//            outcomeSpace          (the bucket modulus; game-specific, public)
//            segCount              (number of active paytable segments, <= MAX_SEG)
//            hi[MAX_SEG]           (ascending segment upper bounds; hi[segCount-1]==outcomeSpace)
//            mult[MAX_SEG]         (multX100 per segment; the paytable)
//            escrowPlayer (== stake), escrowHouse, payoutPlayer
//   PRIVATE: serverSeed, clientSeed
//   ASSERTS: keccak256(serverSeed) == rngCommit
//            keccak256(clientSeed) == clientSeedCommit  (nonce hardcoded 1)
//            r = uint256(keccak256(abi.encode(serverSeed, clientSeed, 1)))
//            bucket = r % outcomeSpace  (WIDE reduction; see Task 2 / diceSettle)
//            multX100 = mult[ the unique segment containing bucket ]
//            payout = stake * multX100 / 100
//            payout <= escrowPlayer + escrowHouse  (escrow ceiling)
//            payoutPlayer == payout
use keccak256::keccak256;

global HUNDREDTHS: u64 = 100; // fixed-point scale 1.00x == 100
global MAX_AMOUNT: u64 = 1_000_000_000_000_000; // 1e15 wager/balance cap (mirrors zk-settle)
global MAX_OUTCOME_SPACE: u64 = 1_000_000; // wide-reduction high-bit safety bound (== limbo U_SPACE)
// Compile-time paytable capacity. 64 covers roulette (37 unit slots), wheel, keno
// hit-tables and the 2-segment dice/limbo tables with room to spare. Bumping this
// (to 128/256) is the ONLY change needed for larger tables and keeps ONE circuit
// per capacity; the public-input vector grows by 2 fields per added segment.
global MAX_SEG: u32 = 64;
// u64 max as u128 (2^64 - 1) -- guard the narrowing of the widened payout back to
// u64 (a payout that truly exceeds u64 is only reachable for a non-conserving
// witness; every in-range win fits u64). Same construction as limboSettle.
global U64_MAX_AS_U128: u128 = 18_446_744_073_709_551_615;

// r % m on a 256-bit big-endian byte array, computed on the WIDE value (never a
// single Field, which would wrap at ~254 bits). Horner in u64; max intermediate
// 256*(m-1)+255 < 2^32 for m <= 1e6. Identical to keccakProbe / diceSettle.
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
    outcomeSpace: pub u64,
    segCount: pub u64,
    hi: pub [u64; 64],
    mult: pub [u64; 64],
    escrowPlayer: pub u64,
    escrowHouse: pub u64,
    payoutPlayer: pub u64,
    // PRIVATE WITNESSES -- the seeds (never revealed on-chain)
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

    // ----- bucket = r % outcomeSpace (WIDE reduction) -----
    assert(outcomeSpace > 0, "outcomeSpace must be positive");
    assert(outcomeSpace <= MAX_OUTCOME_SPACE, "outcomeSpace exceeds MAX_OUTCOME_SPACE");
    let bucket = mod_be_bytes(rBytes, outcomeSpace);

    // ----- range-bound the public amounts (Task-3 cap): non-zero stake, all capped -----
    let stake = escrowPlayer; // escrowFor: escrowPlayer == stake
    assert(stake != 0, "stake must be positive");
    assert(stake <= MAX_AMOUNT, "stake exceeds MAX_AMOUNT");
    assert(escrowHouse <= MAX_AMOUNT, "escrowHouse exceeds MAX_AMOUNT");

    // ----- paytable lookup: multX100 of the unique segment containing `bucket` -----
    // The table is a public, house-signed list of `segCount` ascending, contiguous
    // half-open ranges [prevHi, hi[j]) covering [0, outcomeSpace). We SCAN all
    // MAX_SEG slots (data-independent, so no witness-chosen index to make unsound),
    // gate on `j < segCount`, and accumulate the multiplier of the one segment that
    // contains bucket. The well-formedness asserts (strictly ascending bounds; last
    // active hi == outcomeSpace) guarantee EXACTLY ONE segment matches, so `matched`
    // is deterministic; `hits == 1` fails loud on any malformed table.
    assert(segCount != 0, "segCount must be positive");
    assert(segCount <= MAX_SEG as u64, "segCount exceeds MAX_SEG");

    let mut matched: u64 = 0; // accumulated multX100 of the matching segment
    let mut hits: u64 = 0; // how many active segments contain bucket (must be exactly 1)
    let mut prev_hi: u64 = 0; // lower bound of the current segment (== previous hi)
    for j in 0..MAX_SEG {
        let active = (j as u64) < segCount;
        if active {
            let h = hi[j];
            assert(h > prev_hi, "table bounds not strictly ascending");
            let in_seg = (bucket >= prev_hi) & (bucket < h);
            if in_seg {
                matched = matched + mult[j];
                hits = hits + 1;
            }
            prev_hi = h;
        }
    }
    // prev_hi now equals hi[segCount-1] (only active slots advanced it); the table
    // must exactly cover the outcome space, and bucket must land in one segment.
    assert(prev_hi == outcomeSpace, "table does not cover outcomeSpace");
    assert(hits == 1, "bucket not covered by exactly one segment");
    let mult_x100 = matched;

    // ----- payout = stake * multX100 / 100 (widen to u128, then narrow -- see limboSettle) -----
    let wide: u128 = (stake as u128) * (mult_x100 as u128) / (HUNDREDTHS as u128);
    assert(wide <= U64_MAX_AS_U128, "payout exceeds u64 (non-conserving)");
    let payout = wide as u64;

    // ----- conservation against the PUBLIC pot -----
    let pot = stake + escrowHouse;
    assert(payout <= pot, "payout exceeds pot");
    assert(payoutPlayer == payout, "payoutPlayer mismatch");
}

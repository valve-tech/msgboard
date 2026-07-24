pragma circom 2.1.6;

// MEASUREMENT SPIKE (not shipped) — the circom/PLONK cost of the table-LOOKUP part
// of the generic settle statement, WITHOUT the keccak seed-binding. `bucket` is a
// public input here (in the real statement it is r % outcomeSpace, and r is
// keccak-derived — that keccak is the expensive part measured separately). This
// isolates: given a public paytable (hi[], mult[]) and a public bucket, prove
// matched == the multX100 of the unique covering segment. Mirrors the Noir scan.
include "circomlib/circuits/comparators.circom";

template TableLookup(MAXSEG, NBITS) {
    signal input bucket;
    signal input segCount;
    signal input hi[MAXSEG];
    signal input mult[MAXSEG];
    signal output matched;

    signal prevHi[MAXSEG + 1];
    prevHi[0] <== 0;

    component geLo[MAXSEG];   // bucket >= prevHi  == NOT (bucket < prevHi)
    component ltHi[MAXSEG];   // bucket <  hi
    component actLt[MAXSEG];  // j < segCount
    signal inSeg[MAXSEG];
    signal active[MAXSEG];
    signal segActive[MAXSEG];
    signal contrib[MAXSEG];
    signal acc[MAXSEG + 1];
    acc[0] <== 0;

    for (var j = 0; j < MAXSEG; j++) {
        geLo[j] = LessThan(NBITS);
        geLo[j].in[0] <== bucket;
        geLo[j].in[1] <== prevHi[j];
        // ge = 1 - (bucket < prevHi)
        ltHi[j] = LessThan(NBITS);
        ltHi[j].in[0] <== bucket;
        ltHi[j].in[1] <== hi[j];
        actLt[j] = LessThan(NBITS);
        actLt[j].in[0] <== j;
        actLt[j].in[1] <== segCount;
        active[j] <== actLt[j].out;
        // inSeg = (1 - geLo.out_of_lt) * ltHi ; note geLo.out is (bucket<prevHi)
        inSeg[j] <== (1 - geLo[j].out) * ltHi[j].out;
        segActive[j] <== inSeg[j] * active[j];
        contrib[j] <== segActive[j] * mult[j];
        acc[j + 1] <== acc[j] + contrib[j];
        prevHi[j + 1] <== hi[j];
    }
    matched <== acc[MAXSEG];
}

component main {public [bucket, segCount, hi, mult]} = TableLookup(64, 20);

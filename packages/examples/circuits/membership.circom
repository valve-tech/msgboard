pragma circom 2.1.0;

// Semaphore-style group-membership circuit, ported for the msgboard zk-filtered
// archive demo. It proves:
//
//   "I know the secret behind ONE of the identity commitments in the group whose
//    Merkle root is `root`, I have bound this proof to exactly this message
//    (`signalHash`) and this epoch (`externalNullifier`), and here is the
//    `nullifierHash` that lets you rate-limit me WITHOUT learning which member I am."
//
// This is a compact re-implementation of the Semaphore v2 membership circuit
// (https://semaphore.pse.dev). It is deliberately small and self-contained so the
// example can compile it with circom + a DEV/TEST-ONLY trusted setup. A real
// deployment should use the audited Semaphore circuits + a genuine ceremony.

include "poseidon.circom";
include "mux1.circom";

// Recomputes a Poseidon Merkle root from a leaf and its authentication path.
// pathIndices[i] == 0 => our node is the LEFT input at level i, sibling is right.
// pathIndices[i] == 1 => our node is the RIGHT input at level i, sibling is left.
template MerkleTreeInclusionProof(nLevels) {
    signal input leaf;
    signal input pathIndices[nLevels];
    signal input siblings[nLevels];
    signal output root;

    component hashers[nLevels];
    component mux[nLevels];

    signal levelHashes[nLevels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < nLevels; i++) {
        // pathIndices must be boolean.
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== levelHashes[i];
        mux[i].c[0][1] <== siblings[i];
        mux[i].c[1][0] <== siblings[i];
        mux[i].c[1][1] <== levelHashes[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        levelHashes[i + 1] <== hashers[i].out;
    }

    root <== levelHashes[nLevels];
}

template MembershipProof(nLevels) {
    // --- private witness ---
    signal input identityNullifier;   // secret; also seeds the nullifier
    signal input identityTrapdoor;    // secret
    signal input pathIndices[nLevels];
    signal input siblings[nLevels];

    // --- public inputs ---
    signal input externalNullifier;   // epoch / category scope (one post per epoch)
    signal input signalHash;          // hash of the message payload; binds the proof

    // --- public outputs ---
    signal output root;               // the group's Merkle root
    signal output nullifierHash;      // Poseidon(externalNullifier, identityNullifier)

    // identity commitment = Poseidon(Poseidon(nullifier, trapdoor)), Semaphore v2 style.
    component secret = Poseidon(2);
    secret.inputs[0] <== identityNullifier;
    secret.inputs[1] <== identityTrapdoor;

    component commitment = Poseidon(1);
    commitment.inputs[0] <== secret.out;

    // Prove the commitment is in the tree; expose the recomputed root.
    component tree = MerkleTreeInclusionProof(nLevels);
    tree.leaf <== commitment.out;
    for (var i = 0; i < nLevels; i++) {
        tree.pathIndices[i] <== pathIndices[i];
        tree.siblings[i] <== siblings[i];
    }
    root <== tree.root;

    // Nullifier is deterministic in (epoch, identity) so the archive can reject a
    // second post from the same member in the same epoch — without deanonymising.
    component nullifier = Poseidon(2);
    nullifier.inputs[0] <== externalNullifier;
    nullifier.inputs[1] <== identityNullifier;
    nullifierHash <== nullifier.out;

    // Bind signalHash into the constraint system (Semaphore's trick) so a valid
    // proof cannot be lifted onto a different message. The squaring forces the
    // signal to be a real constrained input rather than a free public wire.
    signal signalHashSquared;
    signalHashSquared <== signalHash * signalHash;
}

// Public signal order (what snarkjs returns): [root, nullifierHash, externalNullifier, signalHash]
component main {public [externalNullifier, signalHash]} = MembershipProof(10);

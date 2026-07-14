# zk-msgboard — a zk-filtered archive over MsgBoard

A design note for the `zk-msgboard` example (`packages/examples/src/zk-msgboard.ts`). It
ports the [zk-message-board](https://github.com/nulven/zk-message-board) concept — a
Semaphore-style board where you prove **group membership** to post, without revealing which
member you are — onto MsgBoard, and turns the "who may post" gate into a **provably-gated
archive**: only messages carrying a valid membership proof (for the known group, with an
unused nullifier) make it through the filter.

## What it proves

Each post carries a Groth16 proof of the statement:

> "I know the two secrets behind **one** of the identity commitments in the group whose
> Merkle root is `root`; I have bound this proof to exactly this message (`signalHash`) and
> this epoch (`externalNullifier`); and here is the `nullifierHash` that lets you rate-limit
> me **without** learning which member I am."

- **Membership** is a Poseidon Merkle inclusion proof over a committed set of identity
  commitments (`identityCommitment = Poseidon(Poseidon(nullifier, trapdoor))`, Semaphore v2).
- **Anonymity** comes from never revealing the leaf or its index — only the root is public.
- **The nullifier** `Poseidon(externalNullifier, identityNullifier)` is deterministic in
  (epoch, identity), so the archive rejects a second post from the same member in the same
  epoch — a rate limit that does not deanonymise.
- **Message binding**: `signalHash = keccak256(payload) mod p` is a public input squared into
  the constraint system (Semaphore's trick), so a valid proof cannot be lifted onto different
  content.

Public signals (circuit output order): `[root, nullifierHash, externalNullifier, signalHash]`.

## The four filter gates

`makeZkArchive({ root, verificationKey })` admits a candidate only if **all** hold:

1. **Signal binding** — `signalHash` matches `keccak256(payload)` of the carried message.
2. **Membership** — the proof's `root` equals the group root the archive recognizes.
3. **Proof validity** — `snarkjs.groth16.verify(vkey, publicSignals, proof)` is true (real,
   not stubbed).
4. **Freshness** — the `nullifierHash` has not been admitted before (optionally scoped to an
   `externalNullifier` epoch).

Everything else is filtered out. The surviving set is the zk archive.

## How it maps onto the repo

- **Post** is the `@msgboard/sdk` write flow (`status → doPoW → addMessage`) with the proof
  encoded in `data`.
- **Watch** is a `@msgboard/relayer` `Relayer` whose **sink** is the verifier. The sink runs
  for every candidate in `observe` mode and performs no on-chain action, so the watcher is a
  safe, read-only filter — the same shape as the `moderation-flagger` and `archivist`
  examples, but the filter predicate is a SNARK verification instead of a word blocklist.

## Trusted setup: DEV/TEST-ONLY

`scripts/build-zk.ts` compiles the circuit with `circom` and runs the Groth16 setup with a
fixed **public** beacon (`snarkjs powersoftau beacon` + `snarkjs zkey beacon`, **not**
`contribute`). Using a beacon rather than `contribute` makes the whole setup **reproducible**
— anyone re-running the script gets the same `verification_key.json` — but it also means the
"toxic waste" is public knowledge, so **these keys are forgeable**. This is fine for a demo
and for deterministic tests; it is **not** secure for production.

## Deliberately deferred (honest limitations)

These are out of scope for the example and would be needed for a real deployment:

1. **A genuine trusted-setup ceremony.** The DEV beacon must be replaced by a real multi-party
   Powers-of-Tau + phase-2 ceremony (or by adopting Semaphore's existing trusted artifacts).
2. **The audited Semaphore circuits.** `membership.circom` is a compact re-implementation for
   legibility. Production should use the audited `@semaphore-protocol` circuits/contracts.
3. **On-chain verification.** `snarkjs zkey export solidityverifier` can emit a Solidity
   verifier so a contract (or the MsgBoard node itself) could gate on the proof. The example
   verifies off-chain in the watcher only; the exported verifier is not wired up here.
4. **Dynamic group / Merkle-root updates.** The group is a fixed committed set. A real system
   needs on-chain identity registration and a rolling root (with proofs valid against any
   recent root), as Semaphore does. Here the recognized root is configured
   (`ZK_GROUP_ROOT`) and static.
5. **Nullifier persistence.** Nullifier tracking is in-memory (`Set`), lost on restart. A real
   archive would persist nullifiers (e.g. the relayer's `postgresStore`) so the rate limit
   survives restarts and scales horizontally.
6. **Epoch rotation policy.** `externalNullifier` is derived from the category string; a real
   deployment would rotate it per time-window to define the "one post per epoch" cadence.

Nothing above is faked in the example: the proofs are real, the verification is real, and the
committed fixtures are genuine proofs from the deterministic setup. The items here are simply
not built — they are the gap between a runnable pattern and a production system.

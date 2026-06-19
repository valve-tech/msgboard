# ZK for Game Randomness — Feasibility Study + Deferred-Effort Scope

Status: decision record · 2026-06-18
Context: the goal was to make CoinFlip + Raffle randomness **cheaper / fewer on-chain steps**, with the hope of using ZK. This records the feasibility finding (why ZK is not the near-term lever) and scopes the full ZK effort for if/when it is pursued.

## 1. The question

CoinFlip and Raffle today draw randomness from the **on-chain validator commit-reveal** (the gibsfinance/random validator apparatus: declare a subset, ink secrets, heat/cast/reveal). That coordination is several on-chain steps per game, for very little entropy actually consumed — CoinFlip uses **1 bit** (parity of a 256-bit validator seed; `// the game inks nothing and contributes nothing to the seed; players hold no entropy`), Raffle uses **8 bits** (`draw = 1 + uint256(seed) % 256`). Could ZK cut the on-chain steps?

## 2. Verdict

**No — ZK is not the lever for cheaper randomness here, and is the wrong tool for the step-count goal.** It is a large, from-scratch ZK build on a stack whose own first ZK use isn't live, with unresolved provenance/license/audit blockers. The same "fewer on-chain steps" goal is reached without ZK (§4). ZK remains a legitimate **later privacy/showcase** upgrade (§5), behind hard preconditions (§6).

## 3. Evidence (what's actually in the repo)

1. **No RNG circuit; no circuit-authoring toolchain.** The only ZK assets are the **vendored Zypher uzkge card-shuffle verifiers** (`contracts/zk/ShuffleVerifier52.sol`, `vendor/uzkge/...`) + `EdOnBN254.sol`. No circom / noir / halo2 / snarkjs / gnark / poseidon anywhere in `examples/games` or `packages/contracts`. uzkge's shuffle is a fixed, specialized argument — not a general constraint system. An RNG-validity circuit would be authored from scratch in a toolchain that does not exist in this repo yet.
2. **Writing circuits was an explicit non-goal.** `2026-06-11-zk-card-games-design.md` lists as a non-goal: *"Writing our own shuffle circuits. The spike picks an existing audited-ish stack."* An RNG circuit is exactly that avoided work.
3. **The RNG is keccak-based — SNARK-hostile.** `msgboard-games/src/rng.ts`: seed chain `seed[i]=keccak256(seed[i+1])`, reveal check `keccak256(revealed)===priorLink`, draw `uint256(keccak256(abi.encode(serverSeed, clientSeed, nonce)))`. Keccak is ~150k+ constraints/hash in a SNARK. A real circuit would force migrating the fairness math to a ZK-friendly hash (Poseidon) — a breaking change across on-chain + off-chain code.
4. **Even the card SNARK isn't live.** `@gibs/zk-cards-core`'s v0 provider is `AttestedElGamalDeck` — the shuffle is **attested by a signature, not proven in ZK**; the WASM SNARK is still a pending spike. The ZK proving pipeline isn't running even for its intended use.
5. **Pre-mainnet blockers (`vendor/VENDOR.md`):** regenerate the KZG SRS from a *public* ceremony (current provenance is uzkge's own gen-params), clarify the upstream GPL-3.0-vs-MIT license contradiction, and obtain an audit (none exists). The pinned uzkge commit is a *consensus constant* — prover wasm and verifier must match exactly.

## 4. What achieves "cheaper / fewer on-chain steps" WITHOUT ZK

- **CoinFlip → 2-party commit-reveal.** The two opposed players are their own entropy source; retire the validator heat/cast/reveal coordination. Same "one honest participant" safety, a couple of txs, no proving, shippable now. (See `2026-06-18-coinflip-commit-reveal-design.md`.)
- **Batching → the escrowed settlement rails.** The Dice slice's off-chain play + on-chain `HouseChannel` settle is the "play many rounds, touch the chain once" win already. CoinFlip/Raffle reframed as session-style games settle in one/two txs with zero ZK.

These two cover the goal. ZK adds nothing to the *step count* that these don't.

## 5. Where ZK still legitimately fits (deferred)

ZK's unique, non-replicable value is **privacy** + **unilateral settle** — spec §6.3's "RNG batch-validity proof": one circuit proving *from a committed opening, N rounds — each a fair draw `f(serverSeed, clientSeed, nonce)` against the pre-committed chain head — net to delta D*, with three selectable modes: (1) publish only the net delta (privacy), (2) settle the true result without the counterparty's signature/reveal (unilateral), (3) attest the whole session obeyed the committed chain. This is a **showcase/privacy** upgrade on top of the settlement rails — not a step-count optimization.

## 6. Scope of the full ZK effort (if pursued)

A realistic decomposition, in dependency order. This is a **major multi-week workstream**, sequenced after the settlement rails exist:

1. **Hash migration.** Replace keccak with a ZK-friendly hash (Poseidon over BN254) in the RNG (`rng.ts`) and any on-chain consumer, keeping a keccak↔poseidon compatibility plan for the already-deployed games. Re-verify all fairness math + tests. *(Breaking; touches every game's RNG.)*
2. **Proving-stack selection spike (time-boxed).** Pick a circuit DSL + prover with a universal KZG/BN254 setup that can share or cleanly add to the uzkge SRS (candidates: halo2/PSE, gnark-plonk, circom+snarkjs+plonk). Criteria: browser/WASM proving time for one RNG round, audit posture, license, on-chain verifier gas. Record the decision like the card-SDK addendum.
3. **RNG-validity circuit.** Implement the §6.3 statement: Poseidon seed-chain consistency, per-round draw recomputation, balance conservation → net delta `D`, with the three public-input configurations. Constrain N (rounds per proof) to bound proving time.
4. **Verifier contract + verifier key.** Generate the verifier key from the chosen stack's params; deploy the verifier; wire it into a `HouseChannel.settleWithProof(...)` path alongside the signature-based `settle`.
5. **SRS ceremony + license + audit.** Regenerate the KZG SRS from a public ceremony (shared with the card games, done once), resolve the uzkge license, and budget an audit. **Hard pre-mainnet gate.**
6. **Game reframing.** Move CoinFlip/Raffle (and the session games) onto the proof-settled path; retire validator entropy for them.

## 7. Recommendation

Take the cheaper-steps win from §4 (commit-reveal + settlement rails). Keep ZK as the **deferred §6.3 privacy/showcase upgrade**, gated on §6's hash migration, stack spike, SRS ceremony, license, and audit. The escrowed settlement rails (Dice slice) are the correct foundation either way — proof-settled batching attaches to the *same* `HouseChannel`.

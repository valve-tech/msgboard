# Spec addendum: SNARK shuffle stack selection (SDK spike outcome)

Date: 2026-06-12
Status: SIGNED OFF 2026-06-12. Both items approved by the user the same day:
(1) the shuffle-budget amendment (≤ 5 s → ≤ 12 s, absorbed at hand boundaries)
now binds — the parent spec is amended; (2) GPL-3.0 posture accepted ("we are
not making any money off of this") — shipping GPL-compatible is fine for the
venue as it stands. The upstream license-contradiction clarification stays a
pre-mainnet item, and the GPL posture must be revisited if the platform ever
monetizes.
Companion to `2026-06-11-zk-card-games-design.md` (resolves its "Spike outcome"
open item). All numbers
measured on Apple M1 / macOS 26.5.1 / Node v24.15.0, WASM in Node as the
browser proxy (same V8; browsers will be equal or slightly slower), gas on a
local anvil with solc 0.8.24, shanghai, optimizer 200 runs. Benchmark code and
exact commands: `~/Documents/gibs-finance/spike-zk-shuffle/` (see its README).

## Decision

**Adopt Zypher's zshuffle (zypher-game/uzkge) as the SNARK provider behind
`MaskedDeckProvider`, built from a pinned uzkge commit (prover wasm and
Solidity verifiers from the same commit — this is mandatory, see Risks).**
Manta/Poseidon zkShuffle is disqualified. Geometry's Barnett–Smart remains the
fallback, repriced below — its prover is two orders of magnitude faster than
either SNARK stack but it has no EVM verifier, which is exactly the part we
ruled out building ourselves.

One budget is missed and the spec should be amended rather than pretending
otherwise: 52-card shuffle proving measured **10.3 s** against the ≤ 5 s
budget. No stack with a working EVM verifier gets under 5 s in browser-class
WASM today. The per-card reveal budget (≤ 100 ms) is met with 40x headroom
(2.6 ms). Details and the proposed amendment under "Budgets".

## Comparison table

| Criterion | Zypher zshuffle (uzkge) | Manta/Poseidon zkShuffle | Geometry mental-poker (fallback) |
|---|---|---|---|
| Proof system | TurboPlonk-style shuffle argument, KZG/BN254; Groth16 for snark-reveal | Groth16 over circom circuits, BN254 (Baby Jubjub inside) | Bayer–Groth shuffle argument (sigma protocol, no SNARK), arkworks |
| License | Rust+wasm source GPL-3.0-only; npm wasm mislabeled MIT; `uzkge-contracts` npm GPL-3.0-only; Solidity headers say `UNLICENSED` (contradiction — open item) | Repo has **no LICENSE file**; package.json files claim MIT; verifier contracts GPL-3.0 (snarkjs-generated) | Dual MIT/Apache-2.0, clean |
| Audit | None found (searched docs, repo, web) | None found; docs label it **Alpha** | None; research code by Geometry (Nicolas Mohnblatt et al.) |
| Last real commit | Jan 2025 (uzkge); pushed Feb 2025 | Oct 2023 (substantive: Jun 2023) | Feb 2023 (one stray commit Jan 2025) |
| npm publishes | zshuffle wasm Apr 2024 (stale vs repo — **incompatible with HEAD contracts, proven**); uzkge-contracts Oct 2024 | Jul 2023 (`@zk-shuffle/*` 1.0.1) | n/a (Rust, git deps via ssh URLs — already a papercut) |
| Bus factor | 2–3 (sunhuachuang, confuseSUN, +1 drive-by) | 4, all inactive since 2023 | inactive |
| Shuffle prove, 52 cards (measured) | **10.30 s** mean (n=5, HEAD wasm; 11.11 s on npm 0.0.7) | **14.55 s** mean (n=3, snarkjs) | **51 ms** native Rust (n=5; not wasm — expect ~2–4x in wasm) |
| Per-card reveal prove (measured) | **2.6 ms** (CP-DL); 1.19 s for optional Groth16 snark-reveal | **260 ms** (groth16 decrypt) — misses 100 ms budget | **0.25 ms** |
| Shuffle verify off-chain (measured) | 105 ms (wasm) | 12 ms (snarkjs) | 22.5 ms (native) |
| Shuffle verify gas (measured, anvil) | **1,569,952** (calldata-shaped harness; 2,091,380 via their storage-based ShuffleService demo) | **1,616,373** inner (1,734,841 tx) | No EVM verifier exists. Building one = the work we scoped out |
| Reveal verify gas (measured) | CP-DL: **15,596,992** (pure-Solidity EdOnBN254 — dispute-path poison); Groth16 snark-reveal: **225,157** inner | **239,100** inner (272,572 tx) | n/a |
| Verifier deploy gas | 2×3.61 M (VK extras) + 3.13 M (verifier) + 1.20 M (reveal) ≈ 11.6 M total | 4.75 M + 0.50 M | n/a |
| Browser payload | wasm ~9.6 MB unpacked (npm); SRS embedded | encrypt.zkey **173.5 MB** + 1.2 MB wasm, fetched from a third-party S3 bucket that could vanish | n/a |
| Trusted setup | Universal KZG SRS shipped in repo; **provenance undocumented** (points to author's `export-setup-parameters` repo, no ceremony attribution) | Circuit-specific Groth16 zkey of **unknown provenance** on S3 — if toxic waste was kept, shuffle proofs are forgeable (deck-stacking) | **None** (transparent; Pedersen CRS only) — best-in-class here |
| PulseChain (943) compatibility | Needs only precompiles 0x05/0x06/0x07/0x08; no 0x0A, no blob/Cancun anything. Confirmed live on PulseChain mainnet: ecAdd/ecMul/ecPairing answer correctly, PUSH0 executes, 0x0A absent, block gas limit 45 M | Same precompile profile (0x06/07/08), same result | n/a on-chain |
| Seam fit | Near 1:1 (see Integration) | SDK is welded to its ShuffleManager game contract (joinGame/checkTurn/draw by gameId) — exactly the impedance mismatch we feared; only the low-level `@zk-shuffle/proof` is salvageable | API shape matches the seam well, but Rust-only and no EVM story |

## Measured numbers, with provenance

Zypher, wasm built from uzkge HEAD (`wasm-pack build shuffle/wasm --release
--target nodejs`), `node bench-zypher-head.js`:

- keygen 8.7 ms; aggregate 1.5 ms; initial 52-card masked deck 42 ms.
- One-time warmup (once per session, can overlap matchmaking): prover key
  10.6 s + reveal key 1.0 s + per-joint-key refresh 4.1 s ≈ **15.7 s before
  the first shuffle**. This is on top of the per-shuffle cost and must be
  hidden in the lobby/matchmaking UX.
- Shuffle prove: mean 10,297 ms, median 10,282, min 10,256, max 10,386 (n=5).
  Proof: 1,632 bytes. Off-chain wasm verify: 105 ms.
- Reveal (CP-DL share proof): mean 2.6 ms/card (n=52); verify 3.2 ms.
  Optional Groth16 snark-reveal: 1,191 ms (only needed to make a reveal cheap
  to verify on-chain in a dispute).
- Gas (anvil, our own HEAD-wasm proof verified end-to-end, not a canned
  vector): shuffle verify **1,569,952** via a calldata-shaped harness
  (`gas-zypher/src/Harness.sol`); Zypher's own ShuffleService demo pattern
  costs 2,091,380 for verify plus 4,763,925 to stage the deck in storage —
  our ZkTable must pass decks as calldata, not copy their demo.
  Reveal verify: CP-DL 15,596,992; Groth16 225,157 (event-metered exact
  inner-call gas, `GasMeter.sol`).

Manta, `node bench-manta.js` (snarkjs 0.7.x, artifacts from
`p0x-labs.s3.amazonaws.com/zkShuffle/`):

- Shuffle prove: mean 14,553 ms (n=3). Decrypt (reveal) prove: 260 ms/card
  (n=10). Off-chain verify 12 ms.
- Gas: shuffle_encrypt verify 1,616,373; decrypt verify 239,100 (both exact
  inner-call, our own proofs).
- encrypt.zkey is 173.5 MB. Every player downloads it before their first
  shuffle, from an S3 bucket controlled by a team that stopped shipping in
  2023.

Geometry, `cargo run --release --example bench52` (added to the clone;
**native arm64, not wasm** — the one number here that is not a browser proxy):

- Shuffle prove 51 ms, verify 22.5 ms; reveal 0.25 ms, verify 0.32 ms.
  Even at a pessimistic 4x wasm penalty: ~0.2 s shuffle — 25x under budget.

PulseChain probes (live RPC `https://rpc.pulsechain.com`, `cast call`):
ecAdd(G,G) and ecMul(G,2) return the correct point; ecPairing(empty) returns
1; precompile 0x0A returns empty (absent, as expected pre-Cancun); a
PUSH0-containing initcode executes (Shanghai confirmed); block gas limit
45,000,000. Nothing in either candidate's verifiers needs anything beyond
BN254 precompiles + modexp, all present.

## Budgets: one pass, one miss, amend the spec

- Reveal ≤ 100 ms: **pass** with Zypher (2.6 ms). Manta fails (260 ms).
- Shuffle ≤ 5 s: **no stack with an EVM verifier passes.** Zypher 10.3 s,
  Manta 14.6 s. The only sub-5 s prover is Geometry's non-SNARK Bayer–Groth
  (~51 ms native), which has no on-chain verifier — and the spec explicitly
  scopes out writing our own circuits/verifiers.

Proposed amendment: raise the v1 shuffle-proving budget to ≤ 12 s on an
M1-class machine, and absorb it in UX: shuffling happens once per hand per
player, the proof can be computed while the opponent acts (pipelined), and
the warmup runs during matchmaking. The 5 s number was a guess; 10.3 s with a
progress bar at hand boundaries is a pacing cost, not a fairness cost — delay
lands in the dispute clock per the spec's own framing. If sub-second shuffles
later become a product requirement, that is the Geometry escalation path
(priced below), not a reason to pick a dead stack today.

## Why not Manta (disqualified)

Slower than Zypher on the axis that matters (14.6 s), fails the reveal budget
outright (260 ms vs 100 ms), 173.5 MB proving key per browser, repo dead for
~3 years with no LICENSE file, docs label it Alpha, unaudited, and the
Groth16 zkey has unknown provenance — a retained toxic waste would let anyone
forge shuffle proofs and stack the deck. Its TS SDK also assumes ownership of
the on-chain game via ShuffleManager, fighting our ZkTable design; we would
bypass the SDK and use only `@zk-shuffle/proof`, inheriting all of the above
for none of the convenience. No single disqualifier is necessary; there are
five sufficient ones.

## Risks (Zypher) and mitigations

1. **Version skew is real and silent.** Proofs from the npm wasm (0.0.7,
   Apr 2024) are rejected by HEAD contracts — we proved this on anvil, both
   directions of the Sep 2024 "ECC selector" change. Mitigation: vendor
   nothing from npm; build wasm and contracts from one pinned uzkge commit
   (HEAD `dfd0231`-era works end-to-end, demonstrated). Treat the pin as a
   consensus constant of the deployment.
2. **GPL-3.0 and a license contradiction.** The Rust/wasm source is
   GPL-3.0-only while the npm package claims MIT and the Solidity headers say
   `UNLICENSED`. Assume GPL-3.0 governs everything we ship (browser wasm +
   deployed verifiers). If the games platform cannot be GPL-compatible, ask
   Zypher for clarification/dual-license before launch. Open legal item.
3. **Unaudited, thin maintenance.** No published audit; 2–3 contributors;
   last substantive commit Jan 2025. The spec already names SDK circuit
   correctness the irreducible residue of trust; budget for a focused
   third-party review of the shuffle circuit + verifier before real money.
4. **SRS provenance undocumented.** The KZG SRS ships as binary blobs with a
   pointer to the author's exporter repo and no ceremony attribution. A
   rigged SRS forges shuffle proofs. Before mainnet: regenerate the SRS from
   a public ceremony transcript (e.g. Perpetual Powers of Tau for BN254),
   re-derive the verifier keys with uzkge's own `gen-params` tooling, and
   check the committed VK constants match. This is tooling work, not circuit
   work, and uzkge has the commands for it.
5. **CP reveal is unverifiable on-chain in practice** (15.6 M gas). Disputes
   about a reveal must use the Groth16 snark-reveal (225 k gas, 1.19 s to
   prove — acceptable since it is only produced when disputing). Normal play
   verifies CP reveals off-chain at 3.2 ms. The dispute contract should
   accept only the snark-reveal form.
6. **Warmup is 15.7 s.** Run keygen/prover-key/joint-key refresh during
   matchmaking; never on the hot path.

## Fallback plan (priced)

Geometry Barnett–Smart (dual MIT/Apache, transparent setup, 51 ms native
prove) becomes the plan if (a) Zypher's license question resolves badly, or
(b) sub-second shuffle becomes a requirement. The price: re-instantiate the
protocol over BN254/Baby-Jubjub (it is generic arkworks code; the example
uses the Starknet curve), compile to wasm, and — the big one — implement a
Bayer–Groth verifier in Solidity, which nobody ships today and which the spec
currently scopes out. Estimate: the verifier is O(n) BN254 precompile work
(plausibly 3–8 M gas at 52 cards) and multiple person-weeks of novel,
audit-mandatory cryptographic Solidity. Also note its git dependencies use
ssh URLs and the repo is dormant; we would be adopting the code, not the
project. This is a deliberate, larger investment — not a drop-in.

## Integration: Zypher behind `MaskedDeckProvider`

Per method (zshuffle wasm API, `zshuffle_wasm.d.ts`):

- `keygen()` → `generate_key()` (returns `sk`, compressed `pk`, `pkxy`).
  Adapter: hex passthrough. Trivial.
- `aggregate(pubs)` → `aggregate_keys(pubs)` plus a one-time
  `refresh_joint_key(joint, 52)` whose 24-element `pkc` output must be cached
  by the adapter and (in disputes) registered with the verifier contract —
  this is the one piece of state our seam doesn't model; store it alongside
  the table's channel state.
- `initialDeck(agg)` → `init_masked_cards(agg, 52)`; each card is 4
  field elements (c1.x, c1.y, c2.x, c2.y) mapping directly onto
  `WireMasked{c1,c2}` as two uncompressed EdOnBN254 points (adapter packs
  2×32 bytes per point into the hex wire type).
- `shuffle(agg, deck, signer)` → `shuffle_cards(agg, deck)`; proof is the
  1,632-byte plonk proof, carried opaque in `WireShuffle.proof`. The
  `signer` parameter becomes vestigial — the proof replaces the attestation.
  Keep signing the resulting channel state (unchanged), drop the
  deck-attestation signature.
- `verifyShuffle(agg, before, after, signerAddr)` →
  `verify_shuffled_cards(before, after.deck, after.proof)` (105 ms off-chain).
  `signerAddr` ignored. On-chain dispute twin: `verifyShuffle(proof, pi, pkc)`
  with `pi = flatten(before) ++ flatten(after)` (416 words), 1.57 M gas.
- `share(secret, card, ctx)` → `reveal_card(sk, card)`. Impedance note: the
  CP proof binds to the specific card ciphertext and key, not to our `ctx`
  string. Replay of a share for the *same* ciphertext in another slot is the
  only theoretical reuse, and slots hold distinct ciphertexts after shuffling,
  so binding via ciphertext is sufficient; the adapter keeps `ctx` in the
  transcript layer (already hash-chained) rather than inside the proof.
  Document this in the provider.
- `verifyShare(pub, card, s, ctx)` → `verify_revealed_card(pk, card, reveal)`
  (3.2 ms). Dispute twin: `RevealVerifier.verifyRevealWithSnark` (225 k gas)
  after the accused party produces `reveal_card_with_snark` (1.19 s).
- `unmask(card, shares)` → `decode_point(card, reveals)` (1.5 ms).

Adapter size: one file, mostly hex/point (de)serialization; no protocol
logic. The wasm is loaded once and the three init calls run during
matchmaking. ZkTable owns the game; from uzkge we deploy only
`VerifierKeyExtra1_52`, `VerifierKeyExtra2_52`, a thin verifier wrapper
(calldata-shaped, like the spike's `Harness.sol`, not their storage-based
ShuffleService), and `RevealVerifier` — ~11.6 M gas of one-time deploys,
comfortably under PulseChain's 45 M block limit.

## What was not done

No browser-tab measurement (Node WASM proxy only — same engine, but no
real-DOM contention; numbers could drift ±20%). No multi-shuffle pipelining
prototype. No legal opinion on the GPL question. No contact with the Zypher
team about the npm/source license contradiction or the SRS provenance — both
are pre-mainnet blockers and should become tracked work items in the spec.

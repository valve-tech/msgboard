# @msgboard/zk-table-settle

The **generic, table-driven ZK settle**: **ONE** Noir circuit + **ONE** UltraHonk
verifier for the whole pure-RNG game family (dice, limbo, roulette, wheel, keno,
plinko, monte, …) instead of one generated circuit/verifier per game
(`@msgboard/zk-settle` generates a separate `diceSettleOnchain`, `limboSettle`, …
each with its own ~50 KiB verifier).

The payout is a **piecewise-constant paytable**: a round produces one reduced draw
`bucket = r % outcomeSpace`, and the multiplier is a step function of that bucket,
encoded as an ascending list of `(hi, multX100)` segments. Every pure-RNG game is
an instance of that table:

| game       | outcomeSpace | segments |
| ---------- | ------------ | -------- |
| dice@t     | 10 000       | `[(t, winMult), (10000, 0)]` |
| limbo@t    | 1 000 000    | `[(uWin, 0), (1e6, targetMult)]` |
| roulette   | 37           | 37 unit slots, one `multX100` each (straight-up / color / …) |
| wheel/keno | N            | N buckets |

so a **single deployed verifier settles all of them**. (`dicex2`'s two sub-rolls
need the sub-random extension; the paytable shape is compatible, out of scope v1.)

## The keccak / paramsHash trick

The paytable is **not** hashed in-circuit. On-chain, `HouseChannel.settleWithProof`
already binds the round params to the house-signed `paramsHash` with a cheap EVM
`keccak256(params) == t.paramsHash` and **decodes params into the verifier's public
inputs**. So the paytable `(outcomeSpace, hi[], mult[])` rides as **public inputs**,
exactly the way `targetX100` does in the per-game dice circuit. The only in-circuit
keccaks are the same three the dice circuit already pays: `keccak256(serverSeed)`,
`keccak256(clientSeed)`, and the 96-byte `r`-derivation. Seeds stay **private**
(mode-2 seed privacy — the whole value over `settleWithSeeds`).

## Stack decision — Noir + bb.js UltraHonk (measured, not speculated)

Two proving stacks are in this repo: Noir/UltraHonk (`zk-settle`) and
circom/snarkjs-PLONK (`zk-skill`). The user asked: *"can noir use plonk? what
kinds of constraints are we subject to?"* Answer: Noir targets UltraHonk (a
different IOP than snarkjs-PLONK); the operative constraint is that this settle
statement needs **(a) 3 in-circuit keccaks for seed privacy** and **(b) a large
public-input vector (the paytable)** — and circom/PLONK fails both.

Measured on this machine (Node 24, bb.js 4.3.1, circom 2.2.3, snarkjs 0.7.6):

| metric | Noir/UltraHonk (this pkg) | circom/PLONK (measured spike) |
| --- | --- | --- |
| circuit domain | **2^16 = 65 536** (LOG_N 16) — same as per-game dice | lookup-only: 8 643 PLONK constraints (2^14) |
| in-circuit keccak (3×) | absorbed, fits in 2^16 | **~450 000** constraints (≈151k/permutation) → 2^19–2^20 domain, needs ptau power ≥19 (on-disk is 16) |
| public inputs | 197 (paytable inline) | 130 (lookup-only) |
| prove+verify (Node, 1 thread) | **~4.1 s** / round | n/a (blocked by proving-key size below) |
| proving key | universal SRS, no per-public-input blowup | **365 MB** for the *keccak-free* 130-pub lookup alone (per-public-input Lagrange sections — see `sudoku.circom`) |
| Solidity verifier source | **102 KiB** (constant in public-input count: 197 pubs == same size as 68-pub dice) | **254 KiB** for 130 pubs (35 KiB @ 4 pubs, 47 KiB @ 11 pubs — grows with public inputs) |
| verifier bytecode | ~50 KiB — **over EIP-170**, same as the existing per-game verifier | far over EIP-170 at 130 pubs |

**Why circom/PLONK loses despite its small-verifier reputation:** its verifier is
small *only* with few public inputs and no in-circuit keccak. This statement forces
both — the seed-privacy keccaks are ~450k constraints (power-19+ ptau, minute-scale
proving) and the public paytable is 130+ inputs (365 MB proving key, 254 KiB
verifier). UltraHonk absorbs the keccaks into a 2^16 domain and its verifier is
~constant in public-input count. **The only cost of UltraHonk is the >EIP-170
verifier bytecode — but that is the *same* constraint the existing per-game dice
verifier already lives under, and this package turns N such verifiers into ONE.**
Mainnet path is L2 or the verifier-split the existing on-chain dice circuit uses;
`zk-skill`'s deployed PLONK verifiers prove EIP-170 deployability is possible, but
not for a keccak+large-public-input statement.

## Contents

- `test-circuits/tableSettleOnchain/` — the generic Noir circuit.
- `src/paytable.ts` — `RangeTable` model, `diceTable`/`roulette*Table` builders,
  `encodeTableParams`/`paramsHashOfTable` (the `abi.encode(outcomeSpace, hi[],
  mult[])` binding a future table-aware `settleWithProof` decodes).
- `src/tableSettle.ts` — witness/publics/InputMap builder (mirrors
  `zk-settle`'s `diceSettleOnchain.ts` API shape).
- `src/{compile,prove,verify}.ts` — the noir_wasm + bb.js UltraHonk pipeline.
- `scripts/genOnchainVerifier.ts` — regenerates
  `games/contracts/contracts/zk/generated/TableSettleHonkVerifier.sol` + a Foundry
  fixture. **Not wired into `HouseChannel` — integration is a later phase.**
- `spikes/circom/tableLookup.circom` — the measurement spike behind the table above.

## Test

```
npx vitest run   # 12 tests: paytable model + real UltraHonk proofs for dice & roulette
```

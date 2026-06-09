# Coin Flip — Slice 1: chain-agnostic core + multichain duel (Design Spec)

Date: 2026-06-09
Status: Draft for review
Part of: the coin-flip system (sub-projects: 1 contract ✅, 2 validator/operator nodes, 3 interfaces)
Supersedes for this slice: the single-purpose `duel-943.ts` harness (its logic moves into the core)

## Summary

A chain-agnostic TypeScript core (`@gibs/coinflip-core`) that holds every piece of coin-flip
lifecycle logic — player actions, operator/validator actions, and result reading — so that every
front end (scripts, a React web app, a terminal UI) is a thin shell over the same code. Slice 1
delivers the core plus one front end that proves it: a multichain duel script that runs the full
deploy → ink → match → cast → settle lifecycle on **both local Anvil and PulseChain testnet v4
(943)**, for both roles (players and the operator/validator).

This is the foundation slice. Slices 2–4 (operator/caster node, React web UI, TUI) all import this
core and add nothing to the on-chain logic.

## Goals

- One home for duel logic; no duplication across scripts, web, and TUI.
- Run identically on **Anvil (chain 31337)** and **PulseChain v4 (943)**, selected by one flag.
- Cover both roles: **player** (enter/watch/claim) and **operator/validator** (deploy/ink/cast/recover).
- Enforce the fairness lesson from Phase 1: **fresh, unpredictable entropy per flip** — never a
  reused secret. The seed is a deterministic function of revealed secrets, so reuse repeats outcomes.
- Verifiable by re-running the duel on both chains and watching independent seeds settle the pot.

## Non-goals (this slice)

- The React web UI and the TUI (slices 3–4 — but the core's shape is designed for them).
- A standing always-on validator daemon (slice 2 — here the operator runs inline, as the script does).
- Production wallet-connect UX, ERC-20 stakes, configurable fees.

## Where it lives

A new `examples/` area in the gibsfinance/random repo, holding worked examples of building on the
protocol. Slice 1 adds:

```
examples/coinflip/
  core/                      @gibs/coinflip-core (pnpm package; viem)
    src/
      chains.ts              chain registry: anvil (31337) + pulsechainV4 (943), addresses, accounts
      contracts.ts           Random + CoinFlip ABIs (from @gibs/random artifacts) + address resolution
      secrets.ts             fresh-per-flip secret/preimage generation (the fairness primitive)
      player.ts              enterHeads/enterTails, watchFlip, readResult, claim
      operator.ts            ensureDeployed, inkPool (fresh), heat-via-match, cast, claim, refundStale
      reader.ts              flip state, seed, parity/winner, rebuild heat selection for verification
      index.ts               public surface
    package.json, tsconfig.json
  scripts/
    duel.ts                  the multichain duel front end: `tsx duel.ts --chain anvil|943`
```

`CoinFlip.sol` stays in `packages/contracts`. The core depends on `@gibs/random` for ABIs/artifacts.
Package manager: **pnpm**, matching `provider` and `my-app`.

## Architecture

### chains.ts — the multichain abstraction

A `ChainProfile` per supported chain, so the rest of the core never branches on chain id:

- `anvil` — chain 31337, RPC `http://127.0.0.1:8545`, accounts = Anvil's deterministic prefunded
  test accounts (operator + two players taken from them; no secrets manager needed). `Random` and
  `CoinFlip` are deployed fresh (see operator.ensureDeployed).
- `pulsechainV4` — chain 943, RPC from env (`RPC_943`, default g4mm4; valve.city override for the
  12-block window), accounts derived from the funded mnemonic (`op read 'op://gibs/randomness/...'`)
  at account index 0 (operator) and 1/2 (players) — the "non-seeds0" wallets. `Random` is the known
  deployed address; `CoinFlip` is deployed-or-cached.

A profile resolves: `publicClient`, a `walletClient` per role, contract addresses, fee strategy
(the explicit gas caps + balance-precheck handling Phase 1 needed on 943), and a player-funding
step (no-op on Anvil where accounts are already rich).

### secrets.ts — fairness primitive

`freshSecret()` returns `{ secret, preimage }` from a crypto-strong random 32 bytes (preimage =
keccak256(secret)). Plus `WALK_AWAY` constants mirroring the contract. The core makes reuse
impossible by construction: callers get a new secret per flip. This is the encoded form of the
Phase 1 lesson.

### player.ts / operator.ts / reader.ts

Pure functions over a resolved chain profile + accounts, mirroring the verified `duel-943.ts`
sequence but split by role:

- operator: `ensureDeployed` (deploy Random+CoinFlip on a fresh chain via hardhat ignition against
  the target network, or reuse known addresses), `inkPool(count)` (fresh validator entropy, price 0,
  duration 12, returns locations+secrets), `cast(key, selections, secrets)`, `claim`, `refundStale`.
- player: `enter(side, stake)` (fresh secret, gas-capped call), `watchFlip(flipId)`, `result`.
- reader: `getFlip`, `getSeed`, `winnerOf` (parity), `rebuildSelection(offset, validatorLocations)`
  via `playerSection` + the `Heated` event — the citation data the UIs will surface.

### scripts/duel.ts — the proving front end

`tsx examples/coinflip/scripts/duel.ts --chain anvil|943 [--stake 0.1] [--validators 3] [--walk-away]`.
Resolves the chain profile, ensures contracts deployed, funds players (943 only), runs P0 heads + P1
tails, casts, prints seed/parity/winner and before/after balances. Same output shape as `duel-943.ts`
but chain-selectable and core-backed.

## Anvil setup

Add a `localhost`/`anvil` network (chain 31337, `http://127.0.0.1:8545`) to `hardhat.config.ts` so
`hardhat ignition deploy --network localhost` provisions `Random` + `CoinFlip` (handling Random's
compiled dependencies) on a running `anvil`. The core reads the resulting `ignition/deployments/
chain-31337/deployed_addresses.json`. On Anvil the shanghai override is harmless (Anvil supports
Cancun); CoinFlip still deploys fine.

## Error handling & recovery

- Carry forward Phase 1's two hard-won fixes in the chain profile: explicit gas caps on player calls
  (the block-gas-limit balance-precheck quirk) and shanghai-targeted CoinFlip bytecode.
- The 12-block cast window: the inline operator casts immediately, as the script does. Slice 2's
  daemon is what serves that window in production; the core exposes `cast`/`claim`/`refundStale` so
  any front end can drive recovery.

## Testing (intent, not just behavior)

- **Anvil integration test** (fast, free, deterministic): full duel deploy→settle; assert the pot
  moved to the parity-selected winner and the seed equals the deterministic function of the revealed
  secrets (verifiability), and that two consecutive duels yield *different* seeds (fairness — the
  regression test for the bug Phase 1 hit).
- **Unit**: `secrets.freshSecret` never repeats; `reader.winnerOf` parity mapping; selection rebuild
  order matches the contract's heat order `[p0, p1, ...validators]`.
- 943 is exercised by a manual `duel.ts --chain 943` run (real funds, not in CI).

## Build order within the slice

1. Scaffold `examples/coinflip/core` (pnpm pkg) + `chains.ts`/`contracts.ts`/`secrets.ts`.
2. Port player/operator/reader logic from `duel-943.ts` into the core.
3. Add the Anvil network + ignition deploy path; write the Anvil integration test.
4. `scripts/duel.ts --chain anvil|943`; verify on Anvil (CI-style) then a live 943 run.

## What this unlocks

Slices 2–4 become thin: the operator daemon wraps `operator.*`; the React app and TUI render
`player.*`/`reader.*` state and call the same functions. No on-chain logic is re-implemented anywhere.
